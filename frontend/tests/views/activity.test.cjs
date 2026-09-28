// views/activity.js: net-change activity projection.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { bootApp, source } = require('../support/dom.cjs');

const scope = { window: {} };
vm.runInNewContext(source('activity'), scope);
const A = scope.window.Activity;
const change = (obj, field, before, after, ts = 0, who = 'alice') => A.record(obj, who, `${field}: ${after}`, { field, before, after }, ts);

test('state changes collapse to their net change inside a fixed window', () => {
  const obj = {};
  change(obj, 'state', 'planning', 'progress'); change(obj, 'state', 'progress', 'review', 60000);
  assert.equal(A.visible(obj.activity).length, 1); assert.equal(A.visible(obj.activity)[0].change.before, 'planning'); assert.equal(A.visible(obj.activity)[0].change.after, 'review');
  change(obj, 'state', 'review', 'planning', 120000); assert.equal(A.visible(obj.activity).length, 0); assert.equal(obj.activity.length, 3); assert.equal(obj.activity[0].change.after, 'progress');
  change(obj, 'state', 'planning', 'done', 180000); assert.equal(A.visible(obj.activity).length, 1); assert.equal(A.visible(obj.activity)[0].startedAt, 0);
  change(obj, 'state', 'done', 'planning', 300001); assert.equal(A.visible(obj.activity).length, 2);
});

test('events keep stable order and field changes group per field', () => {
  const obj = {};
  A.record(obj, 'alice', 'created the task', null, 10); A.record(obj, 'alice', 'attached brief.pdf', null, 10);
  const ids = A.visible(obj.activity).map(event => event.id); assert.equal(ids.length, 2); assert.ok(ids[0] < ids[1]);
  const grouped = {};
  A.record(grouped, 'alice', 'updated title', { field: 'title', before: 'A', after: 'B' }, 20); A.record(grouped, 'alice', 'updated deadline', { field: 'deadline', before: null, after: '2026-10-01' }, 20);
  assert.equal(A.visible(grouped.activity).map(event => event.change.field).join(','), 'title,deadline');
});

test('reverted fields, assignees and retention toggles disappear from visible activity', () => {
  const obj = {};
  change(obj, 'title', 'A', 'B'); change(obj, 'deadline', null, '2026-10-01', 100); change(obj, 'title', 'B', 'A', 200);
  assert.equal(A.visible(obj.activity).length, 1); assert.equal(A.visible(obj.activity)[0].change.field, 'deadline');
  change(obj, 'assignee:bob', false, true, 300); change(obj, 'assignee:bob', true, false, 400); assert.equal(A.visible(obj.activity).length, 1);
  change(obj, 'attachment-retention:file1', false, true, 500); change(obj, 'attachment-retention:file1', true, false, 600); assert.equal(A.visible(obj.activity).length, 1);
});

test('actors, event boundaries, mismatches, no-ops and legacy entries stay separate', () => {
  const obj = {};
  change(obj, 'state', 'planning', 'progress'); change(obj, 'state', 'progress', 'review', 1, 'bob'); change(obj, 'state', 'review', 'planning', 2);
  assert.equal(A.visible(obj.activity).length, 3);
  const boundary = {}; change(boundary, 'title', 'A', 'B'); A.record(boundary, 'alice', 'removed a file', null, 1); change(boundary, 'title', 'B', 'A', 2); assert.equal(A.visible(boundary.activity).length, 3);
  const mismatch = {}; change(mismatch, 'title', 'A', 'B'); change(mismatch, 'title', 'C', 'A', 1); assert.equal(A.visible(mismatch.activity).length, 2);
  const noop = {}; change(noop, 'title', 'A', 'A'); assert.equal(noop.activity, undefined);
  const legacy = [{ who: 'alice', ts: 1, text: 'edited the epic' }, { who: 'alice', ts: 2, text: 'edited the epic' }]; assert.equal(A.visible(legacy).length, 2);
});

test('every editable scope uses the same projection and keeps raw history', () => {
  for (const field of ['title', 'desc', 'state', 'epicId', 'start', 'deadline', 'assignee:bob', 'trackId', 'end', 'block-reason:episode1', 'attachment-retention:file1', 'attachment-order', 'comment-content:comment1']) {
    const entity = {};
    change(entity, field, 'original', 'intermediate', 0); change(entity, field, 'intermediate', 'latest', 1000); assert.equal(A.visible(entity.activity).length, 1, field);
    change(entity, field, 'latest', 'original', 2000); assert.equal(A.visible(entity.activity).length, 0, field); assert.equal(entity.activity.length, 3);
  }
});

test('the task timeline and epic activity suppress reverted changes while keeping audit events', () => {
  const { w, d } = bootApp({ route: 'task/BIR-079' });
  const task = w.DATA.tasks.find(t => t.id === 'BIR-079'), title = task.title, deadline = task.deadline || '';
  w.App.updTask(task.id, 'state', 'progress'); assert.equal(d.querySelectorAll('.timeline .tl-act').length, 1);
  w.App.updTask(task.id, 'state', 'planning'); assert.equal(d.querySelectorAll('.timeline .tl-act').length, 0);
  w.App.updTask(task.id, 'title', 'Temporary title'); w.App.updTask(task.id, 'title', title); assert.equal(d.querySelectorAll('.timeline .tl-act').length, 0);
  w.App.updTask(task.id, 'deadline', '2026-09-01'); w.App.updTask(task.id, 'deadline', deadline); assert.equal(d.querySelectorAll('.timeline .tl-act').length, 0); assert.equal(task.activity.length, 6);
  const epic = w.DATA.epics.find(e => e.id === task.epicId), original = epic.title;
  const renameEpic = value => { w.App.openModal('epic', epic.id); const form = d.querySelector('.modal form'); form.querySelector('[name="title"]').value = value; w.App.saveEpic({ target: form, preventDefault() {} }, epic.id); };
  renameEpic('Temporary epic name'); renameEpic(original); assert.equal(w.Activity.visible(epic.activity).length, 0); assert.equal(epic.activity.length, 2);
  w.App.openPeek(epic.id); assert(!d.querySelector('.peek').textContent.includes('updated the epic title'));
  // A manually completed open-ended epic keeps completion semantics, even when empty.
  const ongoing = w.DATA.epics.find(e => !e.end); ongoing.state = 'done'; ongoing.total = 0; ongoing.done = 0; w.App.nav('roadmap');
  const ongoingBar = d.querySelector(`[data-epic="${ongoing.id}"].bar`);
  assert(ongoingBar.classList.contains('done')); assert(!ongoingBar.classList.contains('quiet')); assert(ongoingBar.querySelector('.m').textContent.includes('complete')); assert(!ongoingBar.querySelector('.m').textContent.includes('ongoing'));
});
