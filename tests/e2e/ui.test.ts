import { serve, type ServerType } from '@hono/node-server';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatRequest } from '../../src/llm/types';
import { PdfRenderer } from '../../src/pdf';
import { ScriptedLLM, makeDeps, tempDir } from '../helpers';
import { buildApp } from '../helpers/http';

const root = fileURLToPath(new URL('../..', import.meta.url));
let tmp: Awaited<ReturnType<typeof tempDir>>;
let server: ServerType;
let browser: Browser;
let pdf: PdfRenderer;
let baseUrl: string;

const jobIdFrom = (req: ChatRequest) => JSON.parse(req.messages.find((m) => m.tool_name === 'editJob')!.content).job.id;
const briefJobId = (req: ChatRequest) => /jobId:? (\w+)/.exec(req.messages[1].content)![1];

function script() {
  return new ScriptedLLM({
    coordinator: [
      { content: 'Saving your details.', tools: [['editProfile', { op: 'merge', value: { name: 'Ada Lovelace' } }], ['editJob', { job: { title: 'Data Engineer', company: 'Acme' } }]] },
      (req) => ({ tools: [['callWriter', { jobId: jobIdFrom(req), instructions: 'Draft a CV' }]] }),
      { content: 'Your CV is **ready** — have a look in the CV tab.' },
    ],
    writer: [
      (req) => ({ tools: [['editCV', { jobId: briefJobId(req), html: '<header class="cv-header"><h1>Ada Lovelace</h1><p class="headline">Data Engineer</p></header>' }]] }),
      (req) => ({ tools: [['callCritic', { jobId: briefJobId(req) }]] }),
      { content: 'Draft done.' },
    ],
    critic: [(req) => ({ tools: [['readCV', { jobId: briefJobId(req) }]] }), { content: 'Score: 8/10' }],
  });
}

beforeAll(async () => {
  await build({ entryPoints: [`${root}web/src/main.ts`], bundle: true, format: 'esm', outfile: `${root}public/app.js`, logLevel: 'silent' });
  tmp = await tempDir();
  pdf = new PdfRenderer();
  const app = buildApp(makeDeps(tmp.dir, script()), pdf, `${root}public`);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://localhost:${info.port}`;
      resolve();
    });
  });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await pdf?.close();
  server?.close();
  await tmp?.cleanup();
});

async function register(page: Page, email: string) {
  await page.goto(baseUrl);
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Name').fill('Ada');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.locator('#composer').waitFor();
}

describe('CV Writer UI', () => {
  it('runs a full conversation showing tool activity, subagents, context window, CV and raw CSS', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await register(page, 'ada@example.com');

    // Context window indicators for all three agents.
    await expect.poll(() => page.locator('.meter').count()).toBe(3);
    expect(await page.locator('.meter[data-agent="writer"] .meter-value').textContent()).toBe('— / 100k');

    await page.locator('#composer').fill('Hi, I am Ada. Help me apply to Acme as a Data Engineer.');
    await page.keyboard.press('Enter');
    await page.getByText('have a look in the CV tab').waitFor();
    await expect.poll(() => page.locator('#send').textContent()).toBe('Send');

    // Every tool call is displayed, with subagent runs nested under the call that started them.
    const toolNames = await page.locator('.tool .tool-name').allTextContents();
    expect(toolNames).toEqual(['editProfile', 'editJob', 'callWriter', 'editCV', 'callCritic', 'readCV']);
    expect(await page.locator('.tool.ok').count()).toBe(6);
    await page.locator('[data-tool="callWriter"] > .subrun[data-agent="writer"]').waitFor();
    await page.locator('.subrun[data-agent="writer"] [data-tool="callCritic"] > .subrun[data-agent="critic"]').waitFor();
    expect(await page.locator('.msg.assistant strong').textContent()).toBe('ready');

    // Expanding a tool shows its arguments and result.
    await page.locator('[data-tool="editJob"] summary').click();
    await expect.poll(() => page.locator('[data-tool="editJob"] .tool-body').textContent()).toContain('"company": "Acme"');

    // Context meters updated from real usage events.
    for (const agent of ['coordinator', 'writer', 'critic']) {
      expect(await page.locator(`.meter[data-agent="${agent}"] .meter-value`).textContent()).toMatch(/^\d[\d.k]* \/ 100k · \d+\.\d%$/);
    }

    // The new job was auto-selected; the CV preview shows the writer's HTML.
    await expect.poll(() => page.locator('#jobs li.active').textContent()).toContain('Data Engineer');
    await page.getByRole('tab', { name: 'CV' }).click();
    const frame = page.frameLocator('iframe.cv-frame');
    await expect.poll(() => frame.locator('h1').textContent()).toBe('Ada Lovelace');

    // PDF preview renders through Playwright on the server.
    await page.getByRole('button', { name: 'PDF' }).click();
    await expect.poll(() => page.locator('.pages').textContent(), { timeout: 15_000 }).toBe('1 page');

    // Raw CSS is visible and editable.
    await page.getByRole('tab', { name: 'CSS' }).click();
    const css = page.locator('textarea[data-editor="css"]');
    await expect.poll(() => css.inputValue()).toContain('@page');
    await css.fill('@page { size: A4 }\nh1 { color: rebeccapurple; }');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Saved ✓').waitFor();

    // Activity log lists tool calls and usage for all agents.
    await page.getByRole('tab', { name: 'Activity' }).click();
    const activity = await page.locator('.activity').textContent();
    expect(activity).toContain('→ callWriter');
    expect(activity).toContain('✓ editCV');
    expect(activity).toContain('context');

    // Reloading restores the conversation and its tool activity.
    await page.reload();
    await page.locator('.tool .tool-name').first().waitFor();
    expect(await page.locator('.tool .tool-name').count()).toBe(6);
    expect(await page.locator('#sessions li').count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('keeps accounts separate and supports signing out and in', async () => {
    const page = await browser.newPage();
    await register(page, 'bob@example.com');
    expect(await page.locator('#jobs .empty').textContent()).toContain('No jobs yet');
    expect(await page.locator('#sessions .empty').textContent()).toContain('No conversations yet');
    await page.getByRole('button', { name: 'Sign out' }).click();

    await page.getByLabel('Email').fill('ada@example.com');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Incorrect email or password').waitFor();
    await page.getByLabel('Password').fill('password123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('#jobs li.active').waitFor();
    expect(await page.locator('#jobs li').count()).toBe(1);
    await page.close();
  });
});
