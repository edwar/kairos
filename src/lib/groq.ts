import { CONTRACTS, MODALITIES, SENIORITIES, type Job } from './types.ts';
import { STACK_NAMES } from './extract.ts';

function env(name: string): string | undefined {
  return (import.meta.env?.[name] as string | undefined) ?? process.env[name];
}

export const aiEnabled = () => Boolean(env('GROQ_API_KEY'));

interface AiRow {
  id: string;
  stack?: string[];
  modality?: string | null;
  contract?: string | null;
  seniority?: string | null;
}

/**
 * Fills the gaps regex couldn't (stack, modality, contract, seniority) using Groq.
 * Only touches fields that are still empty; never overwrites portal data.
 */
export async function enrichWithGroq(jobs: Job[]): Promise<Job[]> {
  const key = env('GROQ_API_KEY');
  if (!key) return jobs;

  const needs = jobs.filter((j) => !j.modality || !j.contract || !j.seniority || j.stack.length === 0).slice(0, 60);
  if (!needs.length) return jobs;

  const byId = new Map<string, AiRow>();
  for (let i = 0; i < needs.length; i += 20) {
    const chunk = needs.slice(i, i + 20);
    const payload = chunk.map((j) => ({
      id: j.id,
      title: j.title,
      company: j.company,
      text: j.blurb ?? '',
    }));
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: env('GROQ_MODEL') ?? 'llama-3.3-70b-versatile',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Extract structured data from job postings (Spanish or English). Reply ONLY with JSON: ' +
                '{"jobs":[{"id":string,"stack":string[],"modality":"remote"|"hybrid"|"onsite"|null,' +
                '"contract":"permanent"|"fixed"|"freelance"|"internship"|"parttime"|null,' +
                '"seniority":"junior"|"mid"|"senior"|null}]}. ' +
                `Allowed stack values: ${STACK_NAMES.join(', ')}. ` +
                'Use null / [] when the posting does not say. Never guess.',
            },
            { role: 'user', content: JSON.stringify(payload) },
          ],
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`Groq ${res.status}`);
      const data = await res.json();
      const rows: AiRow[] = JSON.parse(data.choices?.[0]?.message?.content ?? '{}').jobs ?? [];
      for (const r of rows) byId.set(r.id, r);
    } catch (err) {
      console.warn('[groq] enrichment skipped:', (err as Error).message);
    }
  }

  return jobs.map((j) => {
    const r = byId.get(j.id);
    if (!r) return j;
    const stack = Array.isArray(r.stack) ? r.stack.filter((s) => STACK_NAMES.includes(s)) : [];
    return {
      ...j,
      stack: j.stack.length ? j.stack : stack,
      modality: j.modality ?? ((r.modality && r.modality in MODALITIES ? r.modality : null) as Job['modality']),
      contract: j.contract ?? ((r.contract && r.contract in CONTRACTS ? r.contract : null) as Job['contract']),
      seniority: j.seniority ?? ((r.seniority && r.seniority in SENIORITIES ? r.seniority : null) as Job['seniority']),
    };
  });
}


export class GroqLimitError extends Error {
  constructor(public wait: number) {
    super(`Límite de uso de Groq alcanzado. Reintenta en ${wait} s.`);
  }
}

/** One JSON-mode chat completion. Throws GroqLimitError on 429. */
export async function groqJson(system: string, user: unknown, opts: { temperature?: number } = {}): Promise<any> {
  const key = env('GROQ_API_KEY');
  if (!key) throw new Error('Falta GROQ_API_KEY en .env');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: env('GROQ_MODEL') ?? 'openai/gpt-oss-120b',
      temperature: opts.temperature ?? 0.2,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (res.status === 429) throw new GroqLimitError(Number(res.headers.get('retry-after')) || 30);
  if (!res.ok) throw new Error(`Groq ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
}
