import test from 'node:test';
import assert from 'node:assert/strict';
import {secondsToMilliseconds} from '../../../src/data/time.js';
import {mapComment} from '../../../src/features/collaboration/controller.js';
import {mapActivity} from '../../../src/data/activity-mapper.js';

test('API seconds use one explicit conversion, including far-future and negative instants',()=>{
  for(const seconds of [0,-1,1_800_000_000,100_000_000_001]){
    assert.equal(secondsToMilliseconds(seconds),seconds*1000);
    assert.equal(mapComment({id:'c',content:'hi',createdAt:seconds}).ts,seconds*1000);
    assert.equal(mapActivity({eventType:'task.created',createdAt:seconds}).ts,seconds*1000);
  }
  for(const value of [null,undefined,NaN,Infinity])assert.equal(secondsToMilliseconds(value),undefined);
});
