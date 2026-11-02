import { extractText, getDocumentProxy } from 'unpdf';

export const CV_MAX_CHARS = 12_000;

export async function pdfToText(buf: ArrayBuffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join('\n') : text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Swaps contact details for placeholders before the CV leaves the server, so they never reach the
 * model; `restore` puts them back in the output.
 */
export function redact(text: string) {
  const map = new Map<string, string>();
  const swap = (kind: string | ((m: string) => string), re: RegExp, valid: (m: string) => boolean = () => true) => {
    text = text.replace(re, (m) => {
      if (!valid(m)) return m;
      for (const [k, v] of map) if (v === m) return k;
      const key = `{{${typeof kind === 'function' ? kind(m) : kind}${map.size + 1}}}`;
      map.set(key, m);
      return key;
    });
  };
  swap('EMAIL', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g);
  // LINK = professional profiles (kept in the CV header); URL = anything else (projects, etc.)
  swap((m) => (/linkedin\.com|github\.com/i.test(m) ? 'LINK' : 'URL'), /(?:https?:\/\/|www\.)[^\s)>\]]+|(?:linkedin\.com|github\.com)\/[^\s)>\]]+/gi);
  // A phone has at least 9 digits and isn't a year range like "2020 - 2022" or a date.
  swap('PHONE', /(?<![\w.])\+?\d[\d\s().-]{7,}\d(?![\w.])/g, (m) => {
    const digits = m.replace(/\D/g, '').length;
    return digits >= 9 && digits <= 15 && !/^\d{4}\s*[-–]\s*\d{4}$/.test(m.trim());
  });
  return {
    text,
    restore: (out: string) => out.replace(/\{\{(?:EMAIL|LINK|URL|PHONE)\d+\}\}/g, (k) => map.get(k) ?? k),
  };
}

// ───────────────────────── Grounding checks ─────────────────────────
// The model must cite verbatim CV text for everything it writes; these helpers verify that.

const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9+#.]+/g, ' ').trim();
const compact = (t: string) => norm(t).replace(/\s+/g, '');

export function makeVerifier(cv: string) {
  const full = compact(cv);
  const words = new Set(norm(cv).split(/\s+/).filter(Boolean));
  return {
    /** The snippet appears in the CV (tolerant to line breaks, case and accents). */
    has(snippet: unknown): snippet is string {
      if (typeof snippet !== 'string') return false;
      const c = compact(snippet);
      if (c.length < 2) return false;
      if (full.includes(c)) return true;
      const toks = norm(snippet).split(/\s+/).filter((w) => w.length > 2);
      return toks.length >= 4 && toks.filter((w) => words.has(w)).length / toks.length >= 0.9;
    },
    /** Every number in `text` also appears in `evidence` (blocks invented metrics). */
    numbersBacked(text: string, evidence: string) {
      const nums = (t: string) => (t.match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/[.,]+$/, '').replace(/[.,]/g, ''));
      const ev = new Set(nums(evidence));
      return nums(text).every((n) => ev.has(n));
    },
  };
}

export const LABELS = {
  es: { summary: 'Resumen', experience: 'Experiencia', skills: 'Habilidades', education: 'Educación' },
  en: { summary: 'Summary', experience: 'Experience', skills: 'Skills', education: 'Education' },
} as const;

/** Validates a tailor/cover request body. */
export function parseRequest(body: any):
  | { error: string }
  | { cv: string; posting: { title: string; company: string | null; language: string; description: string; stack: string[] } } {
  const cv = typeof body?.cv === 'string' ? body.cv.slice(0, CV_MAX_CHARS) : '';
  const job = body?.job ?? {};
  const title = typeof job.title === 'string' ? job.title.slice(0, 200) : '';
  if (cv.length < 200 || !title) return { error: 'Faltan el CV o la oferta' };
  return {
    cv,
    posting: {
      title,
      company: typeof job.company === 'string' ? job.company.slice(0, 120) : null,
      language: job.language === 'es' || job.language === 'en' ? job.language : 'detect from the text',
      description: (typeof job.description === 'string' ? job.description : '').slice(0, 4000),
      stack: Array.isArray(job.stack) ? job.stack.slice(0, 20).map(String) : [],
    },
  };
}
