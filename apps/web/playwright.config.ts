import { defineConfig, devices } from "@playwright/test";

// Set PLAYWRIGHT_CHROMIUM to use an already installed Chromium binary.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM || undefined;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    acceptDownloads: true,
    trace: "retain-on-failure",
    launchOptions: { executablePath },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions: { executablePath } }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: "pnpm exec vite --port 5173 --strictPort",
    cwd: import.meta.dirname,
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
