import type { APIRoute } from 'astro';
import { LABELS, makeVerifier, parseRequest, redact } from '../../lib/cv.ts';
import { GroqLimitError, groqJson } from '../../lib/groq.ts';
import { detectStack } from '../../lib/extract.ts';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SYSTEM = `You adapt a candidate's CV to a job posting. Every statement you write must be grounded in the CV.

RULES
1. Never invent or inflate employers, titles, dates, metrics, technologies, degrees, certifications, responsibilities or years of experience.
2. For each experience bullet, "evidence" must be an EXACT excerpt copied from the CV (same language as the CV, no edits). "text" is that bullet rewritten in the language of the job posting, emphasizing what matters for the role. "text" must contain NO fact, number or technology that is not in its "evidence". Keep every number and metric from the evidence exactly as written (percentages, user counts, etc.): they are the most valuable part of a bullet.
3. Order roles as in the CV (most recent first). Within a role, put the bullets most relevant to the posting first; at most 5 per role. Omit irrelevant bullets.
4. Copy name, contact lines, role titles, company names, periods, skills, degrees and institutions VERBATIM from the CV. Never translate them.
5. Keep placeholders such as {{EMAIL1}}, {{PHONE2}}, {{URL3}} exactly as written.
6. "summary": 2 short sentences in the posting's language, stating only the candidate's role, years of experience and main technologies exactly as the CV supports them. No soft-skill or leadership claims unless the CV says so. Never mention technologies or abilities the CV lacks.
7. "skills": only skills that literally appear in the CV, those relevant to the posting first.
8. "gaps": requirements of the posting the CV does NOT support, in the posting's language. "matched_keywords": posting terms the CV does support.
9. Write text fields in the language of the job posting (Spanish or English).

Reply ONLY with JSON:
{"language":"es"|"en",
 "name":string,
 "contact":string[],
 "summary":string,
 "experience":[{"role":string,"company":string,"period":string|null,"bullets":[{"text":string,"evidence":string}]}],
 "skills":string[],
 "education":[{"degree":string,"institution":string,"period":string|null}],
 "matched_keywords":string[],
 "gaps":string[]}`;

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

  let out: any;
  try {
    out = await groqJson(SYSTEM, { job_posting: posting, cv: safeCv });
  } catch (err) {
    if (err instanceof GroqLimitError) return json({ error: err.message }, 429);
    return json({ error: (err as Error).message }, 502);
  }

  // ── verify everything against the (redacted) CV ──
  const v = makeVerifier(safeCv);
  const cvStack = new Set(detectStack(safeCv));
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  const arr = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  const lang: 'es' | 'en' = out.language === 'en' ? 'en' : 'es';
  const L = LABELS[lang];
  let removed = 0;

  const gaps = arr<unknown>(out.gaps).map(str).filter(Boolean).slice(0, 20);
  const gapTerms = gaps.map((g) => g.toLowerCase());

  // Name and contact come from the CV itself, never from the model's say-so.
  const firstLine = safeCv.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const name = (v.has(out.name) ? str(out.name) : firstLine).split(/\s+[-|–—]\s+/)[0].slice(0, 80); // just the name, not the headline
  const contact = [...new Set(safeCv.match(/\{\{(?:EMAIL|PHONE|LINK)\d+\}\}/g) ?? [])].slice(0, 4);

  // Summary: drop sentences that mention technologies the CV lacks or any listed gap.
  const summary = str(out.summary)
    .split(/(?<=[.!?])\s+/)
    .filter((sent) => {
      const bad = detectStack(sent).some((t) => !cvStack.has(t)) || gapTerms.some((g) => g.length > 3 && sent.toLowerCase().includes(g));
      if (bad) removed++;
      return !bad && sent;
    })
    .join(' ');

  const experience = arr<any>(out.experience).flatMap((r) => {
    if (!v.has(r?.role) || !v.has(r?.company)) { removed++; return []; }
    const bullets = arr<any>(r.bullets).flatMap((b) => {
      const text = str(b?.text);
      const ok =
        text && v.has(b?.evidence) &&
        v.numbersBacked(text, b.evidence) &&
        detectStack(text).every((t) => detectStack(b.evidence).includes(t));
      if (!ok) removed++;
      return ok ? [text] : [];
    }).slice(0, 5);
    if (!bullets.length) return [];
    return [{ role: str(r.role), company: str(r.company), period: v.has(r.period) ? str(r.period) : null, bullets }];
  });

  const skills = arr<unknown>(out.skills).filter((x) => { const ok = v.has(x); if (!ok) removed++; return ok; }).map(str);
  const education = arr<any>(out.education).flatMap((e) =>
    v.has(e?.degree) && v.has(e?.institution)
      ? [{ degree: str(e.degree), institution: str(e.institution), period: v.has(e.period) ? str(e.period) : null }]
      : [],
  );

  if (!experience.length) return json({ error: 'El modelo no produjo contenido verificable con tu CV. Inténtalo de nuevo.' }, 502);

  // Periods are copied verbatim; only localize the "ongoing" keyword to the output language.
  const period = (p: string | null) =>
    p && (lang === 'en' ? p.replace(/actualidad|presente|actual/gi, 'Present') : p.replace(/\b(present|current|now)\b/gi, 'actualidad'));

  const md = [
    name && `# ${name}`,
    contact.length && contact.join(' | '),
    summary && `## ${L.summary}\n${summary}`,
    `## ${L.experience}\n` + experience.map((r) => `**${r.role} – ${r.company}**${r.period ? ` (${period(r.period)})` : ''}\n${r.bullets.map((b) => `- ${b}`).join('\n')}`).join('\n\n'),
    skills.length && `## ${L.skills}\n${skills.join(' • ')}`,
    education.length && `## ${L.education}\n` + education.map((e) => `**${e.degree}** – ${e.institution}${e.period ? ` (${period(e.period)})` : ''}`).join('\n'),
  ].filter(Boolean).join('\n\n');

  const postingText = `${posting.title} ${posting.description}`.toLowerCase();
  const keywords = arr<unknown>(out.matched_keywords).map(str).filter((k) => k && v.has(k) && postingText.includes(k.toLowerCase())).slice(0, 25);

  return json({ language: lang, cv: restore(md), keywords, gaps, removed });
};
