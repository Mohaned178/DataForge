// Preloaded into a profiled child process (node --import): on exit, appends the peak resident set size
// (kilobytes) to the file named by PROFILE_PEAK_FILE.
import { appendFileSync } from 'node:fs';

const file = process.env.PROFILE_PEAK_FILE;
if (file) {
  process.on('exit', () => {
    appendFileSync(file, `${process.resourceUsage().maxRSS}\n`);
  });
}
