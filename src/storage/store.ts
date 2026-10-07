import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { emptyProfile } from '../domain/profile.js';
import {
  AgentRunSchema,
  AuditRecordSchema,
  CvVersionSchema,
  DEFAULT_STYLE,
  JobInputSchema,
  JobSchema,
  ProfileHistoryRecordSchema,
  ProfileSchema,
  SessionSchema,
  StyleSchema,
  type AgentRun,
  type AuditRecord,
  type CvVersion,
  type Job,
  type JobInput,
  type Profile,
  type ProfileHistoryRecord,
  type Session,
  type Style,
} from '../domain/schemas.js';
import { shortId, slugify, versionFile } from '../util/ids.js';

export class NotFoundError extends Error {}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * Plain JSON files under one data directory, so every profile change, job listing, CV iteration,
 * agent run and conversation can be inspected and audited by hand.
 */
export class Store {
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    readonly dataDir: string,
    private now: () => Date = () => new Date(),
  ) {}

  // ---------- plumbing ----------

  private p(...parts: string[]): string {
    return path.join(this.dataDir, ...parts);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /** Serialises read-modify-write sequences on one key. */
  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private async writeJson(file: string, data: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${shortId(4)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, file);
  }

  private async readJson<S extends z.ZodType>(file: string, schema: S): Promise<z.infer<S> | undefined> {
    try {
      return schema.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (err) {
      if (isMissing(err)) return undefined;
      throw new Error(`Could not read ${path.relative(this.dataDir, file)}: ${(err as Error).message}`);
    }
  }

  private async listDir(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).sort();
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  private async appendJsonl(file: string, record: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`);
  }

  private async readJsonl<S extends z.ZodType>(file: string, schema: S): Promise<Array<z.infer<S>>> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    const out: Array<z.infer<S>> = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  outputDir(jobId: string): string {
    return this.p('output', jobId);
  }

  // ---------- audit ----------

  async audit(record: Omit<AuditRecord, 'at'>): Promise<void> {
    await this.locked('audit', () => this.appendJsonl(this.p('audit.jsonl'), { at: this.stamp(), ...record }));
  }

  async readAudit(limit = 200): Promise<AuditRecord[]> {
    const all = await this.readJsonl(this.p('audit.jsonl'), AuditRecordSchema);
    return all.slice(-limit);
  }

  // ---------- profile ----------

  async getProfile(): Promise<Profile> {
    return (await this.readJson(this.p('profile.json'), ProfileSchema)) ?? emptyProfile(this.stamp());
  }

  /** Applies a change to the profile, bumps its revision and records a full snapshot in the history. */
  async updateProfile(params: {
    operation: string;
    actor: string;
    reason?: string;
    payload: unknown;
    apply: (profile: Profile) => Profile;
  }): Promise<Profile> {
    return this.locked('profile', async () => {
      const current = await this.getProfile();
      const at = this.stamp();
      const next = ProfileSchema.parse({ ...params.apply(current), revision: current.revision + 1, updatedAt: at });
      await this.writeJson(this.p('profile.json'), next);
      const record: ProfileHistoryRecord = {
        revision: next.revision,
        at,
        operation: params.operation,
        actor: params.actor,
        ...(params.reason ? { reason: params.reason } : {}),
        payload: params.payload,
        snapshot: next,
      };
      await this.appendJsonl(this.p('profile-history.jsonl'), record);
      return next;
    });
  }

  async profileHistory(): Promise<ProfileHistoryRecord[]> {
    return this.readJsonl(this.p('profile-history.jsonl'), ProfileHistoryRecordSchema);
  }

  // ---------- jobs ----------

  async saveJob(input: JobInput): Promise<Job> {
    const parsed = JobInputSchema.parse(input);
    const job: Job = {
      ...parsed,
      id: `${slugify(`${parsed.company} ${parsed.title}`)}-${shortId()}`,
      createdAt: this.stamp(),
    };
    await this.writeJson(this.p('jobs', `${job.id}.json`), job);
    return job;
  }

  async updateJob(id: string, patch: Partial<JobInput>): Promise<Job> {
    return this.locked(`job:${id}`, async () => {
      const job = await this.getJob(id);
      const next = JobSchema.parse({ ...job, ...patch, id: job.id, createdAt: job.createdAt });
      await this.writeJson(this.p('jobs', `${id}.json`), next);
      return next;
    });
  }

  async getJob(id: string): Promise<Job> {
    if (!/^[a-z0-9-]+$/.test(id)) throw new NotFoundError(`Unknown job "${id}"`);
    const job = await this.readJson(this.p('jobs', `${id}.json`), JobSchema);
    if (!job) throw new NotFoundError(`Unknown job "${id}"`);
    return job;
  }

  /** Newest first. Files that do not match the current schema are skipped. */
  async listJobs(): Promise<Job[]> {
    const jobs: Job[] = [];
    for (const file of await this.listDir(this.p('jobs'))) {
      if (!file.endsWith('.json')) continue;
      try {
        const job = await this.readJson(this.p('jobs', file), JobSchema);
        if (job) jobs.push(job);
      } catch {
        // written by an older version of the app
      }
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ---------- CV versions ----------

  private async versionNumbers(jobId: string): Promise<number[]> {
    return (await this.listDir(this.p('cvs', jobId)))
      .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  /** Saves a new iteration; version numbers never repeat, even across app versions. */
  async addCvVersion(input: Omit<CvVersion, 'version' | 'createdAt' | 'status' | 'critiques' | 'exports'>): Promise<CvVersion> {
    return this.locked(`cvs:${input.jobId}`, async () => {
      await this.getJob(input.jobId);
      const numbers = await this.versionNumbers(input.jobId);
      const version = (numbers.at(-1) ?? 0) + 1;
      const cv = CvVersionSchema.parse({ ...input, version, createdAt: this.stamp(), status: 'draft', critiques: [], exports: [] });
      await this.writeJson(this.p('cvs', input.jobId, versionFile(version)), cv);
      return cv;
    });
  }

  async getCvVersion(jobId: string, version: number): Promise<CvVersion> {
    if (!/^[a-z0-9-]+$/.test(jobId) || !Number.isInteger(version)) throw new NotFoundError(`Unknown CV ${jobId} v${version}`);
    let cv: CvVersion | undefined;
    try {
      cv = await this.readJson(this.p('cvs', jobId, versionFile(version)), CvVersionSchema);
    } catch {
      throw new NotFoundError(`CV v${version} for ${jobId} was written by an older version of the app and cannot be opened`);
    }
    if (!cv) throw new NotFoundError(`No CV version ${version} for job ${jobId}`);
    return cv;
  }

  async updateCvVersion(jobId: string, version: number, apply: (cv: CvVersion) => CvVersion): Promise<CvVersion> {
    return this.locked(`cvs:${jobId}`, async () => {
      const cv = await this.getCvVersion(jobId, version);
      const next = CvVersionSchema.parse({ ...apply(cv), jobId, version });
      await this.writeJson(this.p('cvs', jobId, versionFile(version)), next);
      return next;
    });
  }

  /** Oldest first; versions from older app versions are skipped. */
  async listCvVersions(jobId: string): Promise<CvVersion[]> {
    const out: CvVersion[] = [];
    for (const n of await this.versionNumbers(jobId)) {
      try {
        out.push(await this.getCvVersion(jobId, n));
      } catch {
        // skipped
      }
    }
    return out;
  }

  // ---------- agent runs ----------

  async saveRun(run: AgentRun): Promise<void> {
    await this.writeJson(this.p('runs', `${run.id}.json`), AgentRunSchema.parse(run));
  }

  async getRun(id: string): Promise<AgentRun> {
    if (!/^[a-z0-9-]+$/.test(id)) throw new NotFoundError(`Unknown run "${id}"`);
    const run = await this.readJson(this.p('runs', `${id}.json`), AgentRunSchema);
    if (!run) throw new NotFoundError(`Unknown run "${id}"`);
    return run;
  }

  // ---------- sessions ----------

  async createSession(activeJobId?: string): Promise<Session> {
    const at = this.stamp();
    const session: Session = {
      id: `session-${at.replace(/[-:T]/g, '').slice(0, 12)}-${shortId()}`,
      createdAt: at,
      updatedAt: at,
      ...(activeJobId ? { activeJobId } : {}),
      messages: [],
      transcript: [],
      usage: { promptTokens: 0, outputTokens: 0, calls: 0 },
    };
    await this.saveSession(session);
    return session;
  }

  async saveSession(session: Session): Promise<Session> {
    const next = { ...session, updatedAt: this.stamp() };
    await this.writeJson(this.p('sessions', `${session.id}.json`), SessionSchema.parse(next));
    return next;
  }

  async getSession(id: string): Promise<Session> {
    if (!/^[a-z0-9-]+$/.test(id)) throw new NotFoundError(`Unknown session "${id}"`);
    let session: Session | undefined;
    try {
      session = await this.readJson(this.p('sessions', `${id}.json`), SessionSchema);
    } catch {
      throw new NotFoundError(`Session ${id} was written by an older version of the app`);
    }
    if (!session) throw new NotFoundError(`Unknown session "${id}"`);
    return session;
  }

  /** Newest first, without message bodies. */
  async listSessions(): Promise<Array<{ id: string; createdAt: string; updatedAt: string; turns: number; preview: string }>> {
    const out = [];
    for (const file of await this.listDir(this.p('sessions'))) {
      if (!file.endsWith('.json')) continue;
      try {
        const s = await this.getSession(file.slice(0, -5));
        const firstUser = s.transcript.find((t) => t.role === 'user');
        out.push({
          id: s.id,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          turns: s.transcript.filter((t) => t.role === 'user').length,
          preview: firstUser?.text.slice(0, 80) ?? '',
        });
      } catch {
        // older format
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ---------- style ----------

  async getStyle(): Promise<Style> {
    try {
      return (await this.readJson(this.p('style.json'), StyleSchema)) ?? DEFAULT_STYLE;
    } catch {
      return DEFAULT_STYLE;
    }
  }

  async setStyle(style: Style): Promise<Style> {
    const parsed = StyleSchema.parse(style);
    await this.writeJson(this.p('style.json'), parsed);
    return parsed;
  }
}
