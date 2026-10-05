import assert from 'node:assert/strict';
import test from 'node:test';
import { savedDoneOrder, saveDoneOrder } from '../../../src/data/done-order.js';

const storage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), values };
};

test('the Done order is saved per browser and defaults to manual', () => {
  const saved = storage();
  assert.equal(savedDoneOrder(saved), 'manual');
  saveDoneOrder('completed', saved);
  assert.equal(saved.values.get('oneloop.doneOrder'), 'completed');
  assert.equal(savedDoneOrder(saved), 'completed');
  saveDoneOrder('manual', saved);
  assert.equal(saved.values.has('oneloop.doneOrder'), false);
  assert.equal(savedDoneOrder(saved), 'manual');
});

test('without storage the choice still holds for the page', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  saveDoneOrder('completed', blocked);
  assert.equal(savedDoneOrder(blocked), 'completed');
  saveDoneOrder('manual', blocked);
  assert.equal(savedDoneOrder(blocked), 'manual');
});

test('a saved choice is read again on the next page load', async () => {
  const saved = storage();
  saved.setItem('oneloop.doneOrder', 'completed');
  const reloaded = await import('../../../src/data/done-order.js?first-load');
  assert.equal(reloaded.savedDoneOrder(saved), 'completed');
  saved.setItem('oneloop.doneOrder', 'anything else');
  const again = await import('../../../src/data/done-order.js?second-load');
  assert.equal(again.savedDoneOrder(saved), 'manual');
});
