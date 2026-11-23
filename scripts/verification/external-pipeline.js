// The "user's pipeline" of the Milestone 7 self-check: the standalone reference consumer, started
// with the given arguments, finished the way Ctrl+C finishes it in the manual guide. A background
// process cannot receive Ctrl+C on Windows, so this script starts the consumer with an IPC channel
// and sends it "finish" when the file <out>/finish appears; the consumer then writes its files.
//   node scripts/verification/external-pipeline.js <out> <consumer options...>
const { fork } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { setInterval, clearInterval } = require('node:timers');

const [out, ...consumerArgs] = process.argv.slice(2);
const entry = resolve(__dirname, '..', '..', 'apps', 'consumer', 'dist', 'main.js');
const child = fork(entry, ['--out', out, ...consumerArgs], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

child.on('message', (message) => {
  if (message && message.type === 'ready') {
    process.stdout.write('external-pipeline: ready\n');
    const poll = setInterval(() => {
      if (existsSync(join(out, 'finish'))) {
        clearInterval(poll);
        child.send({ type: 'finish' });
      }
    }, 200);
  }
});
child.on('exit', (code) => {
  process.stdout.write(`external-pipeline: consumer exited with code ${code}\n`);
  process.exit(code === null ? 1 : code);
});
