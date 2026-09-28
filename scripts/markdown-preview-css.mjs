// Rebuild frontend/styles/markdown-preview.css from the vendored GitHub and highlight.js themes; --check fails when stale.
// The upstream themes are scoped to each app theme; app-specific rules stay in markdown-preview-overrides.css.
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
let css = `/* GitHub Markdown styling, scoped to the app theme.
 * Portions derived from github-markdown-css 5.9.0, copyright Sindre Sorhus,
 * MIT; see vendor/github-markdown-css/LICENSE.
 * highlight.js 11.12.0 GitHub themes, copyright 2006 Ivan Sagalaev,
 * BSD-3-Clause; see vendor/cdn-assets/LICENSE.
 */\n`;
for (const theme of ['light', 'dark']) {
  const scope = `:root[data-theme="${theme}"] .markdown-body`;
  css += read(`frontend/vendor/github-markdown-css/${theme}.css`).replaceAll('.markdown-body', scope);
  const highlight = read(`frontend/vendor/cdn-assets/${theme}.css`).replace(/\/\*[\s\S]*?\*\//g, '').trim();
  css += '\n' + highlight.replace(/([^{}]+)\{/g, (_, selectors) => selectors.split(',').map(selector => `${scope} ${selector}`).join(',') + '{') + '\n';
}
css += read('scripts/markdown-preview-overrides.css');
const destination = resolve(root, 'frontend/styles/markdown-preview.css');
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== css) throw new Error('Stale markdown-preview.css; run node scripts/markdown-preview-css.mjs');
} else writeFileSync(destination, css);
console.log('Markdown preview CSS is reproducible');
