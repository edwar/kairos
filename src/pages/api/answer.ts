import type { APIRoute } from 'astro';
import { CV_MAX_CHARS, redact } from '../../lib/cv.ts';
import { detectStack } from '../../lib/extract.ts';
import { GroqLimitError, groqJson } from '../../lib/groq.ts';
import { profileFromCv } from '../../lib/match.ts';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SYSTEM = `You help a job candidate answer screening questions from application forms. The candidate will copy and paste your answer, so it must be truthful.

FACTS: the only facts you may use are (a) the CV and (b) statements the candidate made in the conversation ("user" messages that add information). Never invent or inflate employers, titles, dates, numbers, technologies, degrees, certifications or responsibilities. Never claim experience with something neither source supports.

HOW TO ANSWER
1. Write the "answer" in first person, in the same language as the question, natural and concise, ready to paste into a form field. No greeting, no preamble, no markdown, no quotes around it.
2. Respect "max_chars" strictly: the answer must be at most that many characters. Prefer 70-90% of the limit for open questions; be short for simple ones (e.g. "level of education" → one line).
3. Years of experience: use "today" and the dated roles in the CV (use "estimated_total_years_experience" as a reference). If asked about a specific role or technology, count only roles that match it and say how you got there ("desde 2018"), never round up.
4. If the question lists technologies or skills: name the ones the facts support; for the ones they do not support, say so honestly and briefly ("no he trabajado con X") or leave them out when the question does not require each one. Never imply experience with unsupported items.
5. If the latest message gives new facts instead of a question, update your previous answer with them.
6. If the job posting is provided, you may tailor emphasis to it, but only with supported facts.
7. "missing": short items (technologies, skills or data) the question asks about that neither the CV nor the conversation supports, in the question's language. Empty array if none.

Reply ONLY with JSON: {"answer": string, "missing": string[]}`;

const NEGATION = /\bno (?:he|tengo|cuento|domino|conozco|manejo)\b|sin experiencia|aún no|todavía no|not (?:worked|used|have)|haven't|have not|no hands-on|no experience/i;

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  const cv = typeof body?.cv === 'string' ? body.cv.slice(0, CV_MAX_CHARS) : '';
  const question = typeof body?.question === 'string' ? body.question.trim().slice(0, 2000) : '';
  if (cv.length < 200 || !question) return json({ error: 'Faltan el CV o la pregunta' }, 400);
  const maxChars = Math.min(3000, Math.max(50, Math.round(Number(body?.maxChars) || 500)));

  const job = body?.job && typeof body.job === 'object'
    ? {
        title: String(body.job.title ?? '').slice(0, 200),
        company: body.job.company ? String(body.job.company).slice(0, 120) : null,
        description: String(body.job.description ?? '').slice(0, 2500),
      }
    : null;

  const history: { role: 'user' | 'assistant'; content: string }[] = (Array.isArray(body?.history) ? body.history : [])
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string')
    .slice(-8)
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 1500) }));

  const { text: safeCv, restore } = redact(cv);
  const years = profileFromCv(cv).years;
  const today = new Date().toISOString().slice(0, 10);

  const run = (note?: string) =>
    groqJson(
      note ? `${SYSTEM}\n\nIMPORTANT: ${note}` : SYSTEM,
      { today, estimated_total_years_experience: years, max_chars: maxChars, job_posting: job, cv: safeCv, conversation: history, latest_message: question },
      { temperature: 0.3 },
    );

  let out: any;
  try {
    out = await run();
    const first = restore(String(out.answer ?? '')).trim();
    if (first.length > maxChars) {
      out = await run(`Your previous answer had ${first.length} characters but the limit is ${maxChars}. Rewrite it to fit, keeping the most relevant facts.`);
    }
  } catch (err) {
    if (err instanceof GroqLimitError) return json({ error: err.message }, 429);
    return json({ error: (err as Error).message }, 502);
  }

  let answer = restore(String(out.answer ?? '')).trim();
  if (!answer) return json({ error: 'El modelo no devolvió una respuesta. Inténtalo de nuevo.' }, 502);
  const warnings: string[] = [];

  // Still too long after a retry: cut at the last sentence that fits.
  if (answer.length > maxChars) {
    const cut = answer.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.endsWith('.') ? cut.length - 1 : -1);
    answer = (end > maxChars * 0.5 ? cut.slice(0, end + 1) : cut.trimEnd()).trim();
    warnings.push(`Se recortó para cumplir el límite de ${maxChars} caracteres.`);
  }

  // ── grounding checks (warnings, not blocks: the candidate decides) ──
  const userFacts = history.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  // Technologies named only in the latest question don't count as facts; the CV and the candidate's own messages do.
  const knownFacts = new Set(detectStack(`${safeCv}\n${userFacts}`));
  const unsupported = new Set<string>();
  for (const sentence of answer.split(/(?<=[.!?;:])\s+|\n+/)) {
    if (NEGATION.test(sentence)) continue; // "no he trabajado con X" is honest
    for (const t of detectStack(sentence)) if (!knownFacts.has(t)) unsupported.add(t);
  }
  if (unsupported.size) warnings.push(`Menciona ${[...unsupported].join(', ')}, que no aparece en tu CV ni en lo que me has contado. Quítalo o cuéntamelo.`);

  const allowedNums = new Set<string>([String(maxChars), String(new Date().getFullYear())]);
  for (const n of `${cv}\n${userFacts}`.match(/\d[\d.,]*/g) ?? []) allowedNums.add(n.replace(/[.,]+$/, '').replace(/[.,]/g, ''));
  if (years) for (let y = years - 1; y <= years + 1; y++) allowedNums.add(String(y));
  // Digits inside technology names (ES6, HTML5, CSS3, Vue3…) aren't figures.
  const withoutTech = answer.replace(/[A-Za-z]+\d+\+?/g, '');
  const oddNums = [...new Set((withoutTech.match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/[.,]+$/, '').replace(/[.,]/g, '')))].filter((n) => !allowedNums.has(n));
  if (oddNums.length) warnings.push(`Verifica estas cifras, no las encuentro en tu CV: ${oddNums.join(', ')}.`);

  const missing = (Array.isArray(out.missing) ? out.missing : []).map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 12);
  return json({ answer, chars: answer.length, maxChars, missing, warnings });
};
