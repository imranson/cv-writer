// Development: rebuild the client on change and restart the server on change.
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['scripts/build-client.mjs', '--watch'], { stdio: 'inherit' }),
  spawn(process.execPath, ['--import', 'tsx', '--watch', 'src/server/main.ts'], { stdio: 'inherit' }),
];
const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && code !== 0 && stop());
