import type { Contract, Language, Modality, Seniority } from './types.ts';

const STACK_PATTERNS: [string, RegExp][] = [
  ['React', /\breact(?:\.?js)?\b/i],
  ['Next.js', /\bnext[\s.-]?js\b/i],
  ['Vue', /\bvue(?:\.?js)?\b/i],
  ['Nuxt', /\bnuxt(?:\.?js)?\b/i],
  ['Angular', /\bangular(?:js)?\b/i],
  ['Svelte', /\bsvelte(?:kit)?\b/i],
  ['TypeScript', /\btypescript\b|\bts\b/i],
  ['JavaScript', /\bjavascript\b|\bjs\b/i],
  ['Tailwind', /\btailwind/i],
  ['HTML/CSS', /\bhtml5?\b|\bcss3?\b|\bsass\b|\bscss\b/i],
  ['Node.js', /\bnode(?:\.?js)?\b/i],
  ['GraphQL', /\bgraphql\b/i],
  ['Redux', /\bredux\b/i],
  ['Figma', /\bfigma\b/i],
  ['Storybook', /\bstorybook\b/i],
  ['Testing', /\bjest\b|\bcypress\b|\bplaywright\b|\bvitest\b/i],
  ['.NET', /\.net\b|\bdotnet\b|\bc#/i],
  ['Java', /\bjava\b(?!\s*script)/i],
  ['PHP', /\bphp\b|\blaravel\b/i],
  ['WordPress', /\bwordpress\b|\bwoocommerce\b/i],
  ['Python', /\bpython\b|\bdjango\b|\bfastapi\b/i],
];

export const STACK_NAMES = STACK_PATTERNS.map(([n]) => n);

export function detectStack(text: string): string[] {
  return STACK_PATTERNS.filter(([, re]) => re.test(text)).map(([n]) => n);
}

export function detectModality(text: string): Modality | null {
  if (/h[ií]brid|hybrid|semi-?presencial/i.test(text)) return 'hybrid';
  if (/\bremot[oa]\b|teletrabaj|home ?office|work from home|100 ?% ?remot|\bremote\b/i.test(text)) return 'remote';
  if (/presencial|on-?site|in-?office/i.test(text)) return 'onsite';
  return null;
}

export function detectContract(text: string): Contract | null {
  if (/(?<!buenas |mejores |las |sus )pr[aá]cticas(?! de | [aá]giles| y metodolog| en (?:desarrollo|programaci|seguridad|clean|testing))|pasant|becari|internship|\bintern\b|practicante/i.test(text)) return 'internship';
  if (/freelance|aut[oó]nomo|honorarios|prestaci[oó]n de servicios|independiente|por proyecto/i.test(text)) return 'freelance';
  if (/media jornada|medio tiempo|part[- ]?time|jornada parcial|tiempo parcial/i.test(text)) return 'parttime';
  if (/indefinid|permanent|de planta|contrato fijo|t[eé]rmino indefinido/i.test(text)) return 'permanent';
  if (/temporal|fixed[- ]?term|obra o labor|duraci[oó]n determinada|t[eé]rmino fijo|por obra/i.test(text)) return 'fixed';
  return null;
}

export function detectSeniority(text: string): Seniority | null {
  if (/semi[\s-]?senior|\bssr\b|\bmid[\s-]?level\b|\bintermedi[oa]\b|\bmid\b/i.test(text)) return 'mid';
  if (/\bsenior\b|\bsr\b\.?|\blead\b|l[ií]der|\bstaff\b|\bprincipal\b|\bsénior\b/i.test(text)) return 'senior';
  if (/\bjunior\b|\bjr\b\.?|\btrainee\b|\bentry[\s-]?level\b|sin experiencia/i.test(text)) return 'junior';
  return null;
}

const ES_WORDS = /\b(el|la|los|las|con|para|experiencia|del|una|un|que|por|en|tu|nuestro|equipo|buscamos|requisitos|conocimientos)\b/gi;
const EN_WORDS = /\b(the|and|with|you|your|will|experience|our|team|we|are|for|of|to|looking|requirements|skills)\b/gi;

export function detectLanguage(text: string): Language | null {
  if (text.length < 20) return null;
  const es = (text.match(ES_WORDS) ?? []).length;
  const en = (text.match(EN_WORDS) ?? []).length;
  if (es + en < 3) return null;
  return en > es * 1.2 ? 'en' : 'es';
}

export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTHS: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};

/** Parses Computrabajo relative dates ("Hace 3 días", "Ayer", "21 de octubre"). */
export function parsePostedText(text: string | null | undefined, now = new Date()): string | null {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  const day = 86_400_000;
  let ms: number | null = null;
  let m: RegExpMatchArray | null;
  if (/^ayer/.test(t)) ms = day;
  else if (/^hoy/.test(t)) ms = 0;
  else if ((m = t.match(/hace\s+(\d+)\s*(minuto|hora)/))) ms = 0;
  else if ((m = t.match(/hace\s+(\d+)\s*d[ií]a/))) ms = Number(m[1]) * day;
  else if ((m = t.match(/hace\s+(\d+)\s*semana/))) ms = Number(m[1]) * 7 * day;
  else if ((m = t.match(/hace\s+(\d+)\s*mes/))) ms = Number(m[1]) * 30 * day;
  else if (/m[aá]s de 30/.test(t)) ms = 31 * day;
  else if ((m = t.match(/(\d{1,2})\s+de\s+([a-záéíóú]+)/)) && m[2] in MONTHS) {
    const d = new Date(now.getFullYear(), MONTHS[m[2]], Number(m[1]), 12);
    if (d.getTime() > now.getTime()) d.setFullYear(d.getFullYear() - 1);
    return d.toISOString();
  }
  return ms === null ? null : new Date(now.getTime() - ms).toISOString();
}

/** True if the text clearly looks like a "no salary" placeholder. */
export function isNoSalary(text: string | null | undefined): boolean {
  return !text || /no disponible|a convenir|confidencial|no especificado/i.test(text);
}


// ───────────────────────── Red flags ─────────────────────────
// Heuristic: phrases that commonly signal a poor job. A flag is a reason to read the offer
// carefully, not proof of a bad employer.

const RED_FLAGS: [string, RegExp][] = [
  ['Rockstar / ninja', /rock\s?star|\bninja\b|\bgur[uú]\b|\bunicorn/i],
  ['Todólogo', /todo ?terreno|tod[oó]logo|hombre orquesta|multi-?tarea|multitask|wear many hats|varios sombreros/i],
  ['Presión constante', /bajo presi[oó]n|alta presi[oó]n|fast[- ]paced|ritmo (?:acelerado|fren[eé]tico)|entornos? (?:muy )?cambiantes?/i],
  ['"Somos una familia"', /somos una familia|como una familia|we(?:'re| are) (?:like )?a family/i],
  ['Disponibilidad total', /disponibilidad (?:total|inmediata|completa|24)|\bguardias?\b|\bon[- ]?call\b|24\/7|fines de semana|horas extras?\b/i],
  ['Pago dudoso', /\bcomisi[oó]n(?:es)?\b|sin sueldo|no remunerad|ad honorem|voluntari[oa]|\bunpaid\b/i],
  ['Experiencia excesiva', /\b(?:1\d|[89])\+?\s*(?:a[ñn]os|years)\s+(?:de\s+)?(?:experiencia|experience)/i],
];

export function detectRedFlags(text: string, stackCount: number): string[] {
  const flags = RED_FLAGS.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (stackCount >= 9) flags.push('Stack interminable');
  return flags;
}
