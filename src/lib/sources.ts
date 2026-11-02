import {
  detectContract, detectLanguage, detectModality, detectRedFlags, detectSeniority, detectStack,
  parsePostedText, stripHtml,
} from './extract.ts';
import type { CountryCode, Job, Source } from './types.ts';

const CURRENCY: Record<CountryCode, string> = {
  MX: 'MXN', CO: 'COP', AR: 'ARS', CL: 'CLP', PE: 'PEN', WW: 'USD',
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function build(partial: Omit<Job, 'modality' | 'contract' | 'seniority' | 'language' | 'stack' | 'redFlags'> & {
  text: string; // title + description + extra, used for detection
  modality?: Job['modality'];
  contract?: Job['contract'];
}): Job {
  const { text, ...rest } = partial;
  const stack = detectStack(text);
  return {
    ...rest,
    modality: partial.modality ?? detectModality(text),
    contract: partial.contract ?? detectContract(text),
    seniority: detectSeniority(partial.title) ?? detectSeniority(text),
    language: detectLanguage(text),
    stack,
    redFlags: detectRedFlags(text, stack.length),
    blurb: text.slice(0, 600),
    description: text.slice(0, 4000),
  };
}

// After an anti-bot block, stop hitting the site for a while instead of making it worse.
const BLOCK_COOLDOWN = 15 * 60_000;
const blockedUntil: Partial<Record<Source, number>> = {};
async function guarded(source: Source, run: () => Promise<Job[]>): Promise<Job[]> {
  const wait = (blockedUntil[source] ?? 0) - Date.now();
  if (wait > 0) throw new Error(`${source} bloqueó las peticiones; reintenta en ${Math.ceil(wait / 60_000)} min`);
  try {
    return await run();
  } catch (err) {
    if (/anti-bot|\b(403|429)\b/.test((err as Error).message)) blockedUntil[source] = Date.now() + BLOCK_COOLDOWN;
    throw err;
  }
}

// ───────────────────────── Computrabajo ─────────────────────────

const CT_SUBDOMAIN: Partial<Record<CountryCode, string>> = { MX: 'mx', CO: 'co', AR: 'ar', CL: 'cl', PE: 'pe' };
const CT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CT_PAGE_SIZE = 20;
const CT_MAX_PAGES = 3;
const CT_UNIT: Record<string, string> = { HOUR: 'Por hora', DAY: 'Diario', WEEK: 'Semanal', MONTH: 'Mensual', YEAR: 'Anual' };

const slugify = (q: string) =>
  q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ctGet(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': CT_UA, 'accept-language': 'es-ES,es;q=0.9', accept: 'text/html' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Computrabajo ${res.status}`);
  const html = await res.text();
  if (/just a moment|attention required|cf-challenge|geetest|captcha/i.test(html.slice(0, 4000))) throw new Error('Computrabajo: bloqueo anti-bot');
  return html;
}

interface CtListing { id: string; path: string; title: string; company: string | null; location: string | null; modalityText: string; postedText: string }

function parseCtListing(html: string): CtListing[] {
  const clean = (v: string | undefined) => (v ? stripHtml(v) || null : null);
  return [...html.matchAll(/<article class="box_offer[\s\S]*?<\/article>/g)].flatMap(([block]) => {
    const link = block.match(/<a class="js-o-link[^"]*"\s+href="([^"#]+)[^"]*">([\s\S]*?)<\/a>/);
    const id = block.match(/data-id='([^']+)'/)?.[1];
    const title = clean(link?.[2]);
    if (!link || !id || !title) return [];
    return [{
      id,
      path: link[1],
      title,
      company: clean(block.match(/offer-grid-article-company-url>\s*([^<]+)/)?.[1]),
      location: clean(block.match(/<p class="fs16 fc_base mt5">\s*<span class="mr10">\s*([^<]+)/)?.[1]),
      modalityText: clean(block.match(/class="icon i_home_office"><\/span>\s*([^<]+)/)?.[1]) ?? '',
      postedText: clean(block.match(/fs13 fc_aux mt15">\s*([^<]+)/)?.[1]) ?? '',
    }];
  });
}

interface CtDetail { description: string; salary: string | null; postedAt: string | null }

function parseCtDetail(html: string, country: CountryCode): CtDetail | null {
  for (const [, raw] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data: any;
    try { data = JSON.parse(raw); } catch { continue; }
    const find = (o: any): any =>
      !o || typeof o !== 'object' ? null
      : o['@type'] === 'JobPosting' ? o
      : Object.values(o).map(find).find(Boolean) ?? null;
    const jp = find(data);
    if (!jp) continue;
    const v = jp.baseSalary?.value;
    const lo = Number(v?.minValue ?? v?.value ?? 0);
    const hi = Number(v?.maxValue ?? 0);
    const fmt = (n: number) => n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const unit = CT_UNIT[String(v?.unitText ?? '').toUpperCase()];
    const cur = jp.baseSalary?.currency ?? jp.salaryCurrency ?? CURRENCY[country];
    return {
      description: stripHtml(String(jp.description ?? '').replace(/\n/g, ' ')),
      salary: lo > 0 ? `$ ${fmt(lo)}${hi > lo ? ` – ${fmt(hi)}` : ''}${unit ? ` (${unit})` : ''} ${cur}` : null,
      postedAt: str(jp.datePosted) ? new Date(jp.datePosted).toISOString() : null,
    };
  }
  return null;
}

/** Scrapes Computrabajo's public listing pages. */
async function scrapeComputrabajo(q: string, country: CountryCode, days: number): Promise<Job[]> {
  const sub = CT_SUBDOMAIN[country];
  if (!sub) return [];
  const base = `https://${sub}.computrabajo.com`;
  const pubdate = days <= 1 ? 1 : days <= 3 ? 3 : days <= 7 ? 7 : days <= 15 ? 15 : 30;

  const listings = new Map<string, CtListing>();
  for (let page = 1; page <= CT_MAX_PAGES; page++) {
    if (page > 1) await sleep(400);
    const html = await ctGet(`${base}/trabajo-de-${slugify(q)}?pubdate=${pubdate}${page > 1 ? `&p=${page}` : ''}`);
    const items = parseCtListing(html);
    const before = listings.size;
    items.forEach((it) => listings.set(it.id, it));
    if (items.length < CT_PAGE_SIZE - 1 || listings.size === before) break;
  }

  const toJob = (l: CtListing, d?: CtDetail | null) => {
    const hybrid = /presencial y remoto|h[ií]brido|mixto/i.test(l.modalityText);
    return build({
      id: `computrabajo:${country}:${l.id}`,
      title: l.title,
      company: l.company,
      location: l.location,
      country,
      source: 'computrabajo',
      url: `${base}${l.path}`,
      postedAt: d?.postedAt ?? parsePostedText(l.postedText),
      salary: d?.salary ?? null,
      modality: hybrid ? 'hybrid' : detectModality(l.modalityText),
      text: `${l.title} ${l.path.split('/').pop()?.replace(/-/g, ' ') ?? ''} ${d?.description ?? ''}`,
    });
  };

  // Only fetch detail pages (salary, description) for roles that pass the relevance filter.
  const relevant = [...listings.values()].filter((l) => isRelevant(toJob(l), q));
  const out: Job[] = [];
  for (let i = 0; i < relevant.length; i += 5) {
    const batch = relevant.slice(i, i + 5);
    out.push(...(await Promise.all(batch.map(async (l) => {
      const detail = await ctGet(`${base}${l.path}`).then((h) => parseCtDetail(h, country)).catch(() => null);
      return toJob(l, detail);
    }))));
    await sleep(250);
  }
  return out;
}

export const fetchComputrabajo = (q: string, country: CountryCode, days = 7) =>
  guarded('computrabajo', () => scrapeComputrabajo(q, country, days));

// ───────────────────────── Elempleo (Colombia) ─────────────────────────

const unescapeHtml = (t: string) =>
  t.replace(/&quot;/g, '"').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const EE_PAGE_SIZE = 20;
const EE_MAX_PAGES = 3;

interface EeCard { id: string; path: string; title: string; company: string | null; city: string | null; posted: string; facts: Record<string, string>; description: string }

function parseElempleo(html: string): EeCard[] {
  return html.split('<div class="col-md-12 result-item').slice(1).flatMap((block) => {
    const path = block.match(/data-url="([^"?]+)/)?.[1];
    let meta: any = {};
    try { meta = JSON.parse(unescapeHtml(block.match(/data-ga4-offerdata="([^"]*)"/)?.[1] ?? '{}')); } catch {}
    if (!path || !meta.id || !meta.title) return [];
    // "value / label" pairs: Salario, Tipo de contrato, Ubicación, Modalidad laboral
    const facts: Record<string, string> = {};
    for (const [, value, label] of block.matchAll(/<div class="text-blue-petrol-dark">\s*([\s\S]*?)\s*<\/div>\s*<div class="small-text[^"]*">\s*([^<]+?)\s*<\/div>/g)) {
      facts[stripHtml(label)] ??= stripHtml(value);
    }
    return [{
      id: String(meta.id),
      path,
      title: stripHtml(String(meta.title)),
      company: str(stripHtml(String(meta.company ?? ''))),
      city: str(stripHtml(String(meta.location ?? ''))),
      posted: stripHtml(block.match(/js-offer-date[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? ''),
      facts,
      description: stripHtml(unescapeHtml(block.match(/data-offer-description="([^"]*)"/)?.[1] ?? '')),
    }];
  });
}

/** Scrapes Elempleo's public listing (the site's own JSON API requires credentials, so it isn't used). */
async function scrapeElempleo(q: string): Promise<Job[]> {
  const cards = new Map<string, EeCard>();
  for (let page = 1; page <= EE_MAX_PAGES; page++) {
    if (page > 1) await sleep(400);
    const url = `https://www.elempleo.com/co/ofertas-empleo/${page > 1 ? `${page}/` : ''}?Trabajo=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'user-agent': CT_UA, 'accept-language': 'es-CO,es;q=0.9', accept: 'text/html' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Elempleo ${res.status}`);
    const html = await res.text();
    if (/just a moment|attention required|geetest|cf-challenge/i.test(html.slice(0, 4000))) throw new Error('Elempleo: bloqueo anti-bot');
    const items = parseElempleo(html);
    const before = cards.size;
    items.forEach((c) => cards.set(c.id, c));
    if (items.length < EE_PAGE_SIZE || cards.size === before) break;
  }
  return [...cards.values()].map((c) => {
    const salary = c.facts['Salario'];
    const hybrid = /h[ií]brido/i.test(c.facts['Modalidad laboral'] ?? '');
    return build({
      id: `elempleo:${c.id}`,
      title: c.title,
      company: c.company,
      location: c.city ?? str(c.facts['Ubicación']),
      country: 'CO',
      source: 'elempleo',
      url: `https://www.elempleo.com${c.path}`,
      postedAt: parsePostedText(c.posted),
      salary: salary && !/confidencial|no disponible|a convenir|no especificado/i.test(salary) ? `${salary} COP` : null,
      modality: hybrid ? 'hybrid' : detectModality(c.facts['Modalidad laboral'] ?? ''),
      contract: detectContract(c.facts['Tipo de contrato'] ?? ''),
      text: `${c.title} ${c.facts['Tipo de contrato'] ?? ''} ${c.description}`,
    });
  });
}

export const fetchElempleo = (q: string) => guarded('elempleo', () => scrapeElempleo(q));

// ───────────────────────── Get on Board (LATAM, API pública) ─────────────────────────

const GOB_MODALITY: Record<string, Job['modality']> = { hybrid: 'hybrid', no_remote: 'onsite' };
const GOB_SENIORITY: Record<number, Job['seniority']> = { 1: 'junior', 2: 'junior', 3: 'mid', 4: 'senior', 5: 'senior' };
const GOB_CONTRACT: Record<number, Job['contract']> = { 2: 'parttime', 3: 'freelance', 4: 'internship' };

export async function fetchGetOnBoard(q: string, country: CountryCode): Promise<Job[]> {
  const items: any[] = [];
  for (let page = 1; page <= 2; page++) {
    const params = new URLSearchParams({ query: q, country_code: country, per_page: '100', page: String(page), expand: '["company"]' });
    const res = await fetch(`https://www.getonbrd.com/api/v0/search/jobs?${params}`, {
      headers: { 'user-agent': CT_UA, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Get on Board ${res.status}`);
    const data: any = await res.json();
    items.push(...(data.data ?? []));
    if (page >= (data.meta?.total_pages ?? 1)) break;
  }
  return items.map((it) => {
    const a = it.attributes ?? {};
    const desc = stripHtml([a.description, a.functions, a.desirable].filter(Boolean).join(' '));
    const min = Number(a.min_salary ?? 0);
    const max = Number(a.max_salary ?? 0);
    const n = (v: number) => v.toLocaleString('es-ES');
    const countries: string[] = Array.isArray(a.countries) ? a.countries : [];
    const remote = a.remote_modality && !GOB_MODALITY[a.remote_modality];
    const modality: Job['modality'] = GOB_MODALITY[a.remote_modality] ?? (remote ? 'remote' : null);
    const lang = a.lang === 'es' ? 'es' : a.lang === 'en' ? 'en' : null;
    const job = build({
      id: `getonboard:${it.id}`,
      title: str(a.title) ?? 'Sin título',
      company: str(a.company?.data?.attributes?.name),
      location: modality === 'remote' ? 'Remoto' : countries.filter((c) => c !== 'Remote').join(', ') || null,
      country,
      source: 'getonboard',
      url: str(it.links?.public_url) ?? `https://www.getonbrd.com/jobs/${it.id}`,
      postedAt: a.published_at ? new Date(Number(a.published_at) * 1000).toISOString() : null,
      salary: min || max ? `${min && max && max > min ? `${n(min)} – ${n(max)}` : n(max || min)} USD mensual` : null,
      modality,
      contract: GOB_CONTRACT[Number(it.attributes?.modality?.data?.id)] ?? null,
      text: `${a.title} ${desc}`,
    });
    const seniority = GOB_SENIORITY[Number(a.seniority?.data?.id)];
    return { ...job, seniority: seniority ?? job.seniority, language: lang ?? job.language };
  });
}

// ───────────────────────── RemoteOK (remoto global, API pública) ─────────────────────────
// Returns the ~100 latest jobs (search is ignored), so filtering happens locally.
// Their terms ask to link back to RemoteOK and credit it: URLs point to remoteok.com and `source` is shown.

export async function fetchRemoteOk(): Promise<Job[]> {
  const res = await fetch('https://remoteok.com/api', {
    headers: { 'user-agent': CT_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`RemoteOK ${res.status}`);
  const data: any[] = await res.json();
  const n = (v: number) => v.toLocaleString('es-ES');
  return data
    .filter((it) => it && typeof it === 'object' && it.position)
    .map((it) => {
      const min = Number(it.salary_min ?? 0);
      const max = Number(it.salary_max ?? 0);
      const tags = Array.isArray(it.tags) ? it.tags.join(' ') : '';
      return build({
        id: `remoteok:${it.id ?? it.slug}`,
        title: str(it.position) ?? 'Sin título',
        company: str(it.company),
        location: str(it.location) ?? 'Remoto',
        country: 'WW',
        source: 'remoteok',
        url: str(it.url) ?? '',
        postedAt: str(it.date) ? new Date(it.date).toISOString() : null,
        salary: min || max ? `${min && max && max > min ? `${n(min)} – ${n(max)}` : n(max || min)} USD anual` : null,
        modality: 'remote',
        text: `${it.position} ${tags} ${stripHtml(it.description)}`,
      });
    });
}

// ───────────────────────── Jobicy (remoto global, API pública) ─────────────────────────
// Their terms: credit Jobicy with a link to the source (the URL points to jobicy.com and `source` is shown).

const JOBICY_LEVEL: Record<string, Job['seniority']> = { junior: 'junior', entry: 'junior', midweight: 'mid', senior: 'senior' };
const JOBICY_PERIOD: Record<string, string> = { hourly: 'por hora', daily: 'diario', weekly: 'semanal', monthly: 'mensual', yearly: 'anual' };

export async function fetchJobicy(q: string): Promise<Job[]> {
  const res = await fetch(`https://jobicy.com/api/v2/remote-jobs?${new URLSearchParams({ count: '100', tag: q })}`, {
    headers: { 'user-agent': CT_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Jobicy ${res.status}`);
  const data: any = await res.json();
  const n = (v: number) => v.toLocaleString('es-ES');
  return (Array.isArray(data?.jobs) ? data.jobs : []).map((it: any) => {
    const min = Number(it.salaryMin ?? 0);
    const max = Number(it.salaryMax ?? 0);
    const types = (Array.isArray(it.jobType) ? it.jobType : [it.jobType]).join(' ').toLowerCase();
    const geo = str(String(it.jobGeo ?? '').replace(/\s+/g, ' '));
    const period = JOBICY_PERIOD[String(it.salaryPeriod ?? '').toLowerCase()];
    const job = build({
      id: `jobicy:${it.id}`,
      title: stripHtml(String(it.jobTitle ?? '')) || 'Sin título',
      company: str(it.companyName),
      location: geo ? `Remoto · ${geo}` : 'Remoto',
      country: 'WW',
      source: 'jobicy',
      url: str(it.url) ?? '',
      postedAt: str(it.pubDate) ? new Date(it.pubDate).toISOString() : null,
      salary: min || max ? `${min && max && max > min ? `${n(min)} – ${n(max)}` : n(max || min)} ${it.salaryCurrency ?? 'USD'}${period ? ` ${period}` : ''}` : null,
      modality: 'remote',
      contract: /part/.test(types) ? 'parttime' : /intern/.test(types) ? 'internship' : /contract|freelance/.test(types) ? 'freelance' : null,
      text: `${it.jobTitle} ${stripHtml(String(it.jobDescription ?? it.jobExcerpt ?? ''))}`,
    });
    return { ...job, seniority: JOBICY_LEVEL[String(it.jobLevel ?? '').toLowerCase()] ?? job.seniority };
  });
}

// ───────────────────────── Relevance ─────────────────────────

// Strict: the role must be front-end by TITLE. Stack mentions don't count, and
// anything that also says back-end / full-stack / QA / DevOps is dropped.
const FRONT_RE = /front[\s-]?end|\bui\b|\bux\b|maquetador|\breact\b|\bvue(?:\.?js)?\b|\bangular\b|\bsvelte\b|\bnext\.?js\b|\bnuxt\b/i;
const NOT_FRONT_RE = /full[\s-]?stack|back[\s-]?end|\bqa\b|\btester\b|devops|\bsre\b|\bdatos?\b|\bdata\b/i;

/** Cheap local filter: portals return loosely related roles. */
export function isRelevant(job: Job, q: string): boolean {
  const hay = `${job.title} ${job.stack.join(' ')} ${job.url.split('/').pop()?.replace(/-/g, ' ') ?? ''}`;
  if (/front/i.test(q)) return FRONT_RE.test(job.title) && !NOT_FRONT_RE.test(job.title);
  const tokens = q.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  return tokens.length === 0 || tokens.some((t) => hay.toLowerCase().includes(t));
}
