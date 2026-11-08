import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfRenderer } from '../../src/pdf/renderer.js';
import { createTestEnv, ROOT, type TestEnv } from '../helpers/env.js';
import { call, reply, ScriptedLlm } from '../helpers/scriptedLlm.js';
import type { ChatRequest } from '../../src/llm/types.js';

const lastJobId = (req: ChatRequest) =>
  JSON.parse([...req.messages].reverse().find((m) => m.role === 'tool' && m.tool_name === 'editJob')!.content).jobId as string;

const CV_HTML =
  '<header class="cv-header"><h1>Erin Endtoend</h1><p class="cv-headline">Product Designer</p></header><section><h2>Experience</h2><ul><li>Redesigned onboarding, lifting activation 18%</li></ul></section>';

let env: TestEnv;
let server: ServerType;
let browser: Browser;
let page: Page;
let base = '';
const pdf = new PdfRenderer();
const consoleErrors: string[] = [];

beforeAll(async () => {
  await build({ entryPoints: [`${ROOT}/src/client/main.ts`], bundle: true, format: 'esm', outfile: `${ROOT}/public/app.js`, sourcemap: true, logLevel: 'silent' });
  const llm = new ScriptedLlm(
    {
      coordinator: [
        call('editProfile', { profile: { name: 'Erin Endtoend', headline: 'Product Designer' } }),
        call('editJob', { job: { title: 'Senior Product Designer', company: 'Orbit Labs', description: 'Figma, research' } }),
        (req) => call('callWriter', { jobId: lastJobId(req), instructions: 'Draft a one-page CV' }),
        reply('Your **CV for Orbit Labs** is ready. Check the CV tab and download the PDF.'),
      ],
      writer: [call('loadSkill', { name: 'ats-cv-writing' }), call('editCV', { html: CV_HTML }), call('callCritic', {}), reply('Draft complete. Critic: 8.2/10.')],
      critic: [call('readCV', {}), reply('Score: 8.2/10 — strong.')],
    },
    { delayMs: 120, contextWindow: 262_144 },
  );
  env = await createTestEnv({ llm, pdf });
  server = serve({ fetch: env.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
});

afterAll(async () => {
  await browser?.close();
  await pdf.close();
  await new Promise((r) => server?.close(r));
  await env?.close();
});

describe('end-to-end in a real browser', () => {
  it('registers a new account', async () => {
    await page.goto(base);
    await page.getByRole('button', { name: 'Create an account' }).click();
    await page.getByPlaceholder('Your name').fill('Erin');
    await page.getByPlaceholder('Email').fill('erin@example.com');
    await page.getByPlaceholder('Password (8+ characters)').fill('password123');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText('Hi! I’m your CV coordinator.').waitFor();
    expect(await page.locator('.account-name').textContent()).toBe('Erin');
  });

  it('chats with the coordinator and streams all agent activity with context usage', async () => {
    await page.locator('.composer-input').fill('Please write my CV for Orbit Labs');
    await page.locator('.composer-input').press('Enter');
    await page.locator('.status-line').waitFor();
    await page.locator('.msg.assistant .bubble').filter({ hasText: 'CV for Orbit Labs is ready' }).waitFor({ timeout: 20_000 });
    await page.locator('.status-line').waitFor({ state: 'detached' });

    expect(await page.locator('.msg.user .bubble').first().textContent()).toBe('Please write my CV for Orbit Labs');
    expect(await page.locator('.msg.assistant strong').first().textContent()).toBe('CV for Orbit Labs');
    expect(await page.locator('.chat-title').textContent()).toBe('Please write my CV for Orbit Labs');

    const badges = await page.locator('.run .agent-badge').allTextContents();
    expect(badges).toEqual(['coordinator', 'writer', 'critic']);
    const tools = await page.locator('.tool-name').allTextContents();
    for (const t of ['editProfile', 'editJob', 'callWriter', 'loadSkill', 'editCV', 'callCritic', 'readCV']) expect(tools).toContain(t);
    expect(await page.locator('.run .gauge-text').count()).toBe(3);
    expect(await page.locator('.chat-ctx .gauge-text').textContent()).toMatch(/\/ 262k · \d+\.\d%/);
    expect(await page.locator('.activity-summary .stats').textContent()).toMatch(/^3 agent runs · 7 tool calls/);

    // Tool details expand to show arguments and results.
    await page.locator('.tool summary', { hasText: 'editJob' }).click();
    expect(await page.locator('.tool-body pre').first().textContent()).toContain('Orbit Labs');
  });

  it('shows the job, live CV preview, raw CSS and preferences', async () => {
    await page.locator('.jobs .list-main', { hasText: 'Senior Product Designer' }).click();
    await page.locator('.cv-frame').waitFor();
    const srcdoc = await page.locator('.cv-frame').getAttribute('srcdoc');
    expect(srcdoc).toContain('Erin Endtoend');
    expect(await page.locator('.cv-frame').getAttribute('sandbox')).toBe('');
    const frameText = await page.frameLocator('.cv-frame').locator('h1').textContent();
    expect(frameText).toBe('Erin Endtoend');

    await page.getByRole('tab', { name: 'CSS' }).click();
    const css = page.locator('textarea.editor');
    expect(await css.inputValue()).toContain('@page');
    await css.fill('h1 { color: rgb(200, 0, 0); }');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('.toast', { hasText: 'Saved' }).waitFor();
    await page.getByRole('tab', { name: 'CV' }).click();
    expect(await page.frameLocator('.cv-frame').locator('h1').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(200, 0, 0)');

    await page.getByRole('tab', { name: 'Preferences' }).click();
    expect(JSON.parse(await page.locator('textarea.editor').inputValue())).toMatchObject({ paperSize: 'A4', maxPages: 2 });
    await page.getByRole('tab', { name: 'Profile' }).click();
    expect(JSON.parse(await page.locator('textarea.editor').inputValue())).toEqual({ name: 'Erin Endtoend', headline: 'Product Designer' });
  });

  it('downloads the CV as a PDF rendered by Playwright', async () => {
    await page.getByRole('tab', { name: 'CV' }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download PDF' }).click()]);
    expect(download.suggestedFilename()).toBe('CV - Erin Endtoend - Orbit Labs - Senior Product Designer.pdf');
    const bytes = await readFile((await download.path())!);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('restores the chat transcript and activity after a reload', async () => {
    await page.reload();
    await page.locator('.msg.assistant').first().waitFor();
    expect(await page.locator('.msg').count()).toBe(2);
    expect(await page.locator('.run .agent-badge').allTextContents()).toEqual(['coordinator', 'writer', 'critic']);
  });

  it('adds a second account, keeps data separate and switches back', async () => {
    await page.locator('.account-menu summary').click();
    await page.getByRole('button', { name: '+ Add another account' }).click();
    await page.getByText('Sign in to another account').waitFor();
    await page.getByRole('button', { name: 'Create an account' }).click();
    await page.getByPlaceholder('Your name').fill('Second');
    await page.getByPlaceholder('Email').fill('second@example.com');
    await page.getByPlaceholder('Password (8+ characters)').fill('password123');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText('Hi! I’m your CV coordinator.').waitFor();
    expect(await page.locator('.account-name').textContent()).toBe('Second');
    expect(await page.locator('.jobs').textContent()).toContain('No jobs yet');

    await page.locator('.account-menu summary').click();
    await page.locator('.menu-item', { hasText: 'Erin' }).click();
    await page.locator('.jobs .list-main', { hasText: 'Senior Product Designer' }).waitFor();
    expect(await page.locator('.account-name').textContent()).toBe('Erin');
  });

  it('logged no browser errors', () => {
    expect(consoleErrors).toEqual([]);
  });
});
