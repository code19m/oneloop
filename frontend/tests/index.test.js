import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SourceTextModule } from 'node:vm';

const frontend = new URL('../', import.meta.url);

/** The modules that `entries` import statically, as root-relative URL paths. */
function staticImports(entries) {
  const seen = new Set(), queue = entries.map((entry) => new URL(entry, frontend));
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const { moduleRequests } = new SourceTextModule(readFileSync(url, 'utf8'));
    queue.push(...moduleRequests.map(({ specifier }) => new URL(specifier, url)));
  }
  return [...seen].map((href) => '/' + href.slice(frontend.href.length));
}

test('index.html preloads exactly the modules that start-up imports', () => {
  const html = readFileSync(new URL('index.html', frontend), 'utf8');
  const preloaded = [...html.matchAll(/<link rel="modulepreload"[^>]* href="([^"]+)"/g)].map(([, href]) => href);
  // main.js imports boot.js, and boot.js views/app.js, dynamically. main.js
  // itself is the page's script.
  const imported = staticImports(['src/app/boot.js', 'views/app.js']).filter((path) => path !== '/src/app/main.js');
  assert.deepEqual([...preloaded].sort(), imported.sort());
});
