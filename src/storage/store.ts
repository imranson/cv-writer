import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Critique } from '../cv/critique.ts';
import { sanitizeCvHtml } from '../cv/sanitize.ts';
import { DEFAULT_STYLE } from '../cv/styles.ts';
import type { ChatMessage } from '../llm/types.ts';
import { readJsonOptional, readOptional, writeAtomic, writeJson } from '../util/fs.ts';
import { assertValidId, makeId, shortId } from '../util/ids.ts';
import { hashText } from '../util/text.ts';

export interface JobRecord {
  id: string;
  title: string;
  company: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobSummary extends JobRecord {
  hasCv: boolean;
  cvUpdatedAt?: string;
  score?: number;
  verdict?: Critique['verdict'];
  /** True when the latest critique was made against an older version of the CV. */
  critiqueStale?: boolean;
}

export interface Job extends JobRecord {
  /** The job listing as unstructured markdown. */
  listing: string;
}

export interface CvVersion {
  id: string;
  createdAt: string;
  source: string;
  bytes: number;
}

export interface StoredMessage extends ChatMessage {
  id: string;
  at: string;
}

export interface ContextUsage {
  tokens: number;
  limit: number;
  /** True until the model has reported real token counts. */
  estimated: boolean;
}

export interface Session {
  id: string;
  title: string;
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
  /** Messages before this index have been compacted into `summary` and are not sent to the model. */
  contextStart: number;
  summary: string;
  context: ContextUsage;
}

export type SessionSummary = Omit<Session, 'messages' | 'summary'> & { messageCount: number };

const MAX_CV_VERSIONS = 40;
const MAX_CRITIQUES = 20;

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

const now = () => new Date().toISOString();

/**
 * File-backed persistence. Layout under the data directory:
 *   profile.md                      user profile + preferences (markdown)
 *   jobs/<id>/job.json              job metadata
 *   jobs/<id>/listing.md            job listing (markdown)
 *   jobs/<id>/cv.html               the CV for this job (body fragment)
 *   jobs/<id>/style.css             per-CV stylesheet
 *   jobs/<id>/critiques.json        critique history (latest last)
 *   jobs/<id>/versions/*.html       previous CV versions
 *   sessions/<id>.json              chat sessions
 */
export class Store {
  constructor(readonly root: string) {}

  private jobDir(id: string) {
    return path.join(this.root, 'jobs', assertValidId(id, 'job id'));
  }

  private sessionFile(id: string) {
    return path.join(this.root, 'sessions', `${assertValidId(id, 'session id')}.json`);
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.root, 'jobs'), { recursive: true });
    await mkdir(path.join(this.root, 'sessions'), { recursive: true });
  }

  // ── Profile ────────────────────────────────────────────────────────────

  async readProfile(): Promise<string> {
    return (await readOptional(path.join(this.root, 'profile.md'))) ?? '';
  }

  async writeProfile(markdown: string): Promise<void> {
    await writeAtomic(path.join(this.root, 'profile.md'), markdown.trimEnd() + '\n');
  }

  // ── Jobs ───────────────────────────────────────────────────────────────

  async createJob(input: { title: string; company: string; listing: string; url?: string }): Promise<Job> {
    const ts = now();
    const record: JobRecord = {
      id: makeId(input.company, input.title),
      title: input.title.trim(),
      company: input.company.trim(),
      url: input.url?.trim() || undefined,
      createdAt: ts,
      updatedAt: ts,
    };
    const dir = this.jobDir(record.id);
    await writeJson(path.join(dir, 'job.json'), record);
    await writeAtomic(path.join(dir, 'listing.md'), input.listing.trimEnd() + '\n');
    return { ...record, listing: input.listing.trimEnd() + '\n' };
  }

  async getJob(id: string): Promise<Job | null> {
    const dir = this.jobDir(id);
    const record = await readJsonOptional<JobRecord>(path.join(dir, 'job.json'));
    if (!record) return null;
    const listing = (await readOptional(path.join(dir, 'listing.md'))) ?? '';
    return { ...record, listing };
  }

  async requireJob(id: string): Promise<Job> {
    const job = await this.getJob(id);
    if (!job) throw new NotFoundError(`Job "${id}" not found`);
    return job;
  }

  async updateJob(id: string, patch: Partial<Pick<Job, 'title' | 'company' | 'listing' | 'url'>>): Promise<Job> {
    const job = await this.requireJob(id);
    const dir = this.jobDir(id);
    const record: JobRecord = {
      id,
      title: patch.title?.trim() || job.title,
      company: patch.company?.trim() || job.company,
      url: patch.url !== undefined ? patch.url.trim() || undefined : job.url,
      createdAt: job.createdAt,
      updatedAt: now(),
    };
    await writeJson(path.join(dir, 'job.json'), record);
    let listing = job.listing;
    if (patch.listing !== undefined) {
      listing = patch.listing.trimEnd() + '\n';
      await writeAtomic(path.join(dir, 'listing.md'), listing);
    }
    return { ...record, listing };
  }

  async deleteJob(id: string): Promise<void> {
    await this.requireJob(id);
    await rm(this.jobDir(id), { recursive: true, force: true });
  }

  async listJobs(): Promise<JobSummary[]> {
    const dir = path.join(this.root, 'jobs');
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const jobs: JobSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await readJsonOptional<JobRecord>(path.join(dir, entry.name, 'job.json'));
      if (!record) continue;
      const cv = await readOptional(path.join(dir, entry.name, 'cv.html'));
      const latest = (await this.readCritiques(record.id)).at(-1);
      const versions = cv ? await this.listCvVersions(record.id) : [];
      jobs.push({
        ...record,
        hasCv: Boolean(cv?.trim()),
        cvUpdatedAt: versions[0]?.createdAt,
        score: latest?.score,
        verdict: latest?.verdict,
        critiqueStale: latest && cv ? latest.cvHash !== hashText(cv) : undefined,
      });
    }
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ── CVs ────────────────────────────────────────────────────────────────

  async readCv(jobId: string): Promise<string | null> {
    return readOptional(path.join(this.jobDir(jobId), 'cv.html'));
  }

  /** Saves the CV (sanitised), keeping the previous content as a version. Returns the stored HTML. */
  async writeCv(jobId: string, html: string, source = 'writer'): Promise<string> {
    await this.requireJob(jobId);
    const dir = this.jobDir(jobId);
    const clean = sanitizeCvHtml(html) + '\n';
    const previous = await this.readCv(jobId);
    if (previous === clean) return clean;
    await writeAtomic(path.join(dir, 'cv.html'), clean);
    const stamp = now().replace(/[:.]/g, '-');
    const safeSource = source.replace(/[^a-z0-9]/gi, '').slice(0, 20) || 'edit';
    await writeAtomic(path.join(dir, 'versions', `${stamp}_${safeSource}_${shortId(4)}.html`), clean);
    await this.pruneVersions(jobId);
    if (!(await readOptional(path.join(dir, 'style.css')))) {
      await writeAtomic(path.join(dir, 'style.css'), DEFAULT_STYLE);
    }
    await this.touchJob(jobId);
    return clean;
  }

  async listCvVersions(jobId: string): Promise<CvVersion[]> {
    const dir = path.join(this.jobDir(jobId), 'versions');
    const files = await readdir(dir).catch(() => [] as string[]);
    const versions: CvVersion[] = [];
    for (const file of files) {
      const m = file.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_([a-z0-9]+)_[a-z0-9]+\.html$/i);
      if (!m?.[1] || !m[2]) continue;
      const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
      const { size } = await stat(path.join(dir, file));
      versions.push({ id: file.replace(/\.html$/, ''), createdAt: iso, source: m[2], bytes: size });
    }
    return versions.sort((a, b) => b.id.localeCompare(a.id));
  }

  async readCvVersion(jobId: string, versionId: string): Promise<string | null> {
    if (!/^[\w-]+$/.test(versionId)) return null;
    return readOptional(path.join(this.jobDir(jobId), 'versions', `${versionId}.html`));
  }

  async restoreCvVersion(jobId: string, versionId: string): Promise<string> {
    const html = await this.readCvVersion(jobId, versionId);
    if (html === null) throw new NotFoundError(`Version "${versionId}" not found`);
    return this.writeCv(jobId, html, 'restore');
  }

  private async pruneVersions(jobId: string) {
    const versions = await this.listCvVersions(jobId);
    for (const v of versions.slice(MAX_CV_VERSIONS)) {
      await rm(path.join(this.jobDir(jobId), 'versions', `${v.id}.html`), { force: true });
    }
  }

  private async touchJob(jobId: string) {
    const file = path.join(this.jobDir(jobId), 'job.json');
    const record = await readJsonOptional<JobRecord>(file);
    if (record) await writeJson(file, { ...record, updatedAt: now() });
  }

  // ── Styles ─────────────────────────────────────────────────────────────

  async readStyle(jobId: string): Promise<string> {
    return (await readOptional(path.join(this.jobDir(jobId), 'style.css'))) ?? DEFAULT_STYLE;
  }

  async writeStyle(jobId: string, css: string): Promise<void> {
    await this.requireJob(jobId);
    await writeAtomic(path.join(this.jobDir(jobId), 'style.css'), css);
  }

  // ── Critiques ──────────────────────────────────────────────────────────

  async readCritiques(jobId: string): Promise<Critique[]> {
    return (await readJsonOptional<Critique[]>(path.join(this.jobDir(jobId), 'critiques.json'))) ?? [];
  }

  async latestCritique(jobId: string): Promise<Critique | null> {
    return (await this.readCritiques(jobId)).at(-1) ?? null;
  }

  async addCritique(jobId: string, critique: Critique): Promise<void> {
    await this.requireJob(jobId);
    const all = [...(await this.readCritiques(jobId)), critique].slice(-MAX_CRITIQUES);
    await writeJson(path.join(this.jobDir(jobId), 'critiques.json'), all);
  }

  // ── Sessions ───────────────────────────────────────────────────────────

  async createSession(input: { jobId?: string | null; title?: string; contextLimit?: number } = {}): Promise<Session> {
    if (input.jobId) await this.requireJob(input.jobId);
    const ts = now();
    const session: Session = {
      id: makeId('chat'),
      title: input.title?.trim() || 'New conversation',
      jobId: input.jobId ?? null,
      createdAt: ts,
      updatedAt: ts,
      messages: [],
      contextStart: 0,
      summary: '',
      context: { tokens: 0, limit: input.contextLimit ?? 0, estimated: true },
    };
    await writeJson(this.sessionFile(session.id), session);
    return session;
  }

  async getSession(id: string): Promise<Session | null> {
    return readJsonOptional<Session>(this.sessionFile(id));
  }

  async requireSession(id: string): Promise<Session> {
    const session = await this.getSession(id);
    if (!session) throw new NotFoundError(`Session "${id}" not found`);
    return session;
  }

  async saveSession(session: Session): Promise<Session> {
    const saved = { ...session, updatedAt: now() };
    await writeJson(this.sessionFile(session.id), saved);
    return saved;
  }

  async deleteSession(id: string): Promise<void> {
    await this.requireSession(id);
    await rm(this.sessionFile(id), { force: true });
  }

  async listSessions(): Promise<SessionSummary[]> {
    const dir = path.join(this.root, 'sessions');
    const files = await readdir(dir).catch(() => [] as string[]);
    const out: SessionSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const s = await readJsonOptional<Session>(path.join(dir, file)).catch(() => null);
      if (!s) continue;
      const { messages, summary: _summary, ...rest } = s;
      out.push({ ...rest, messageCount: messages.length });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
