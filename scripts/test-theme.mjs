import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../public/theme.js', import.meta.url), 'utf8');
const layout = await readFile(new URL('../src/layouts/SiteLayout.astro', import.meta.url), 'utf8');
const themeStyles = await readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8');

function lightTokens() {
  const block = themeStyles.match(/:root:not\(\[data-theme="dark"\]\)\s*\{([^}]+)\}/)?.[1];
  assert.ok(block, 'light theme token block exists');
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((match) => [match[1], match[2]]));
}

function contrast(foreground, background) {
  const luminance = (color) => {
    const channels = color.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255);
    const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function createBrowser({ hostname = 'demodb.dev', cookie = '', stored = null, blockedCookie = false, blockedStorage = false } = {}) {
  const listeners = new Map();
  const attributes = {};
  const label = { textContent: 'Dark' };
  const icon = { textContent: '◐' };
  const button = {
    setAttribute(name, value) { attributes[name] = value; },
    querySelector(selector) { return selector === '[data-theme-toggle-label]' ? label : selector === '.theme-toggle-icon' ? icon : null; },
  };
  const document = {
    documentElement: { dataset: {}, style: {} },
    themeColor: { setAttribute(name, value) { this[name] = value; } },
    get cookie() { if (blockedCookie) throw new Error('storage blocked'); return cookie; },
    set cookie(value) { if (blockedCookie) throw new Error('storage blocked'); this.savedCookie = value; },
    querySelector(selector) { return selector === '[data-theme-toggle]' ? button : selector === 'meta[name="theme-color"]' ? this.themeColor : null; },
    addEventListener(name, callback) { listeners.set(name, callback); },
  };
  const values = new Map(stored == null ? [] : [['demodb-theme', stored]]);
  const localStorage = {
    getItem(key) { if (blockedStorage) throw new Error('storage blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (blockedStorage) throw new Error('storage blocked'); values.set(key, value); },
  };
  runInNewContext(source, { document, localStorage, location: { hostname } });
  return { document, listeners, attributes, label, icon, values, button };
}

test('light is applied before paint when no explicit preference exists', () => {
  const browser = createBrowser();
  assert.equal(browser.document.documentElement.dataset.theme, 'light');
  assert.equal(browser.document.documentElement.style.colorScheme, 'light');
  assert.equal(browser.document.themeColor.content, '#f7f9fc');
  assert.match(layout, /<script is:inline src="\/theme\.js"><\/script>/, 'the preference script runs synchronously from the shared layout');
});

test('a shared cookie wins and the accessible toggle persists across database subdomains', () => {
  const browser = createBrowser({ hostname: 'northwind.demodb.dev', cookie: 'demodb-theme=dark', stored: 'light' });
  assert.equal(browser.document.documentElement.dataset.theme, 'dark');
  browser.listeners.get('DOMContentLoaded')();
  assert.equal(browser.attributes['aria-pressed'], 'true');
  assert.equal(browser.attributes['aria-label'], 'Switch to light theme');
  assert.equal(browser.label.textContent, 'Light');

  browser.listeners.get('click')({ target: { closest: (selector) => selector === '[data-theme-toggle]' ? browser.button : null } });
  assert.equal(browser.document.documentElement.dataset.theme, 'light');
  assert.equal(browser.attributes['aria-pressed'], 'false');
  assert.equal(browser.attributes['aria-label'], 'Switch to dark theme');
  assert.equal(browser.values.get('demodb-theme'), 'light');
  assert.match(browser.document.savedCookie, /Domain=demodb\.dev/);
  assert.match(browser.document.savedCookie, /Secure/);
  assert.match(browser.document.savedCookie, /SameSite=Lax/);
});

test('blocked cookies and local storage do not break rendering or toggling', () => {
  const browser = createBrowser({ blockedCookie: true, blockedStorage: true });
  assert.equal(browser.document.documentElement.dataset.theme, 'light');
  assert.doesNotThrow(() => browser.listeners.get('click')({ target: { closest: () => browser.button } }));
  assert.equal(browser.document.documentElement.dataset.theme, 'dark');
  assert.equal(browser.attributes['aria-pressed'], 'true');
});

test('invalid saved values fall back to light without consulting system preference', () => {
  const browser = createBrowser({ cookie: 'demodb-theme=auto', stored: 'system' });
  assert.equal(browser.document.documentElement.dataset.theme, 'light');
});

test('small light-theme text meets WCAG AA on its content surfaces and primary hover stays readable', () => {
  const tokens = lightTokens();
  const onWhite = ['ink', 'muted', 'faint', 'lime', 'cyan', 'console-code', 'console-text', 'console-comment', 'console-result', 'console-result-secondary', 'preview-text', 'null-color'];
  for (const name of onWhite) assert.ok(contrast(tokens[name], '#ffffff') >= 4.5, `--${name} contrast on white`);
  for (const name of ['ink', 'muted', 'faint', 'lime', 'cyan', 'console-text', 'console-result', 'preview-text', 'null-color']) {
    assert.ok(contrast(tokens[name], tokens['code-surface']) >= 4.5, `--${name} contrast on the light code surface`);
  }
  assert.match(themeStyles, /\.button-primary,\s*\.button-primary:hover\s*\{\s*color:var\(--button-text\);/);
  assert.match(themeStyles, /\.button:not\(\.button-primary\):hover\s*\{\s*color:var\(--button-hover-text\);/);
});
