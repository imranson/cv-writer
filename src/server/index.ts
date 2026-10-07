import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, USAGE } from '../config.js';
import { chromePdfRenderer, findChrome } from '../cv/pdf.js';
import { OllamaChatModel } from '../llm/ollama.js';
import { Store } from '../storage/store.js';
import { fetchPage } from '../util/fetchPage.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config === 'help') {
    console.log(USAGE);
    return;
  }
  const chrome = config.chromePath ?? (await findChrome());
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const app = createApp({
    store: new Store(config.dataDir),
    llm: new OllamaChatModel({ host: config.ollamaHost, ...(config.apiKey ? { apiKey: config.apiKey } : {}) }),
    models: config.models,
    ...(config.think !== undefined ? { think: { coordinator: config.think, writer: config.think, critic: config.think } } : {}),
    ...(chrome ? { pdf: chromePdfRenderer(chrome) } : {}),
    fetchPage: (url) => fetchPage(url),
    staticDir: path.join(root, 'dist/web'),
  });
  app.listen(config.port, config.listen, () => {
    const address = app.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    console.log(`CV Writer running at http://${config.listen === '0.0.0.0' ? 'localhost' : config.listen}:${port}`);
    console.log(`  data:    ${config.dataDir}`);
    console.log(`  ollama:  ${config.ollamaHost}`);
    console.log(`  models:  coordinator ${config.models.coordinator} · writer ${config.models.writer} · critic ${config.models.critic}`);
    console.log(`  pdf:     ${chrome ?? 'unavailable (install Chrome or set CHROME_PATH)'}`);
  });
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
