import assert from 'node:assert/strict';
import test from 'node:test';
import {
  failureText, folderEntries, highlight, iconKind, originOf, parseRoute, readmeIn, resolveImage, resolveLink, routeHash, searchTerms, transportOf,
} from '../../../../src/features/knowledge/model.js';

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const files = [
  { path: 'README.md', size: 10, kind: 'markdown', updatedAt: 300 },
  { path: 'guides/onboarding.md', size: 10, kind: 'markdown', updatedAt: 500 },
  { path: 'guides/Readme.md', size: 10, kind: 'markdown', updatedAt: 100 },
  { path: 'guides/deep/notes.txt', size: 10, kind: 'text', updatedAt: 900 },
  { path: 'assets/logo.png', size: 10, kind: 'image', updatedAt: 200 },
  { path: 'brand kit.zip', size: 10, kind: null, updatedAt: 50 },
];

test('routes name a project, a folder or file and an optional section', () => {
  assert.deepEqual(parseRoute('knowledge'), { projectId: null, mode: 'tree', path: '', section: '', valid: true });
  assert.deepEqual(parseRoute('knowledge/p%201/blob/guides/on%20boarding.md?section=first-day'),
    { projectId: 'p 1', mode: 'blob', path: 'guides/on boarding.md', section: 'first-day', valid: true });
  assert.equal(parseRoute('knowledge/p1/tree/guides').path, 'guides');
  for (const route of ['knowledge/p1/raw/x', 'knowledge/p1/blob', 'knowledge/p1/blob/../secret', 'knowledge/p1/tree/%E0%A4%A']) {
    assert.equal(parseRoute(route).valid, false, route);
  }
  assert.equal(routeHash('p 1', 'blob', 'guides/on boarding.md', 'first-day'), '#/knowledge/p%201/blob/guides/on%20boarding.md?section=first-day');
  assert.deepEqual(parseRoute(routeHash('p1', 'blob', 'a#b?.md').slice(2)).path, 'a#b?.md');
});

test('a folder lists its folders first, each dated by its newest file', () => {
  assert.deepEqual(folderEntries(files).map(({ name, folder, updatedAt }) => [name, folder, updatedAt]), [
    ['assets', true, 200], ['guides', true, 900], ['brand kit.zip', false, 50], ['README.md', false, 300],
  ]);
  assert.deepEqual(folderEntries(files, 'guides').map(({ path }) => path), ['guides/deep', 'guides/onboarding.md', 'guides/Readme.md']);
  assert.equal(readmeIn(files, 'guides')?.path, 'guides/Readme.md');
  assert.equal(readmeIn(files, 'assets'), null);
});

test('relative Markdown links and images resolve inside the knowledge base only', () => {
  assert.equal(resolveLink('onboarding.md#first-day', 'guides/Readme.md', files, 'p1'), '#/knowledge/p1/blob/guides/onboarding.md?section=first-day');
  assert.equal(resolveLink('../README.md', 'guides/onboarding.md', files, 'p1'), '#/knowledge/p1/blob/README.md');
  assert.equal(resolveLink('deep/', 'guides/onboarding.md', files, 'p1'), '#/knowledge/p1/tree/guides/deep');
  assert.equal(resolveLink('#first-day', 'guides/onboarding.md', files, 'p1'), '#/knowledge/p1/blob/guides/onboarding.md?section=first-day');
  for (const href of ['../../outside.md', 'missing.md', '/README.md', 'https://example.test/x.md', 'javascript:alert(1)', '//host/x', 'a\\b.md']) {
    assert.equal(resolveLink(href, 'guides/onboarding.md', files, 'p1'), null, href);
  }
  assert.equal(resolveImage('../assets/logo.png', 'guides/onboarding.md', files, 'p1'), '/api/projects/p1/knowledge/content?path=assets%2Flogo.png');
  assert.equal(resolveImage('../README.md', 'guides/onboarding.md', files, 'p1'), null);
});

test('search words are marked inside escaped text', () => {
  assert.deepEqual(searchTerms('  Short  short MONTHS '), ['short', 'months']);
  assert.equal(highlight('<b>Short</b> months', ['short'], esc), '&lt;b&gt;<mark>Short</mark>&lt;/b&gt; months');
  assert.equal(highlight('a.b', ['.'], esc), 'a<mark>.</mark>b');
});

test('file shapes, transports and failure reasons have plain names', () => {
  assert.deepEqual(['README.md', 'a.yml', 'b.svg', 'c.pdf', 'd.bin'].map((path) => iconKind(path)), ['readme', 'config', 'image', 'pdf', 'file']);
  assert.equal(iconKind('guides', true), 'folder');
  assert.equal(transportOf('git@gitlab.com:group/sub/docs.git'), 'ssh');
  assert.equal(transportOf('ssh://git@host:2222/docs.git'), 'ssh');
  assert.equal(transportOf('https://host/docs.git'), 'https');
  assert.equal(transportOf('http://host/docs.git'), null);
  assert.equal(originOf('https://reader@Git.Example.test:443/team/docs.git'), 'https://git.example.test');
  assert.equal(originOf('https://git.example.test:8443/docs.git'), 'https://git.example.test:8443');
  assert.equal(originOf('git@git.example.test:team/docs.git'), null);
  assert.match(failureText('repository_moved'), /new URL/);
  assert.match(failureText('auth_failed'), /refused/);
  assert.equal(failureText('unknown_code'), failureText('sync_failed'));
});
