import { test as base, expect } from '@playwright/test';

// Every page, including pages in contexts a test creates, fails the test on an
// uncaught exception or an unexpected console error. A test that injects a
// failure allows its console text with `allowedConsoleErrors`. A security probe
// declares an exact expected page error; it must occur, and every other page
// error still fails the test.
export const test = base.extend({
  allowedConsoleErrors: async ({}, use) => { await use([]); },
  expectedPageErrors: async ({}, use) => {
    const patterns = [];
    await use(patterns);
    expect(patterns, 'Every declared page error must occur').toEqual([]);
  },
  browserErrors: [async ({ context, browser, allowedConsoleErrors, expectedPageErrors }, use) => {
    const errors = [];
    let observing = true;
    const watch = page => {
      page.on('pageerror', error => {
        if (!observing) return;
        const expected = expectedPageErrors.findIndex(pattern => pattern.test(error.message));
        if (expected !== -1) { expectedPageErrors.splice(expected, 1); return; }
        errors.push(`pageerror: ${error.message}`);
      });
      page.on('console', message => {
        if (!observing || message.type() !== 'error') return;
        const entry = `${message.text()} ${message.location().url}`;
        // The signed-out identity probe is part of normal startup.
        if (/(?:401|Unauthorized)/i.test(entry) && /\/api\/auth\/me\b/.test(entry)) return;
        if (allowedConsoleErrors.some(pattern => pattern.test(entry))) return;
        errors.push(entry);
      });
    };
    const watchContext = value => { value.pages().forEach(watch); value.on('page', watch); };
    watchContext(context);
    const newContext = browser.newContext;
    browser.newContext = async (...args) => { const value = await newContext.apply(browser, args); watchContext(value); return value; };
    try {
      await use({ errors, stop: () => { observing = false; } });
    } finally {
      browser.newContext = newContext;
    }
    expect(errors, 'Unexpected browser errors').toEqual([]);
  }, { auto: true }],
});

export { expect };
