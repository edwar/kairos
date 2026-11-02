import type { APIRoute } from 'astro';
import { makeVerifier, parseRequest, redact } from '../../lib/cv.ts';
import { detectLanguage, detectStack } from '../../lib/extract.ts';
import { GroqLimitError, groqJson } from '../../lib/groq.ts';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SYSTEM = `You write a short cover letter body for a candidate applying to a job posting. Every claim must be grounded in the CV.

RULES
1. Write in the language of the job posting (Spanish or English), first person, warm but professional and concrete. Avoid clichés ("I am passionate", "dynamic team", "perfect fit").
2. Output 7 to 10 sentences, each tagged with a paragraph number p:
   p=1 opening (2 sentences): the role being applied for and why the candidate's background is relevant.
   p=2 evidence (3-5 sentences): concrete achievements and skills taken from the CV that match what the posting asks for. Keep numbers and metrics exactly as in the CV.
   p=3 closing (1-2 sentences): interest in talking further.
3. Each sentence has "kind":
   - "text" is ALWAYS written in the posting's language, even when the CV is in another language: translate the evidence, never paste it. Only "evidence" stays in the CV's language.
   - "claim": states something about the candidate's experience, skills, results, tools or years. It MUST carry "evidence": an EXACT excerpt copied from the CV (same language as the CV, unedited), and must contain no fact, number or technology absent from that evidence.
   - "framing": only refers to the role, the company's name or the conversation (no technologies, no numbers, no claims about the candidate). "evidence" is null.
4. Never claim a skill, tool, seniority, leadership or experience the CV does not show. Do not say anything about the company beyond what the posting states. Do not mention the candidate's gaps.
5. Do not include a greeting, a sign-off or the candidate's name; they are added separately. Keep placeholders such as {{EMAIL1}} out of the text.
6. "gaps": posting requirements the CV does NOT support, in the posting's language.

Reply ONLY with JSON:
{"language":"es"|"en","sentences":[{"p":1|2|3,"kind":"claim"|"framing","text":string,"evidence":string|null}],"gaps":string[]}`;

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  const parsed = parseRequest(body);
  if ('error' in parsed) return json({ error: parsed.error }, 400);
  const { cv, posting } = parsed;
  const { text: safeCv, restore } = redact(cv);

  const v = makeVerifier(safeCv);
  const cvStack = new Set(detectStack(safeCv));
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');

  /** Runs the model and keeps only sentences that are grounded in the CV and in the right language. */
  async function generate(note?: string) {
    const out = await groqJson(
      note ? `${SYSTEM}\n\nIMPORTANT: ${note}` : SYSTEM,
      { job_posting: posting, cv: safeCv },
      { temperature: 0.4 },
    );
    const gaps: string[] = (Array.isArray(out.gaps) ? out.gaps : []).map(str).filter(Boolean).slice(0, 20);
    const gapTerms = gaps.map((g) => g.toLowerCase()).filter((g) => g.length > 3);
    const lang: 'es' | 'en' = posting.language === 'en' || posting.language === 'es' ? posting.language : out.language === 'en' ? 'en' : 'es';
    const paragraphs: string[][] = [[], [], []];
    let removed = 0;
    let wrongLang = 0;
    for (const s of Array.isArray(out.sentences) ? out.sentences : []) {
      const text = str(s?.text);
      const p = [1, 2, 3].includes(Number(s?.p)) ? Number(s.p) - 1 : 1;
      const techs = detectStack(text);
      let ok = Boolean(text) && !gapTerms.some((g) => text.toLowerCase().includes(g));
      if (ok && s.kind === 'claim') {
        ok = v.has(s.evidence) && v.numbersBacked(text, s.evidence) && techs.every((t) => detectStack(s.evidence).includes(t));
      } else if (ok) {
        ok = techs.length === 0 && !/\d/.test(text); // framing: no technologies or numbers
      }
      const detected = ok ? detectLanguage(text) : null;
      if (ok && detected && detected !== lang) { wrongLang++; ok = false; }
      if (ok) paragraphs[p].push(text); else removed++;
    }
    return { lang, gaps, paragraphs, removed, wrongLang };
  }

  let res;
  try {
    res = await generate();
    if (res.wrongLang > 0) {
      const target = res.lang === 'en' ? 'English' : 'Spanish';
      res = await generate(`A previous attempt had sentences in the wrong language. Every "text" MUST be in ${target}. Translate the CV content; do not copy it.`);
    }
  } catch (err) {
    if (err instanceof GroqLimitError) return json({ error: err.message }, 429);
    return json({ error: (err as Error).message }, 502);
  }
  const { lang, gaps, paragraphs, removed } = res;
  const bodyText = paragraphs.filter((p) => p.length).map((p) => p.join(' ')).join('\n\n');
  if (paragraphs[1].length === 0) return json({ error: 'El modelo no produjo una carta verificable con tu CV. Inténtalo de nuevo.' }, 502);

  // Greeting, sign-off and contact are assembled here so the model can't alter them.
  const firstLine = safeCv.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const name = firstLine.split(/\s+[-|–—]\s+/)[0].slice(0, 80);
  const contact = [...new Set(safeCv.match(/\{\{(?:EMAIL|PHONE)\d+\}\}/g) ?? [])].join(' | ');
  const company = posting.company?.trim();
  const greeting = lang === 'en'
    ? `Dear ${company ? `${company} hiring team` : 'hiring team'},`
    : `Estimado equipo ${company ? `de ${company}` : 'de selección'},`;
  const signoff = lang === 'en' ? 'Sincerely,' : 'Atentamente,';
  const letter = [greeting, bodyText, `${signoff}\n${name}${contact ? `\n${contact}` : ''}`].join('\n\n');

  return json({ language: lang, letter: restore(letter), gaps, removed });
};
