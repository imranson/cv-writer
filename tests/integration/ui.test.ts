import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../support/app.js';
import { journeyScripts } from '../support/journey.js';
import { ScriptedLLM } from '../support/scriptedLlm.js';

describe('web UI (real browser, scripted model)', () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;
  let server: ServerType;
  let browser: Browser;
  let page: Page;
  let base: string;

  beforeAll(async () => {
    const llm = new ScriptedLLM(
      {
        ...journeyScripts,
        coordinator: async (req) => ({ ...(await journeyScripts.coordinator(req)), thinking: 'Coordinator plans the next step.' }),
        writer: async (req) => ({ ...(await journeyScripts.writer(req)), thinking: 'Writer private reasoning.' }),
      },
      262_144,
    );
    llm.delayMs = 30;
    t = await buildTestApp(llm);
    server = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
    page = await browser.newPage({ acceptDownloads: true });
    page.on('dialog', (d) => d.accept());
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
    await t?.cleanup();
  });

  it('starts a chat automatically', async () => {
    await page.goto(base);
    await expect.poll(() => page.locator('#session-list li').count()).toBe(1);
    await expect.poll(() => page.locator('.bubble.notice').first().textContent()).toContain('Say hello');
    expect(await page.locator('#model-name').textContent()).toBe('coord-model');
  });

  it('streams the coordinator reply and shows writer/critic activity', async () => {
    await page.fill('#input', 'Hi, I am Ada. Please write my CV for Acme.');
    await page.press('#input', 'Enter');
    await expect.poll(() => page.locator('#stop').isVisible()).toBe(true);
    await page.locator('.bubble.assistant', { hasText: 'ready in the preview panel' }).waitFor({ timeout: 20_000 });
    await expect.poll(() => page.locator('#stop').isVisible()).toBe(false);

    expect(await page.locator('.bubble.user').textContent()).toBe('Hi, I am Ada. Please write my CV for Acme.');
    expect(await page.locator('.bubble.assistant strong').first().textContent()).toBe('Acme'); // markdown rendered
    const activity = (await page.locator('.activity').allTextContents()).join(' ');
    expect(activity).toContain('writer started');
    expect(activity).toContain('critic → readCV');
    expect(activity).toContain('writer → writeCV');
    expect(await page.locator('.bubble.assistant', { hasText: 'WRITER REPORT' }).count()).toBe(0);
  });

  it('shows each tool call collapsed, expanding to its arguments and full result', async () => {
    const rows = page.locator('.activity li.tool details');
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await rows.evaluateAll((els) => els.some((el) => (el as HTMLDetailsElement).open))).toBe(false);

    const readCv = rows.filter({ has: page.locator('summary', { hasText: 'critic → readCV' }) });
    expect(await readCv.locator('.tool-args').textContent()).toMatch(/"jobId": "job-/);
    const output = (await readCv.locator('.tool-output').textContent())!;
    expect(output.length).toBeGreaterThan(300); // not truncated to a preview
    expect(output).toContain('Ada Lovelace');

    await page.locator('details.activity').evaluateAll((els) => els.forEach((el) => ((el as HTMLDetailsElement).open = true)));
    await readCv.locator('summary').click();
    await expect.poll(() => readCv.locator('.tool-output').isVisible()).toBe(true);
  });

  it('shows the coordinator’s thinking, collapsed once it moves on, but never a subagent’s', async () => {
    const thoughts = page.locator('details.thinking');
    expect(await thoughts.count()).toBe(4); // one per coordinator step
    expect(await thoughts.first().textContent()).toContain('Coordinator plans the next step.');
    expect(await thoughts.evaluateAll((els) => els.some((el) => (el as HTMLDetailsElement).open))).toBe(false);
    expect(await page.locator('#messages').textContent()).not.toContain('Writer private reasoning');
  });

  it('shows the context window indicator', async () => {
    const text = await page.locator('#context-text').textContent();
    expect(text).toMatch(/^[\d.]+k? \/ 262k \(\d+\.\d%\)$/);
    expect(await page.locator('#context-fill').evaluate((el) => (el as HTMLElement).style.width)).not.toBe('0%');
  });

  it('previews the CV and shows job, profile and preferences', async () => {
    await expect.poll(() => page.locator('#job-select option').first().textContent()).toBe('Senior TypeScript Engineer @ Acme');
    const frame = page.frameLocator('#cv-frame');
    await expect.poll(() => frame.locator('h1').textContent()).toBe('Ada Lovelace');

    await page.click('button[data-tab="preferences"]');
    expect(await page.locator('#preferences-view').textContent()).toContain('"tone": "formal"');
    await page.click('button[data-tab="job"]');
    expect(await page.locator('#job-view').textContent()).toContain('"company": "Acme"');
    await page.click('button[data-tab="profile"]');
    expect(await page.locator('#profile-view').textContent()).toContain('"name": "Ada Lovelace"');
  });

  it('shows the raw CSS and applies edits to the preview', async () => {
    await page.click('button[data-tab="css"]');
    const css = await page.locator('#css-editor').inputValue();
    expect(css).toContain('@page');
    expect(css).toContain('.cv-header h1');
    await page.fill('#css-editor', `${css}\n.cv-header h1 { color: rgb(200, 0, 0); }\n`);
    expect(await page.locator('#css-status').textContent()).toBe('Unsaved changes');
    await page.click('#css-save');
    await expect.poll(() => page.locator('#css-status').textContent()).toBe('Saved');
    await page.click('button[data-tab="preview"]');
    const frame = page.frameLocator('#cv-frame');
    await expect
      .poll(() => frame.locator('h1').evaluate((el) => getComputedStyle(el).color), { timeout: 10_000 })
      .toBe('rgb(200, 0, 0)');
    const [jobId] = await t.workspace.cvs.list();
    expect(await t.workspace.cvStyles.read(jobId)).toContain('rgb(200, 0, 0)');
  });

  it('downloads the CV as a PDF', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#pdf-link')]);
    expect(download.suggestedFilename()).toMatch(/^cv-job-.*\.pdf$/);
    const bytes = await readFile((await download.path())!);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('restores the session after reload and supports multiple sessions', async () => {
    await page.reload();
    await page.locator('.bubble.user', { hasText: 'Hi, I am Ada' }).waitFor();
    expect(await page.locator('.bubble.assistant', { hasText: 'ready in the preview panel' }).count()).toBe(1);
    expect(await page.locator('details.thinking', { hasText: 'Coordinator plans the next step.' }).count()).toBe(4);
    const callWriter = page.locator('.activity li.tool details').filter({ has: page.locator('summary', { hasText: 'coordinator → callWriter' }) });
    expect(await callWriter.locator('.tool-output').textContent()).toContain('WRITER REPORT: CV written');
    expect(await callWriter.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    expect(await page.locator('#session-list li.active').textContent()).toContain('Hi, I am Ada');

    await page.click('#new-session');
    await expect.poll(() => page.locator('#session-list li').count()).toBe(2);
    await expect.poll(() => page.locator('.bubble.user').count()).toBe(0);

    await page.locator('#session-list li.active .delete').click();
    await expect.poll(() => page.locator('#session-list li').count()).toBe(1);
    await page.locator('.bubble.user', { hasText: 'Hi, I am Ada' }).waitFor();
  });
});
