import path from 'node:path';
import { customAlphabet } from 'nanoid';
import { assertId, listIds, readJson, readText, removeFile, writeFileAtomic, writeJson } from './fs';
import {
  DEFAULT_CSS,
  DEFAULT_CV_HTML,
  DEFAULT_PREFERENCES,
  DEFAULT_PROFILE,
  type ChatSession,
  type CvPreferences,
  type Job,
  type JobSummary,
  type Profile,
  type SessionSummary,
  type User,
} from './types';

export * from './types';

export const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

/** Every data type lives in its own top-level directory, partitioned by user. */
export const DATA_DIRS = {
  users: 'users',
  profiles: 'profiles',
  jobs: 'jobs',
  cvs: 'cvs',
  preferences: 'preferences',
  styles: 'styles',
  sessions: 'sessions',
} as const;

const now = () => new Date().toISOString();

export class Store {
  constructor(readonly root: string) {}

  private dir(kind: keyof typeof DATA_DIRS, userId?: string): string {
    return userId ? path.join(this.root, DATA_DIRS[kind], assertId(userId, 'user id')) : path.join(this.root, DATA_DIRS[kind]);
  }

  // ---- users -------------------------------------------------------------

  async createUser(input: { email: string; name: string; passwordHash: string }): Promise<User> {
    const email = input.email.trim().toLowerCase();
    if (await this.findUserByEmail(email)) throw new Error('An account with this email already exists');
    const user: User = { id: newId(), email, name: input.name.trim(), passwordHash: input.passwordHash, createdAt: now() };
    await writeJson(path.join(this.dir('users'), `${user.id}.json`), user);
    return user;
  }

  async getUser(id: string): Promise<User | undefined> {
    return readJson<User>(path.join(this.dir('users'), `${assertId(id, 'user id')}.json`));
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    const target = email.trim().toLowerCase();
    for (const id of await listIds(this.dir('users'), '.json')) {
      const user = await this.getUser(id);
      if (user?.email === target) return user;
    }
    return undefined;
  }

  // ---- profile (1 per user) ---------------------------------------------

  async getProfile(userId: string): Promise<Profile> {
    const file = path.join(this.dir('profiles'), `${assertId(userId, 'user id')}.json`);
    return (await readJson<Profile>(file)) ?? structuredClone(DEFAULT_PROFILE);
  }

  async saveProfile(userId: string, profile: Profile): Promise<Profile> {
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error('Profile must be a JSON object');
    }
    await writeJson(path.join(this.dir('profiles'), `${assertId(userId, 'user id')}.json`), profile);
    return profile;
  }

  // ---- jobs (N per user) -------------------------------------------------

  private jobFile(userId: string, jobId: string) {
    return path.join(this.dir('jobs', userId), `${assertId(jobId, 'job id')}.json`);
  }

  async listJobs(userId: string): Promise<JobSummary[]> {
    const jobs: JobSummary[] = [];
    for (const id of await listIds(this.dir('jobs', userId), '.json')) {
      const job = await this.getJob(userId, id);
      if (job) jobs.push({ id: job.id, title: job.title, company: job.company, status: job.status, updatedAt: job.updatedAt });
    }
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getJob(userId: string, jobId: string): Promise<Job | undefined> {
    return readJson<Job>(this.jobFile(userId, jobId));
  }

  /** Creates a job and its 1:1 CV, preferences and stylesheet. */
  async createJob(userId: string, input: Partial<Job>): Promise<Job> {
    const { id: _ignored, createdAt: _c, updatedAt: _u, ...rest } = input;
    const job: Job = {
      ...rest,
      id: newId(),
      title: input.title?.trim() || 'Untitled role',
      company: input.company?.trim() || '',
      status: input.status || 'draft',
      createdAt: now(),
      updatedAt: now(),
    };
    await writeJson(this.jobFile(userId, job.id), job);
    await this.saveCv(userId, job.id, DEFAULT_CV_HTML);
    await this.savePreferences(userId, job.id, structuredClone(DEFAULT_PREFERENCES));
    await this.saveCss(userId, job.id, DEFAULT_CSS);
    return job;
  }

  async updateJob(userId: string, jobId: string, patch: Partial<Job>): Promise<Job> {
    const job = await this.requireJob(userId, jobId);
    const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = patch;
    const next: Job = { ...job, ...rest, id: job.id, createdAt: job.createdAt, updatedAt: now() };
    await writeJson(this.jobFile(userId, jobId), next);
    return next;
  }

  async replaceJob(userId: string, jobId: string, value: Partial<Job>): Promise<Job> {
    const job = await this.requireJob(userId, jobId);
    const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = value;
    const next: Job = { title: '', company: '', ...rest, id: job.id, createdAt: job.createdAt, updatedAt: now() };
    await writeJson(this.jobFile(userId, jobId), next);
    return next;
  }

  /** Deletes the job and cascades to its CV, preferences and stylesheet. */
  async deleteJob(userId: string, jobId: string): Promise<boolean> {
    const existed = await removeFile(this.jobFile(userId, jobId));
    await removeFile(this.cvFile(userId, jobId));
    await removeFile(this.prefsFile(userId, jobId));
    await removeFile(this.cssFile(userId, jobId));
    return existed;
  }

  async requireJob(userId: string, jobId: string): Promise<Job> {
    const job = await this.getJob(userId, jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    return job;
  }

  private async touchJob(userId: string, jobId: string) {
    const job = await this.getJob(userId, jobId);
    if (job) await writeJson(this.jobFile(userId, jobId), { ...job, updatedAt: now() });
  }

  // ---- CV (1 per job), preferences (1 per CV), CSS (1 per CV) -----------

  private cvFile(userId: string, jobId: string) {
    return path.join(this.dir('cvs', userId), `${assertId(jobId, 'job id')}.html`);
  }
  private prefsFile(userId: string, jobId: string) {
    return path.join(this.dir('preferences', userId), `${assertId(jobId, 'job id')}.json`);
  }
  private cssFile(userId: string, jobId: string) {
    return path.join(this.dir('styles', userId), `${assertId(jobId, 'job id')}.css`);
  }

  async getCv(userId: string, jobId: string): Promise<string> {
    await this.requireJob(userId, jobId);
    return (await readText(this.cvFile(userId, jobId))) ?? DEFAULT_CV_HTML;
  }

  async saveCv(userId: string, jobId: string, html: string): Promise<void> {
    await this.requireJob(userId, jobId);
    await writeFileAtomic(this.cvFile(userId, jobId), html);
    await this.touchJob(userId, jobId);
  }

  async getPreferences(userId: string, jobId: string): Promise<CvPreferences> {
    await this.requireJob(userId, jobId);
    const stored = await readJson<CvPreferences>(this.prefsFile(userId, jobId));
    return { ...structuredClone(DEFAULT_PREFERENCES), ...stored };
  }

  async savePreferences(userId: string, jobId: string, prefs: CvPreferences): Promise<CvPreferences> {
    await this.requireJob(userId, jobId);
    if (prefs === null || typeof prefs !== 'object' || Array.isArray(prefs)) throw new Error('Preferences must be a JSON object');
    await writeJson(this.prefsFile(userId, jobId), prefs);
    return prefs;
  }

  async getCss(userId: string, jobId: string): Promise<string> {
    await this.requireJob(userId, jobId);
    return (await readText(this.cssFile(userId, jobId))) ?? DEFAULT_CSS;
  }

  async saveCss(userId: string, jobId: string, css: string): Promise<void> {
    await this.requireJob(userId, jobId);
    await writeFileAtomic(this.cssFile(userId, jobId), css);
  }

  // ---- chat sessions (independent) --------------------------------------

  private sessionFile(userId: string, sessionId: string) {
    return path.join(this.dir('sessions', userId), `${assertId(sessionId, 'session id')}.json`);
  }

  async listSessions(userId: string): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    for (const id of await listIds(this.dir('sessions', userId), '.json')) {
      const s = await this.getSession(userId, id);
      if (s) out.push({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createSession(userId: string, title = 'New conversation'): Promise<ChatSession> {
    const session: ChatSession = { id: newId(), title, createdAt: now(), updatedAt: now(), messages: [], events: [], usage: {} };
    await writeJson(this.sessionFile(userId, session.id), session);
    return session;
  }

  async getSession(userId: string, sessionId: string): Promise<ChatSession | undefined> {
    return readJson<ChatSession>(this.sessionFile(userId, sessionId));
  }

  async saveSession(userId: string, session: ChatSession): Promise<ChatSession> {
    const next = { ...session, updatedAt: now() };
    await writeJson(this.sessionFile(userId, session.id), next);
    return next;
  }

  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    return removeFile(this.sessionFile(userId, sessionId));
  }
}
