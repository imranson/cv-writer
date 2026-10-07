import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME_CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

export async function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => Promise<boolean> = (p) => access(p).then(() => true, () => false),
): Promise<string | undefined> {
  if (env.CHROME_PATH) return env.CHROME_PATH;
  for (const candidate of CHROME_CANDIDATES[platform] ?? []) if (await exists(candidate)) return candidate;
  return undefined;
}

export function chromePdfArgs(htmlPath: string, pdfPath: string, profileDir: string): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    // A throwaway profile keeps the user's running browser out of it.
    `--user-data-dir=${profileDir}`,
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];
}

/** Turns a standalone HTML page into PDF bytes. */
export type PdfRenderer = (html: string) => Promise<Buffer>;

/** True once the file is a whole PDF (Chrome writes the %%EOF trailer last). */
export function isCompletePdf(bytes: Buffer): boolean {
  return isPdf(bytes) && /%%EOF\s*$/.test(bytes.subarray(-64).toString('latin1'));
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // Chrome starts helper processes; they share the group created by `detached`.
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Prints with headless Chrome. Recent Chrome versions write the PDF but do not always exit, so this
 * waits for a complete file and then stops the browser itself.
 */
export function chromePdfRenderer(chromePath: string, timeoutMs = 60_000): PdfRenderer {
  return async (html) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cv-writer-pdf-'));
    const htmlPath = path.join(dir, 'cv.html');
    const pdfPath = path.join(dir, 'cv.pdf');
    await writeFile(htmlPath, html);
    const child = spawn(chromePath, chromePdfArgs(htmlPath, pdfPath, path.join(dir, 'profile')), { stdio: 'ignore', detached: true });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let failure: Error | undefined;
    let done = false;
    child.once('error', (err) => (failure = err));
    child.once('exit', () => (done = true));
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (failure) throw new Error(`Could not start Chrome: ${failure.message}`);
        const wasDone = done;
        const bytes = await readFile(pdfPath).catch(() => undefined);
        if (bytes && isCompletePdf(bytes)) return bytes;
        if (wasDone) throw new Error('Chrome exited without producing a PDF');
        if (Date.now() > deadline) throw new Error(`Chrome did not produce a PDF within ${Math.round(timeoutMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      killTree(child);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  };
}

/** Page count from the PDF's page objects (Chrome writes them uncompressed). */
export function countPdfPages(pdf: Buffer): number | undefined {
  const matches = pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return matches?.length || undefined;
}

export function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}

export async function writeFileEnsured(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}
