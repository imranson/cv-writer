import path from 'node:path';
import { DEFAULT_CV_CSS } from '../cv/defaultStyle.js';
import { htmlToText } from '../lib/html.js';
import { assertValidId, newId } from '../lib/ids.js';
import { applyJsonOps, type JsonOp } from '../lib/jsonOps.js';
import { rankDocuments, type SearchHit } from '../lib/search.js';
import { applyTextEdits, type TextEdit } from '../lib/textEdit.js';
import { jsonStore, textStore, type FileStore, type JsonDoc } from './fileStore.js';

/** Each data type lives in its own directory under the data root. */
export const DATA_DIRS = {
  profiles: 'profiles',
  jobs: 'jobs',
  cvs: 'cvs',
  cvPreferences: 'cv-preferences',
  cvStyles: 'cv-styles',
  sessions: 'sessions',
} as const;

export interface Summary {
  id: string;
  title: string;
  updatedAt?: string;
}

export interface CvRecord {
  jobId: string;
  exists: boolean;
  html: string;
  css: string;
  preferences: JsonDoc;
  updatedAt?: string;
}

export interface CvEdits {
  htmlEdits?: TextEdit[];
  cssEdits?: TextEdit[];
  preferenceOps?: JsonOp[];
}

const METADATA_KEYS = ['id', 'createdAt', 'updatedAt'];

/** Collects every string/number leaf so keyword search ignores JSON keys and syntax. */
export function flattenText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    return Object.entries(value as JsonDoc)
      .filter(([k]) => !METADATA_KEYS.includes(k))
      .map(([, v]) => flattenText(v))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function profileTitle(doc: JsonDoc): string {
  const basics = (doc.basics ?? doc.contact ?? {}) as JsonDoc;
  return str(doc.name) ?? str(doc.fullName) ?? str(basics.name) ?? String(doc.id ?? 'Unnamed profile');
}

export function jobTitle(doc: JsonDoc): string {
  const title = str(doc.title) ?? str(doc.role) ?? str(doc.position) ?? 'Untitled job';
  const company = str(doc.company) ?? str(doc.employer) ?? str(doc.organisation) ?? str(doc.organization);
  return company ? `${title} @ ${company}` : title;
}

function stamp(id: string, data: JsonDoc, previous: JsonDoc | undefined, extra: JsonDoc = {}): JsonDoc {
  const now = new Date().toISOString();
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = data;
  return { id, ...extra, ...rest, createdAt: previous?.createdAt ?? now, updatedAt: now };
}

export class Workspace {
  readonly profiles: FileStore<JsonDoc>;
  readonly jobs: FileStore<JsonDoc>;
  readonly cvs: FileStore<string>;
  readonly cvPreferences: FileStore<JsonDoc>;
  readonly cvStyles: FileStore<string>;
  readonly sessions: FileStore<JsonDoc>;

  constructor(readonly dataDir: string) {
    const dir = (name: string) => path.join(dataDir, name);
    this.profiles = jsonStore(dir(DATA_DIRS.profiles));
    this.jobs = jsonStore(dir(DATA_DIRS.jobs));
    this.cvs = textStore(dir(DATA_DIRS.cvs), '.html');
    this.cvPreferences = jsonStore(dir(DATA_DIRS.cvPreferences));
    this.cvStyles = textStore(dir(DATA_DIRS.cvStyles), '.css');
    this.sessions = jsonStore(dir(DATA_DIRS.sessions));
  }

  // ---- profiles ----

  async listProfiles(): Promise<Summary[]> {
    const out: Summary[] = [];
    for (const id of await this.profiles.list()) {
      const doc = await this.profiles.read(id);
      if (doc) out.push({ id, title: profileTitle(doc), updatedAt: str(doc.updatedAt) });
    }
    return out;
  }

  async getProfile(id: string): Promise<JsonDoc | undefined> {
    return this.profiles.read(id);
  }

  async saveProfile(id: string | undefined, data: JsonDoc): Promise<JsonDoc> {
    const profileId = id ?? newId('profile', profileTitle(data) === 'Unnamed profile' ? undefined : profileTitle(data));
    assertValidId(profileId, 'profileId');
    const doc = stamp(profileId, data, await this.profiles.read(profileId));
    await this.profiles.write(profileId, doc);
    return doc;
  }

  async editProfile(id: string, ops: JsonOp[]): Promise<JsonDoc> {
    const existing = await this.profiles.read(id);
    if (!existing) throw new Error(`Profile "${id}" not found`);
    return this.saveProfile(id, applyJsonOps(existing, ops));
  }

  // ---- jobs ----

  async listJobs(profileId?: string): Promise<(Summary & { profileId?: string; hasCv: boolean })[]> {
    const out = [];
    for (const id of await this.jobs.list()) {
      const doc = await this.jobs.read(id);
      if (!doc) continue;
      if (profileId && doc.profileId !== profileId) continue;
      out.push({
        id,
        title: jobTitle(doc),
        profileId: str(doc.profileId),
        updatedAt: str(doc.updatedAt),
        hasCv: await this.cvs.exists(id),
      });
    }
    return out;
  }

  async getJob(id: string): Promise<JsonDoc | undefined> {
    return this.jobs.read(id);
  }

  async saveJob(id: string | undefined, profileId: string | undefined, data: JsonDoc): Promise<JsonDoc> {
    const jobId = id ?? newId('job', jobTitle(data) === 'Untitled job' ? undefined : jobTitle(data).replace(' @ ', ' '));
    assertValidId(jobId, 'jobId');
    const previous = await this.jobs.read(jobId);
    const owner = profileId ?? str(data.profileId) ?? str(previous?.profileId);
    const doc = stamp(jobId, data, previous, owner ? { profileId: owner } : {});
    await this.jobs.write(jobId, doc);
    return doc;
  }

  async editJob(id: string, ops: JsonOp[]): Promise<JsonDoc> {
    const existing = await this.jobs.read(id);
    if (!existing) throw new Error(`Job "${id}" not found`);
    return this.saveJob(id, undefined, applyJsonOps(existing, ops));
  }

  async searchJobs(query: string, options: { profileId?: string; limit?: number } = {}): Promise<(SearchHit & { title: string })[]> {
    const docs: { id: string; text: string; title: string }[] = [];
    for (const id of await this.jobs.list()) {
      const doc = await this.jobs.read(id);
      if (!doc || (options.profileId && doc.profileId !== options.profileId)) continue;
      docs.push({ id, text: flattenText(doc), title: jobTitle(doc) });
    }
    const titles = new Map(docs.map((d) => [d.id, d.title]));
    return rankDocuments(query, docs, options.limit).map((hit) => ({ ...hit, title: titles.get(hit.id)! }));
  }

  // ---- CVs (HTML + per-CV preferences + CSS, all keyed by job id: 1 job -> 1 CV) ----

  async getCv(jobId: string): Promise<CvRecord> {
    assertValidId(jobId, 'jobId');
    const [html, css, preferences, modified] = await Promise.all([
      this.cvs.read(jobId),
      this.cvStyles.read(jobId),
      this.cvPreferences.read(jobId),
      this.cvs.modifiedAt(jobId),
    ]);
    return {
      jobId,
      exists: html !== undefined,
      html: html ?? '',
      css: css ?? DEFAULT_CV_CSS,
      preferences: preferences ?? {},
      updatedAt: modified?.toISOString(),
    };
  }

  async saveCv(jobId: string, parts: { html?: string; css?: string; preferences?: JsonDoc }): Promise<CvRecord> {
    assertValidId(jobId, 'jobId');
    if (parts.html === undefined && parts.css === undefined && parts.preferences === undefined) {
      throw new Error('Nothing to write: provide html, css and/or preferences');
    }
    if (parts.html !== undefined) await this.cvs.write(jobId, parts.html);
    if (parts.css !== undefined) await this.cvStyles.write(jobId, parts.css);
    else if (!(await this.cvStyles.exists(jobId))) await this.cvStyles.write(jobId, DEFAULT_CV_CSS);
    if (parts.preferences !== undefined) await this.cvPreferences.write(jobId, parts.preferences);
    return this.getCv(jobId);
  }

  async editCv(jobId: string, edits: CvEdits): Promise<CvRecord> {
    const current = await this.getCv(jobId);
    const parts: { html?: string; css?: string; preferences?: JsonDoc } = {};
    if (edits.htmlEdits?.length) {
      if (!current.exists) throw new Error(`No CV exists for job "${jobId}" yet; use writeCV first`);
      parts.html = applyTextEdits(current.html, edits.htmlEdits);
    }
    if (edits.cssEdits?.length) parts.css = applyTextEdits(current.css, edits.cssEdits);
    if (edits.preferenceOps?.length) parts.preferences = applyJsonOps(current.preferences, edits.preferenceOps);
    return this.saveCv(jobId, parts);
  }

  async listCvs(): Promise<Summary[]> {
    const out: Summary[] = [];
    for (const id of await this.cvs.list()) {
      const job = await this.jobs.read(id);
      out.push({ id, title: job ? jobTitle(job) : id, updatedAt: (await this.cvs.modifiedAt(id))?.toISOString() });
    }
    return out;
  }

  async searchCvs(query: string, limit?: number): Promise<(SearchHit & { title: string })[]> {
    const docs: { id: string; text: string }[] = [];
    for (const id of await this.cvs.list()) {
      const html = (await this.cvs.read(id)) ?? '';
      const prefs = (await this.cvPreferences.read(id)) ?? {};
      docs.push({ id, text: `${htmlToText(html)}\n${flattenText(prefs)}` });
    }
    const hits = rankDocuments(query, docs, limit);
    const titled = [];
    for (const hit of hits) {
      const job = await this.jobs.read(hit.id);
      titled.push({ ...hit, title: job ? jobTitle(job) : hit.id });
    }
    return titled;
  }
}
