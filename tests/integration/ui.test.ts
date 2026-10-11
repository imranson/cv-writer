import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect as baseExpect, it } from 'vitest';

// Playwright calls auto-wait, so polls need longer than vitest's 1s default.
const basePoll = baseExpect.poll.bind(baseExpect);
const expect = Object.assign((value: unknown, message?: string) => baseExpect(value, message), baseExpect, {
  poll: <T>(fn: () => T, opts: { timeout?: number } = {}) => basePoll(fn, { timeout: 10_000, ...opts }),
}) as typeof baseExpect;
import { loadConfig } from '../../src/config.ts';
import { createRuntime, listen, type Runtime } from '../../src/server/runtime.ts';
import { critiqueInput, CV_HTML, LISTING, PROFILE } from '../support/fixtures.ts';
import { BUILTIN_SKILLS_DIR, tempDir } from '../support/env.ts';
import { call, say, ScriptedModel, waitForAbort } from '../support/scriptedModel.ts';

const root = path.resolve(import.meta.dirname, '../..');
const coordinator = new ScriptedModel([], { name: 'coordinator', contextLength: 100_000 });
const writer = new ScriptedModel([], { name: 'writer' });
const critic = new ScriptedModel([], { name: 'critic' });

let runtime: Runtime;
let server: Awaited<ReturnType<typeof listen>>;
let browser: Browser;
let page: Page;
let base: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const tmp = await tempDir('cvw-ui-');
  cleanup = tmp.cleanup;
  const webDir = path.join(tmp.dir, 'web');
  await build({ configFile: path.join(root, 'vite.config.ts'), root: path.join(root, 'web'), build: { outDir: webDir, emptyOutDir: true }, logLevel: 'silent' });
  const config = { ...loadConfig({}), dataDir: path.join(tmp.dir, 'data'), webDir, builtinSkillsDir: BUILTIN_SKILLS_DIR };
  runtime = await createRuntime(config, { models: { coordinator, writer, critic } });
  server = await listen(runtime, 0, '127.0.0.1');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5_000);
  page.on('pageerror', (err) => {
    throw err;
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  await runtime?.close();
  await cleanup?.();
});

const lastBubble = () => page.locator('.msg-assistant .bubble').last();
const cvFrame = () => page.frameLocator('iframe[title="CV preview"]');

describe('web UI', () => {
  it('shows the welcome screen, model info and the skills library', async () => {
    await page.goto(base);
    await expect.poll(() => page.locator('.welcome h2').textContent()).toBe('Your CV coach');
    expect(await page.locator('.side-footer').textContent()).toContain('Model: kimi-k2.6:cloud');
    await page.getByRole('tab', { name: 'Skills' }).click();
    await page.locator('.skill-name', { hasText: 'CV critique rubric' }).click();
    await expect.poll(() => page.locator('.skill-detail h2').first().textContent()).toBe('CV critique rubric');
  });

  it('interviews the user from a starter prompt, streaming the reply and tool activity', async () => {
    coordinator.push(call('update_profile', { markdown: PROFILE }), say('Thanks, **Alex** — saved. Which job are you applying for?'));
    await page.getByRole('button', { name: 'Build my profile from scratch' }).click();
    await expect.poll(() => lastBubble().innerHTML()).toContain('<strong>Alex</strong>');
    expect(await page.locator('.chip-label').first().textContent()).toBe('Saved profile');
    expect(await page.locator('.msg-user .bubble').first().textContent()).toContain('build my CV profile from scratch');
    await expect.poll(() => page.locator('.side-item-title').first().textContent()).toContain("Hi! I'd like to build");
    expect(await page.locator('.ctx-text').textContent()).toMatch(/\/ 100k/);
    expect(await page.locator('.composer-input').inputValue()).toBe('');
  });

  it('saves a job, drafts and critiques the CV, and shows it in the workspace', async () => {
    coordinator.push(
      call('save_job', { title: 'Senior Product Manager', company: 'Brightwave', listing: LISTING }),
      call('write_cv', { instructions: 'Draft it' }),
      call('critique_cv', {}),
      say('Your first draft is ready and scored **89/100**.'),
    );
    writer.push(call('write_cv', { html: CV_HTML }), say('Drafted.'));
    critic.push(call('submit_critique', critiqueInput()));

    await page.locator('.composer-input').fill(LISTING);
    await page.locator('.composer-input').press('Enter');
    await expect.poll(() => lastBubble().textContent(), { timeout: 15_000 }).toContain('scored 89/100');

    expect(await page.locator('.chip-label').allTextContents()).toEqual(expect.arrayContaining(['Saved job listing: Senior Product Manager — Brightwave', 'CV Writer finished', 'CV Critic finished']));
    expect(await page.locator('.chip-state').allTextContents()).toEqual(expect.arrayContaining(['89/100 · ready']));
    expect(await page.locator('.sub-row').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('Writer'), expect.stringContaining('Critic')]));
    await expect.poll(() => page.locator('.job-select option:checked').textContent()).toBe('Senior Product Manager — Brightwave');
    await expect.poll(() => page.locator('.side-item .badge').first().textContent()).toBe('89');
    // The CV tab is flagged (not forced open) while the user is on another tab.
    expect(await page.locator('.tab[data-tab="cv"]').getAttribute('class')).toContain('flag');
    await page.getByRole('tab', { name: 'CV' }).click();
    await expect.poll(() => cvFrame().locator('h1').textContent()).toBe('Alex Morgan');
    await expect.poll(() => page.locator('.toolbar .badge').textContent()).toContain('1 page');

    await page.getByRole('tab', { name: 'Critique' }).click();
    expect(await page.locator('.score-ring strong').textContent()).toBe('89');
    expect(await page.locator('.critique-tab .badge').first().textContent()).toBe('Ready to submit');
    expect(await page.locator('.card h4').allTextContents()).toEqual(expect.arrayContaining(['Questions for you', 'Job requirement coverage']));
  });

  it('edits the raw CSS with a live preview and saves it', async () => {
    await page.getByRole('tab', { name: 'CV' }).click();
    await page.getByRole('button', { name: 'Edit CSS' }).click();
    const editor = page.locator('textarea.code-editor');
    const css = await editor.inputValue();
    expect(css).toContain('@page');
    await editor.fill(css.replace('--accent: #1f4e79', '--accent: #aa0000'));
    await expect.poll(() => cvFrame().locator('h1').evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).color)).toBe('rgb(170, 0, 0)');
    expect(await page.locator('.dirty-dot').count()).toBe(1);
    await page.locator('.editor-header').getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => page.locator('.dirty-dot').count()).toBe(0);
    expect((await (await page.request.get(`${base}/api/jobs/${await jobId()}/style`)).json()).css).toContain('--accent: #aa0000');

    // Quick control: page size select rewrites the @page rule
    await page.locator('.quick-controls select').selectOption('Letter');
    expect(await editor.inputValue()).toMatch(/size: Letter/);
    await page.locator('.editor-header').getByRole('button', { name: 'Discard' }).click();
  });

  it('applies a style preset and offers a working PDF download', async () => {
    await page.locator('select[aria-label="Apply style preset"]').selectOption('modern');
    expect(await page.locator('textarea.code-editor').inputValue()).toContain('Modern');
    await page.locator('.editor-header').getByRole('button', { name: 'Discard' }).click();
    const href = await page.getByRole('link', { name: 'Download PDF' }).getAttribute('href');
    expect(href).toBe(`/api/jobs/${await jobId()}/pdf?download=1`);
    const res = await page.request.get(`${base}${href}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
    expect((await res.body()).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('shows the profile and job listing documents', async () => {
    await page.getByRole('tab', { name: 'Profile' }).click();
    await expect.poll(() => page.locator('.profile-tab article h1').textContent()).toBe('Alex Morgan');
    await page.getByRole('tab', { name: 'Job listing' }).click();
    await expect.poll(() => page.locator('.job-tab .doc-head h2').textContent()).toBe('Senior Product Manager');
  });

  it('restores the conversation, including tool activity, after a reload', async () => {
    await page.reload();
    await expect.poll(() => page.locator('.msg-user').count()).toBe(2);
    expect(await page.locator('.chip-label').allTextContents()).toEqual(expect.arrayContaining(['Saved profile', 'CV Writer finished']));
    expect(await lastBubble().textContent()).toContain('scored 89/100');
  });

  it('can stop a long-running reply', async () => {
    coordinator.push((req) => waitForAbort(req));
    await page.locator('.composer-input').fill('Take your time');
    await page.locator('.composer-input').press('Enter');
    await expect.poll(() => page.locator('.composer .btn').first().textContent()).toBe('Stop');
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect.poll(() => page.locator('.divider', { hasText: 'Stopped' }).count()).toBe(1);
    await expect.poll(() => page.locator('.composer .btn').first().textContent()).toBe('Send');
  });
});

async function jobId(): Promise<string> {
  const jobs = (await (await page.request.get(`${base}/api/jobs`)).json()) as { id: string }[];
  return jobs[0]!.id;
}
