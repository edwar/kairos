import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiEnabled, enrichWithGroq } from '../../lib/groq.ts';
import { fetchComputrabajo, fetchElempleo, fetchGetOnBoard, fetchJobicy, fetchRemoteOk, isRelevant } from '../../lib/sources.ts';
import {
  COUNTRIES, SOURCES, SOURCE_COUNTRIES,
  type CountryCode, type Job, type SearchResponse, type Source,
} from '../../lib/types.ts';

export const prerender = false;

const TTL = Number(import.meta.env?.CACHE_TTL_MIN ?? process.env.CACHE_TTL_MIN ?? 30) * 60_000; // same search within the TTL is served from cache
// Bump when filtering/extraction logic changes so stale cached results are ignored.
const CACHE_VERSION = 11;
// Vercel's filesystem is read-only except /tmp (ephemeral per instance); locally it persists in .cache/.
const CACHE_DIR = process.env.VERCEL ? join(tmpdir(), 'kairos-search') : join(process.cwd(), '.cache', 'search');
const cache = new Map<string, { at: number; jobs: Job[] }>(); // memory layer in front of the disk cache
const inflight = new Map<string, Promise<Job[]>>();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fileFor = (key: string) => join(CACHE_DIR, `${createHash('sha1').update(key).digest('hex')}.json`);

async function readCache(key: string): Promise<{ at: number; jobs: Job[] } | null> {
  const mem = cache.get(key);
  if (mem) return mem;
  try {
    const entry = JSON.parse(await readFile(fileFor(key), 'utf8'));
    if (entry?.v !== CACHE_VERSION || !Array.isArray(entry.jobs)) return null;
    cache.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

async function writeCache(key: string, jobs: Job[]) {
  const entry = { v: CACHE_VERSION, at: Date.now(), jobs };
  cache.set(key, entry);
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(fileFor(key), JSON.stringify(entry));
  } catch (err) {
    console.warn(`[cache] no se pudo escribir en disco: ${(err as Error).message}`);
  }
}

async function load(source: Source, country: CountryCode, q: string, days: number): Promise<Job[]> {
  const raw =
    source === 'computrabajo' ? await fetchComputrabajo(q, country, days)
    : source === 'elempleo' ? await fetchElempleo(q)
    : source === 'getonboard' ? await fetchGetOnBoard(q, country)
    : source === 'jobicy' ? await fetchJobicy(q)
    : await fetchRemoteOk();

  const cutoff = Date.now() - days * 86_400_000;
  const seen = new Set<string>();
  const kept = raw.filter((j) => {
    if (!j.url || !isRelevant(j, q)) return false;
    if (j.postedAt && new Date(j.postedAt).getTime() < cutoff) return false;
    const k = `${j.title}|${j.company}|${j.location}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const enriched = await enrichWithGroq(kept);
  return enriched.map(({ blurb, ...job }) => job);
}

export const GET: APIRoute = async ({ url }) => {
  const source = url.searchParams.get('source') as Source;
  const country = url.searchParams.get('country') as CountryCode;
  const q = (url.searchParams.get('q') ?? 'frontend').trim().slice(0, 60) || 'frontend';
  const days = [1, 7, 15, 30].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 7;

  if (!SOURCES.includes(source) || !(country in COUNTRIES) || !SOURCE_COUNTRIES[source].includes(country)) {
    return json({ error: 'source/country inválidos' }, 400);
  }

  // Global remote feeds (RemoteOK, Jobicy) ask for fair use and ignore `days`: long TTL, shared key.
  const feed = source === 'remoteok' || source === 'jobicy'; // global feeds: don't depend on `days`
  const ttl = feed ? Math.max(TTL, 6 * 3_600_000) : TTL;
  const key = [source, country, source === 'remoteok' ? 'all' : q.toLowerCase(), feed ? 'all' : days].join('|');
  const hit = await readCache(key);
  let cached = false;
  let jobs: Job[];
  if (hit && Date.now() - hit.at < ttl) {
    jobs = hit.jobs;
    cached = true;
  } else {
    try {
      let p = inflight.get(key);
      if (!p) {
        p = load(source, country, q, days).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      jobs = await p;
      await writeCache(key, jobs);
    } catch (err) {
      return json({ error: (err as Error).message }, 502);
    }
  }

  const body: SearchResponse = { source, country, jobs, cached, ai: aiEnabled() };
  return json(body);
};
