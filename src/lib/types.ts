export const COUNTRIES = {
  MX: 'México',
  CO: 'Colombia',
  AR: 'Argentina',
  CL: 'Chile',
  PE: 'Perú',
  WW: 'Remoto global',
} as const;
export type CountryCode = keyof typeof COUNTRIES;

export const SOURCES = ['computrabajo', 'elempleo', 'getonboard', 'remoteok', 'jobicy'] as const;
export type Source = (typeof SOURCES)[number];

/** Which portal covers which country. */
export const SOURCE_COUNTRIES: Record<Source, CountryCode[]> = {
  computrabajo: ['MX', 'CO', 'AR', 'CL', 'PE'],
  elempleo: ['CO'],
  getonboard: ['MX', 'CO', 'AR', 'CL', 'PE'],
  remoteok: ['WW'],
  jobicy: ['WW'],
};

export const MODALITIES = { remote: 'Remoto', hybrid: 'Híbrido', onsite: 'Presencial' } as const;
export type Modality = keyof typeof MODALITIES;

export const CONTRACTS = {
  permanent: 'Indefinido',
  fixed: 'Temporal',
  freelance: 'Freelance',
  internship: 'Prácticas',
  parttime: 'Media jornada',
} as const;
export type Contract = keyof typeof CONTRACTS;

export const LANGUAGES = { es: 'Español', en: 'English' } as const;
export type Language = keyof typeof LANGUAGES;

export const SENIORITIES = { junior: 'Junior', mid: 'Semi-senior', senior: 'Senior' } as const;
export type Seniority = keyof typeof SENIORITIES;

export interface Job {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  country: CountryCode;
  source: Source;
  url: string;
  postedAt: string | null; // ISO
  salary: string | null; // display text
  modality: Modality | null;
  contract: Contract | null;
  seniority: Seniority | null;
  language: Language | null;
  stack: string[];
  redFlags: string[];
  /** Offer text (truncated) used to tailor a CV. */
  description?: string;
  /** Server-only snippet used for AI enrichment; stripped before responding. */
  blurb?: string;
}

export interface SearchResponse {
  source: Source;
  country: CountryCode;
  jobs: Job[];
  cached: boolean;
  ai: boolean;
  note?: string;
}
