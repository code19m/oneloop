// views/app.js: the Knowledge page's place in the shell. The page itself is
// src/features/knowledge/controller.js; a recording stand-in takes its place here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('../../support/dom.cjs');

/** Boot with a stand-in Knowledge controller that records the shell's calls. */
function boot(route, { admin = true } = {}) {
  const calls = [];
  const t = bootApp({
    route,
    setup: (w) => {
      w.OneloopKnowledge = {
        route: (value, projectId) => { calls.push(['route', value, projectId]); const named = value.split('/')[1]; return named || projectId; },
        render: (projectId) => { calls.push(['render', projectId]); return `<div class="knowledge-workspace" data-project="${projectId}">Knowledge page</div>`; },
        topbar: () => '<h1>Knowledge</h1>',
        beforeRender: () => calls.push(['beforeRender']),
        mount: () => calls.push(['mount']),
        settingsHtml: (projectId) => `<div class="section" id="knowledge-settings">Knowledge base ${projectId}</div>`,
        modalHtml: () => '<h2>Connect repository</h2><form data-knowledge-form></form>',
      };
    },
    prepare: (D) => { D.users.find((user) => user.id === D.session.userId).admin = admin; },
  });
  return { ...t, calls };
}

test('every member can open Knowledge from the sidebar, which routes, renders and mounts it', () => {
  for (const admin of [true, false]) {
    const t = boot('board', { admin });
    const item = [...t.d.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('Knowledge'));
    assert(item, 'the nav item is shown');
    t.A.nav('knowledge');
    assert.equal(t.w.location.hash, '#/knowledge');
    assert.deepEqual(t.calls.find(([name]) => name === 'route'), ['route', 'knowledge', 'p1']);
    assert.equal(t.d.querySelector('main .knowledge-workspace').dataset.project, 'p1');
    assert.equal(t.d.querySelector('.topbar h1').textContent, 'Knowledge');
    assert.equal(t.d.title, 'Knowledge · Birch Grove · oneloop');
    assert.equal(t.d.querySelector('.nav-item.on').getAttribute('aria-current'), 'page');
    assert.ok(t.calls.findIndex(([name]) => name === 'beforeRender') < t.calls.findLastIndex(([name]) => name === 'mount'));
  }
});

test('a Knowledge link names its project; an unknown project is not found', () => {
  const t = boot('knowledge/p2/tree/guides');
  assert.equal(t.d.querySelector('main .knowledge-workspace').dataset.project, 'p2');
  assert.match(t.d.querySelector('.switcher-btn').textContent, /oneloop/);
  t.w.location.hash = '#/knowledge/missing/tree';
  t.w.dispatchEvent(new t.w.HashChangeEvent('hashchange', { oldURL: 'http://localhost/#/knowledge/p2/tree/guides', newURL: t.w.location.href }));
  assert.match(t.d.querySelector('.page-error h2').textContent, /Page not found/);
});

test('switching projects keeps the Knowledge page and starts at its top folder', () => {
  const t = boot('knowledge/p1/tree/guides');
  t.A.selectProject('p2');
  assert.equal(t.w.location.hash, '#/knowledge');
  assert.deepEqual(t.calls.filter(([name]) => name === 'route').at(-1), ['route', 'knowledge', 'p2']);
  assert.equal(t.d.querySelector('main .knowledge-workspace').dataset.project, 'p2');
});

test('only administrators see the Knowledge base settings and its connection dialog', () => {
  const t = boot('settings');
  assert.match(t.d.querySelector('#knowledge-settings').textContent, /Knowledge base p1/);
  const sections = [...t.d.querySelectorAll('.settings .section h2')].map((heading) => heading.textContent.trim());
  assert.ok(sections.indexOf('Danger zone') > sections.findIndex((text) => text.startsWith('Project access')));
  t.A.openModal('knowledge');
  assert.equal(t.d.querySelector('.modal #modal-title').textContent, 'Connect repository');
  t.A.closeOverlays();
  const member = boot('knowledge', { admin: false });
  member.A.openModal('knowledge');
  assert.equal(member.d.querySelector('.modal'), null);
});
