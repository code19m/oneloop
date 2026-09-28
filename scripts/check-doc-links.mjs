// Check relative links and anchors in the documentation site (docs/src) and the
// root Markdown files, using the same Markdown parser as attachment previews.
import {execFileSync} from 'node:child_process';
import {readFileSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {lexer, walkTokens} = createRequire(import.meta.url)('../frontend/vendor/marked/marked.js');
const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()];
    const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
  });
}
function inlineText(tokens) {
  return tokens.map(token => token.type === 'html' ? '' : token.tokens ? inlineText(token.tokens) : token.text || '').join('');
}

export function markdownAnchors(source) {
  const anchors = new Set(), used = new Set();
  walkTokens(lexer(source), token => {
    if (token.type === 'heading') {
      const slug = decodeEntities(inlineText(token.tokens)).toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
      let candidate = slug, suffix = 0;
      while (used.has(candidate)) candidate = `${slug}-${++suffix}`;
      used.add(candidate); anchors.add(candidate);
    }
    if (token.type === 'html') {
      for (const match of token.raw.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(decodeEntities(match[1]));
    }
  });
  return anchors;
}

export function checkDocument(file, {read = path => readFileSync(path, 'utf8'), exists = existsSync, base = root} = {}) {
  const errors = [], source = read(file), cache = new Map();
  walkTokens(lexer(source), token => {
    if (!['link', 'image'].includes(token.type)) return;
    const href = decodeEntities(token.href);
    if (!href || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(href)) return;
    try {
      const hash = href.indexOf('#');
      const path = (hash < 0 ? href : href.slice(0, hash)).split('?')[0];
      const fragment = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1));
      const target = path ? resolve(path.startsWith('/') ? base : dirname(file), decodeURIComponent(path).replace(/^\//, '')) : file;
      if (!exists(target)) throw new Error('missing target');
      if (!fragment || !/\.md$/i.test(target)) return;
      if (/^L\d+(?:-L?\d+)?$/i.test(fragment)) throw new Error('Markdown line anchors do not resolve; use a heading');
      if (!cache.has(target)) cache.set(target, markdownAnchors(read(target)));
      if (!cache.get(target).has(fragment)) throw new Error(`missing heading or explicit anchor #${fragment}`);
    } catch (error) { errors.push(`${relative(base, file)}: ${href}: ${error.message}`); }
  });
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)*.md', ':(glob)docs/src/**/*.md'], {cwd: root, encoding: 'utf8'}).split('\0').filter(file => file && existsSync(resolve(root, file)));
  const errors = files.flatMap(file => checkDocument(resolve(root, file)));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Relative links and Markdown anchors checked in ${files.length} files`);
}
