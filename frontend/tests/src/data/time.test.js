import test from 'node:test';
import assert from 'node:assert/strict';
import {secondsToMilliseconds} from '../../../src/data/time.js';

test('API seconds use one explicit conversion, including far-future and negative instants',()=>{
  for(const seconds of [0,-1,1_800_000_000,100_000_000_001])assert.equal(secondsToMilliseconds(seconds),seconds*1000);
  for(const value of [null,undefined,NaN,Infinity])assert.equal(secondsToMilliseconds(value),undefined);
});
