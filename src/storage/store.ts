import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { slugify } from '../cv/export.js';
import { emptyProfile } from '../domain/profile.js';
import {
  AuditEventSchema,
  CvVersionSchema,
  JobListingInputSchema,
  JobListingSchema,
  ProfileHistoryRecordSchema,
  ProfileSchema,
  SessionSchema,
  WriterRunSchema,
  type AuditEvent,
  type CvExports,
  type CvVersion,
  type JobListing,
  type JobListingInput,
  type Profile,
  type ProfileHistoryRecord,
  type Session,
  type WriterRun,
} from '../domain/schemas.js';

export interface StoreOptions {
  now?: () => Date;
  randomId?: () => string;
}

export type NewCvVersion = Omit<CvVersion, 'version' | 'createdAt' | 'status' | 'approvedAt' | 'exports'>;

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

export function assertSafeId(id: string, kind: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid ${kind} id "${id}"`);
}

/**
 * File-backed store. Everything is plain JSON so it can be inspected and audited by hand:
 *
 *   profile.json              current profile
 *   profile-history.jsonl     every profile change with a full snapshot
 *   jobs/<jobId>.json         job listings
 *   cvs/<jobId>/v001.json     every generated CV iteration
 *   output/<jobId>/           approved, submission-ready exports
 *   sessions/<id>.json        coordinator conversations (for resuming and review)
 *   writer-runs/<id>.json     every cv-writer run: its brief, transcript and the versions it saved
 *   audit.jsonl               every state-changing tool call made by the agents
 */
export class CvStore {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly root: string,
    options: StoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => randomUUID().slice(0, 6));
  }

  get outputDir(): string {
    return path.join(this.root, 'output');
  }

  newId(prefix: string): string {
    return `${prefix}-${this.randomId()}`;
  }

  /** The store's clock as an ISO string, so records built elsewhere share its timeline. */
  timestamp(): string {
    return this.now().toISOString();
  }

  // ---------- profile ----------

  async getProfile(): Promise<Profile> {
    return (await this.readJson(this.file('profile.json'), ProfileSchema)) ?? emptyProfile(this.now());
  }

  /**
   * Applies a change under the store lock, bumps the revision and records a
   * full snapshot in the history so any CV can be traced to the exact profile it used.
   */
  updateProfile(operation: string, payload: unknown, mutate: (p: Profile) => Profile): Promise<Profile> {
    return this.exclusive(async () => {
      const current = await this.getProfile();
      const next = ProfileSchema.parse({
        ...mutate(current),
        revision: current.revision + 1,
        updatedAt: this.now().toISOString(),
      });
      await this.writeJson(this.file('profile.json'), next);
      const record: ProfileHistoryRecord = { revision: next.revision, at: next.updatedAt, operation, payload, snapshot: next };
      await this.appendLine(this.file('profile-history.jsonl'), record);
      return next;
    });
  }

  async profileHistory(): Promise<ProfileHistoryRecord[]> {
    return this.readLines(this.file('profile-history.jsonl'), ProfileHistoryRecordSchema);
  }

  async getProfileAtRevision(revision: number): Promise<Profile | undefined> {
    if (revision === 0) return emptyProfile(this.now());
    return (await this.profileHistory()).find((r) => r.revision === revision)?.snapshot;
  }

  // ---------- jobs ----------

  saveJob(input: JobListingInput): Promise<JobListing> {
    return this.exclusive(async () => {
      const parsed = JobListingInputSchema.parse(input);
      const id = `${slugify(`${parsed.company}-${parsed.title}`).slice(0, 50)}-${this.randomId()}`.replace(/-+/g, '-');
      const job = JobListingSchema.parse({ ...parsed, id, createdAt: this.now().toISOString() });
      await this.writeJson(this.file('jobs', `${id}.json`), job);
      return job;
    });
  }

  async getJob(jobId: string): Promise<JobListing | undefined> {
    assertSafeId(jobId, 'job');
    return this.readJson(this.file('jobs', `${jobId}.json`), JobListingSchema);
  }

  async listJobs(): Promise<JobListing[]> {
    const jobs = await this.readDir(this.file('jobs'), JobListingSchema);
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---------- CV versions ----------

  saveCvVersion(input: NewCvVersion): Promise<CvVersion> {
    return this.exclusive(async () => {
      assertSafeId(input.jobId, 'job');
      const existing = await this.listCvVersions(input.jobId);
      const version = CvVersionSchema.parse({
        ...input,
        version: (existing.at(-1)?.version ?? 0) + 1,
        createdAt: this.now().toISOString(),
        status: 'draft',
      });
      await this.writeJson(this.cvFile(input.jobId, version.version), version);
      return version;
    });
  }

  async getCvVersion(jobId: string, version?: number): Promise<CvVersion | undefined> {
    assertSafeId(jobId, 'job');
    if (version === undefined) return (await this.listCvVersions(jobId)).at(-1);
    return this.readJson(this.cvFile(jobId, version), CvVersionSchema);
  }

  async listCvVersions(jobId: string): Promise<CvVersion[]> {
    assertSafeId(jobId, 'job');
    const versions = await this.readDir(this.file('cvs', jobId), CvVersionSchema);
    return versions.sort((a, b) => a.version - b.version);
  }

  approveCvVersion(jobId: string, version: number, exports: CvExports): Promise<CvVersion> {
    return this.exclusive(async () => {
      const cv = await this.getCvVersion(jobId, version);
      if (!cv) throw new Error(`No CV version ${version} for job "${jobId}"`);
      const approved = CvVersionSchema.parse({ ...cv, status: 'approved', approvedAt: this.now().toISOString(), exports });
      await this.writeJson(this.cvFile(jobId, version), approved);
      return approved;
    });
  }

  // ---------- conversations ----------

  saveSession(session: Session): Promise<Session> {
    return this.exclusive(async () => {
      assertSafeId(session.id, 'session');
      const parsed = SessionSchema.parse(session);
      await this.writeJson(this.file('sessions', `${session.id}.json`), parsed);
      return parsed;
    });
  }

  async getSession(id: string): Promise<Session | undefined> {
    assertSafeId(id, 'session');
    return this.readJson(this.file('sessions', `${id}.json`), SessionSchema);
  }

  /** The most recently updated conversation. */
  async latestSession(): Promise<Session | undefined> {
    const sessions = await this.readDir(this.file('sessions'), SessionSchema);
    return sessions.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
  }

  saveWriterRun(run: WriterRun): Promise<WriterRun> {
    return this.exclusive(async () => {
      assertSafeId(run.id, 'writer run');
      const parsed = WriterRunSchema.parse(run);
      await this.writeJson(this.file('writer-runs', `${run.id}.json`), parsed);
      return parsed;
    });
  }

  async getWriterRun(id: string): Promise<WriterRun | undefined> {
    assertSafeId(id, 'writer run');
    return this.readJson(this.file('writer-runs', `${id}.json`), WriterRunSchema);
  }

  async listWriterRuns(jobId?: string): Promise<WriterRun[]> {
    const runs = await this.readDir(this.file('writer-runs'), WriterRunSchema);
    return runs.filter((r) => !jobId || r.jobId === jobId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  // ---------- audit ----------

  audit(event: Omit<AuditEvent, 'at'>): Promise<void> {
    return this.exclusive(() =>
      this.appendLine(this.file('audit.jsonl'), { at: this.now().toISOString(), ...event }),
    );
  }

  async readAudit(): Promise<AuditEvent[]> {
    return this.readLines(this.file('audit.jsonl'), AuditEventSchema);
  }

  // ---------- internals ----------

  private file(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  private cvFile(jobId: string, version: number): string {
    return this.file('cvs', jobId, `v${String(version).padStart(3, '0')}.json`);
  }

  /** Serialises writes so concurrent tool calls cannot lose updates. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
    await rename(tmp, file);
  }

  private async appendLine(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(value) + '\n');
  }

  private async readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const text = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });
    return text === undefined ? undefined : schema.parse(JSON.parse(text));
  }

  private async readLines<T>(file: string, schema: z.ZodType<T>): Promise<T[]> {
    const text = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => schema.parse(JSON.parse(line)));
  }

  private async readDir<T>(dir: string, schema: z.ZodType<T>): Promise<T[]> {
    const names = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[];
      throw err;
    });
    const items = await Promise.all(
      names.filter((n) => n.endsWith('.json')).map((n) => this.readJson(path.join(dir, n), schema)),
    );
    return items.filter((i): i is Awaited<T> => i !== undefined);
  }
}
