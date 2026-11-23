// Installs the browser the end-to-end suite needs (Chrome Headless Shell, the revision the pinned Playwright wants).
// Playwright's own install also deletes cached browsers that no registered Playwright installation uses, which can
// remove another project's download: this command turns that clean-up off (PLAYWRIGHT_SKIP_BROWSER_GC), so it only adds.
const { spawnSync } = require('node:child_process');

const cli = require.resolve('@playwright/test/cli');
const result = spawnSync(process.execPath, [cli, 'install', 'chromium-headless-shell'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '1' },
});
process.exit(result.status === null ? 1 : result.status);
