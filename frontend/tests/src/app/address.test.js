import assert from 'node:assert/strict';
import test from 'node:test';
import { lastSwitch, projectAddress, readAddress, rememberSwitch } from '../../../src/app/address.js';
import { NO_ASSIGNEE } from '../../../src/data/board-filters.js';

const unfiltered = { search: '', trackIds: [], epicIds: [], assigneeIds: [], blocked: false };

test('a Board address carries only the filters that are on, in a fixed order, and reads back the same', () => {
  const filters = { search: 'login page', trackIds: ['t2', 't1'], epicIds: ['e1'], assigneeIds: ['u2', NO_ASSIGNEE], blocked: true };
  const address = projectAddress('board', 'p1', { filters });
  assert.equal(address, '#/board/p1?search=login%20page&track=t1,t2&epic=e1&assignee=none,u2&blocked=1');
  assert.deepEqual(readAddress(address), { page: 'board', projectId: 'p1', taskId: null, filters: { ...filters, trackIds: ['t1', 't2'], assigneeIds: [NO_ASSIGNEE, 'u2'] }, scale: null });
  assert.equal(projectAddress('board', 'p1', { filters: unfiltered }), '#/board/p1');
  assert.deepEqual(readAddress('#/board/p1?search=a+b&track=t1,,t1&blocked=yes').filters, { ...unfiltered, search: 'a b', trackIds: ['t1'] });
});

test('each page reads its project, task or nothing from the address, and an address it can\'t read is not found', () => {
  const page = (hash) => { const { page: name, projectId, taskId } = readAddress(hash); return [name, projectId, taskId]; };
  assert.deepEqual([
    '#/roadmap/p1', '#/settings/p%2F1', '#/knowledge/p1/blob/guides/a.md?section=x', '#/task/ONE-1', '#/inbox',
    '', '#/', '#/board', '#/knowledge',
    '#/board/p1/extra', '#/board/%E0%A4%A', '#/task/%E0%A4%A', '#/missing', '#/inbox/x',
  ].map(page), [
    ['roadmap', 'p1', null], ['settings', 'p/1', null], ['knowledge', 'p1', null], ['task', null, 'ONE-1'], ['inbox', null, null],
    ['roadmap', null, null], ['roadmap', null, null], ['board', null, null], ['knowledge', null, null],
    ['notfound', null, null], ['notfound', null, null], ['notfound', null, null], ['notfound', null, null], ['notfound', null, null],
  ]);
  assert.equal(projectAddress('settings', 'p/1'), '#/settings/p%2F1');
});

test('this browser remembers the last switch with its person, only that person forgets it, and storage it may not use changes nothing', () => {
  const values = new Map(), storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  assert.equal(lastSwitch(storage), null);
  rememberSwitch('u1', 'p2', storage);
  assert.deepEqual(lastSwitch(storage), { userId: 'u1', projectId: 'p2' });
  rememberSwitch('u2', null, storage);
  assert.deepEqual(lastSwitch(storage), { userId: 'u1', projectId: 'p2' });
  rememberSwitch('u1', null, storage);
  assert.equal(values.has('oneloop.project'), false);
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  rememberSwitch('u1', 'p2', blocked);
  assert.equal(lastSwitch(blocked), null);
});
