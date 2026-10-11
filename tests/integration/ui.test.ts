import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../support/app.js';
import { journeyLlm } from '../support/journey.js';

describe('web UI (real browser, scripted model)', () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;
  let server: ServerType;
  let browser: Browser;
  let page: Page;
  let base: string;

  beforeAll(async () => {
    const llm = journeyLlm();
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
    expect(await page.locator('#session-list li.active').textContent()).toContain('Hi, I am Ada');

    await page.click('#new-session');
    await expect.poll(() => page.locator('#session-list li').count()).toBe(2);
    await expect.poll(() => page.locator('.bubble.user').count()).toBe(0);

    await page.locator('#session-list li.active .delete').click();
    await expect.poll(() => page.locator('#session-list li').count()).toBe(1);
    await page.locator('.bubble.user', { hasText: 'Hi, I am Ada' }).waitFor();
  });
});
