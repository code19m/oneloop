import test from 'node:test';
import assert from 'node:assert/strict';
import {checkDocument, markdownAnchors} from '../check-doc-links.mjs';

test('documentation anchors support formatting, Unicode, setext and duplicate collisions', () => {
  assert.deepEqual([...markdownAnchors('# Hello, `world`!\n# Hello world\n# Hello world-1\n## Café &amp; tea\nSetext\n===\n<a id="manual"></a>')],
    ['hello-world', 'hello-world-1', 'hello-world-1-1', 'café--tea', 'setext', 'manual']);
});

test('relative links include references and encoded paths but skip examples and footnotes', () => {
  const files = new Map([
    ['/repo/docs/index.md', '[valid](../Guide%20One.md#hello-world)\n[reference][guide]\n![image](../image.svg)\n[^1]\n\n[^1]: example footnote\n[guide]: ../Guide%20One.md#manual\n\n`[code](missing.md)`\n\n```md\n[example](absent.md)\n```\n[external](https://example.com)'],
    ['/repo/Guide One.md', '# Hello world\n<a id="manual"></a>'],
    ['/repo/image.svg', '<svg/>'],
  ]);
  assert.deepEqual(checkDocument('/repo/docs/index.md', {base: '/repo', exists: path => files.has(path), read: path => files.get(path)}), []);
});

test('missing files, missing headings and Markdown line anchors fail while code line anchors work', () => {
  const files = new Map([
    ['/repo/index.md', '[missing](no.md)\n[heading](guide.md#absent)\n[line](guide.md#L20)\n[code](app.js#L2)\n[self](#index)\n# Index'],
    ['/repo/guide.md', '# Guide'], ['/repo/app.js', ''],
  ]);
  const errors = checkDocument('/repo/index.md', {base: '/repo', exists: path => files.has(path), read: path => files.get(path)});
  assert.equal(errors.length, 3);
  assert.match(errors[0], /missing target/);
  assert.match(errors[1], /missing heading/);
  assert.match(errors[2], /Markdown line anchors/);
});
