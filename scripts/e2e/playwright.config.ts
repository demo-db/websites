import { defineConfig, devices } from '@playwright/test';
if(!process.env.DEMODB_ACCEPTANCE_ORIGIN) throw Error('Run node scripts/test-browser.mjs so the fixture host is owned and closed.');
export default defineConfig({testDir:'.',testMatch:'*.spec.ts',workers:1,retries:0,timeout:30000,reporter:'list',outputDir:'../../test-results',projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],use:{baseURL:process.env.DEMODB_ACCEPTANCE_ORIGIN,trace:'retain-on-failure',screenshot:'only-on-failure'}});
