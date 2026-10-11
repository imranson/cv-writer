import { loadConfig } from '../config.ts';
import { createRuntime, listen } from './runtime.ts';

const config = loadConfig();
const runtime = await createRuntime(config);
const server = await listen(runtime, config.port, config.hostname);

console.log(`CV Writer running at http://${config.hostname}:${config.port}`);
console.log(`Ollama: ${config.ollama.host} · model ${config.ollama.model}${config.ollama.apiKey ? ' (API key set)' : ''}`);
console.log(`Data: ${config.dataDir}`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await runtime.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
