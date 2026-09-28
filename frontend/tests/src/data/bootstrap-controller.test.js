import assert from 'node:assert/strict';
import test from 'node:test';
import { createBootstrapController } from '../../../src/data/bootstrap-controller.js';
import { createLegacyData } from '../../../src/data/projection-store.js';

const projection = (zone) => ({timeZone:zone,session:{userId:'u1'},users:[],projects:[],memberships:[],tracks:[],epics:[],milestones:[],tasks:[],pool:[],notifications:[],browserSessions:[],appGrants:[]});

test('a slower prior bootstrap cannot replace a newer route projection', async () => {
  const pending=[];
  const api={bootstrap:({signal})=>new Promise((resolve,reject)=>{pending.push({resolve,reject,signal});})};
  const data=createLegacyData();
  const controller=createBootstrapController({api,data});
  const first=controller.load({projectId:'p1'});
  const second=controller.load({projectId:'p2'});
  pending[1].resolve(projection('Asia/Tashkent'));
  assert.equal((await second).stale,false);
  pending[0].resolve(projection('UTC'));
  assert.equal((await first).stale,true);
  assert.equal(data.timeZone,'Asia/Tashkent');
});
