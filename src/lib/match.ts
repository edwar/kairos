import { detectStack } from './extract.ts';
import type { Job } from './types.ts';

// Heuristic CV ↔ offer compatibility: technology overlap (70%, frameworks weigh most) and seniority vs. years of
// experience (30%). It is an estimate from detectable facts, not a semantic judgement.

export interface CvProfile {
  stack: Set<string>;
  years: number | null;
}

export interface Match {
  /** 0-100, or null when the offer doesn't list any technology to compare. */
  score: number | null;
  matched: string[];
  missing: string[];
  /** Short explanation of the experience check, if any. */
  experience: string | null;
}

// Skills a CV implies even when not listed (a React dev knows JavaScript and HTML/CSS).
const IMPLIES: Record<string, string[]> = {
  'Next.js': ['React', 'JavaScript', 'HTML/CSS'],
  Nuxt: ['Vue', 'JavaScript', 'HTML/CSS'],
  React: ['JavaScript', 'HTML/CSS'],
  Vue: ['JavaScript', 'HTML/CSS'],
  Angular: ['TypeScript', 'JavaScript', 'HTML/CSS'],
  Svelte: ['JavaScript', 'HTML/CSS'],
  TypeScript: ['JavaScript'],
  Tailwind: ['HTML/CSS'],
};

// The main framework decides fit far more than generic basics that nearly every offer lists.
const CORE = new Set(['React', 'Vue', 'Angular', 'Svelte', 'Next.js', 'Nuxt']);
const BASICS = new Set(['JavaScript', 'HTML/CSS']);
const weight = (s: string) => (CORE.has(s) ? 3 : BASICS.has(s) ? 0.5 : 1);

const MIN_YEARS = { junior: 0, mid: 2, senior: 5 } as const;
const EDUCATION = /universidad|university|colegio|bachiller|pregrado|posgrado|maestr[ií]a|degree|bootcamp|curso|certific/i;
const MONTH = '(?:[a-záéíóúñ]+\\s+(?:de\\s+)?)?';
const RANGE = new RegExp(`${MONTH}((?:19|20)\\d{2})\\s*[-–—]\\s*${MONTH}((?:19|20)\\d{2}|actualidad|presente?|current|hoy|now)`, 'gi');

/** Years of experience: the larger of an explicit "N years" claim and the union of dated ranges. */
export function profileFromCv(text: string, now = new Date()): CvProfile {
  const claimed = [...text.matchAll(/(\d{1,2})\s*\+?\s*(?:a[ñn]os|anios|years|yrs)/gi)].map((m) => Number(m[1])).filter((n) => n > 0 && n <= 45);

  const nowYear = now.getFullYear() + now.getMonth() / 12;
  const spans: [number, number][] = [];
  for (const line of text.split('\n')) {
    if (EDUCATION.test(line)) continue;
    for (const m of line.matchAll(RANGE)) {
      const start = Number(m[1]);
      const end = /^\d/.test(m[2]) ? Number(m[2]) + 1 : nowYear;
      if (end > start && start >= 1980 && end <= nowYear + 1) spans.push([start, end]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cur: [number, number] | null = null;
  for (const s of spans) {
    if (cur && s[0] <= cur[1]) cur[1] = Math.max(cur[1], s[1]);
    else { if (cur) covered += cur[1] - cur[0]; cur = [...s]; }
  }
  if (cur) covered += cur[1] - cur[0];

  const best = Math.max(0, ...claimed, Math.round(covered));
  const stack = new Set(detectStack(text));
  for (const s of [...stack]) IMPLIES[s]?.forEach((i) => stack.add(i));
  return { stack, years: best > 0 ? best : null };
}

export function matchJob(job: Job, p: CvProfile): Match {
  const matched = job.stack.filter((s) => p.stack.has(s));
  const missing = job.stack.filter((s) => !p.stack.has(s));
  if (!job.stack.length) return { score: null, matched, missing, experience: null };

  const total = job.stack.reduce((n, s) => n + weight(s), 0);
  const stackFit = matched.reduce((n, s) => n + weight(s), 0) / total;

  let expFit: number | null = null;
  let experience: string | null = null;
  if (job.seniority) {
    const need = MIN_YEARS[job.seniority];
    if (p.years === null) {
      expFit = 0.7;
      experience = 'No pude estimar tus años de experiencia';
    } else {
      expFit = need === 0 ? 1 : Math.min(1, p.years / need);
      if (expFit < 1) experience = `Pide nivel ${job.seniority === 'senior' ? 'senior' : 'semi-senior'} (~${need}+ años) y tu CV suma ~${p.years}`;
    }
  }

  let score = Math.round(100 * (expFit === null ? stackFit : 0.7 * stackFit + 0.3 * expFit));
  // An offer that only lists basics tells us too little to promise a high match.
  if (job.stack.every((s) => BASICS.has(s))) score = Math.min(score, 70);
  return { score, matched, missing, experience };
}
