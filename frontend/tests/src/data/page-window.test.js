import assert from 'node:assert/strict';
import test from 'node:test';
import {refreshPageWindow} from '../../../src/data/page-window.js';

test('refresh removes recent reverted rows even when all fresh raw events are hidden by the renderer',()=>{
  const previous=[{id:'old',ts:1},{id:'reverted',ts:3}];
  assert.deepEqual(refreshPageWindow(previous,[],true,item=>item.ts,2),[previous[0]]);
  assert.deepEqual(refreshPageWindow(previous,[],false,item=>item.ts),[]);
});

test('refresh retains older pages and updates matching stable rows without duplicates',()=>{
  const previous=[{id:'older',ts:1},{id:'changed',ts:2},{id:'removed',ts:3}];
  assert.deepEqual(refreshPageWindow(previous,[{id:'changed',ts:4}],true,item=>item.ts,2),[{id:'older',ts:1},{id:'changed',ts:4}]);
});
