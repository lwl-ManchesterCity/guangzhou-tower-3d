import { defineConfig } from '@playwright/test';

// Without this, Playwright scans the whole project root and `pre-p0` restore copies of the specs run as live tests.
export default defineConfig({
  testDir: './tests',
  // One boot check before anything else: a page that cannot start turns every item red on its first line, and the
  // reason only appears in the app's own error panel. See `tests/global-setup.js`.
  globalSetup: './tests/global-setup.js',
});
