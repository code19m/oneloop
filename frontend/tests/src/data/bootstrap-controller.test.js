import assert from 'node:assert/strict';
import test from 'node:test';
import { createBootstrapController } from '../../../src/data/bootstrap-controller.js';
import { createLegacyData } from '../../../src/data/projection-store.js';

const projection = (zone, userId = 'u1') => ({timeZone:zone,session:{userId},users:[],projects:[],memberships:[],tracks:[],epics:[],milestones:[],tasks:[],pool:[],notifications:[],browserSessions:[],appGrants:[]});
/** The data root of a tab where `u1` is signed in. */
const signedIn = () => Object.assign(createLegacyData(), {session:{id:'s1',userId:'u1'}});

test('a slower prior bootstrap cannot replace a newer route projection', async () => {
  const pending=[];
  const api={bootstrap:({signal})=>new Promise((resolve,reject)=>{pending.push({resolve,reject,signal});})};
  const data=signedIn();
  const controller=createBootstrapController({api,data});
  const first=controller.load({projectId:'p1'});
  const second=controller.load({projectId:'p2'});
  pending[1].resolve(projection('Asia/Tashkent'));
  assert.equal((await second).stale,false);
  pending[0].resolve(projection('UTC'));
  assert.equal((await first).stale,true);
  assert.equal(data.timeZone,'Asia/Tashkent');
});

test('a live bootstrap never replaces a load someone started', async () => {
  const pending=[];
  const api={bootstrap:({signal,projectId})=>new Promise((resolve,reject)=>{pending.push({resolve,reject,signal,projectId});})};
  const data=signedIn();
  const controller=createBootstrapController({api,data});
  const chosen=controller.load({projectId:'p2'});
  let idle=false;const waiting=controller.idle().then(()=>{idle=true;});
  assert.deepEqual(await controller.load({projectId:'p1',background:true}),{stale:true});
  assert.equal(pending.length,1);assert.equal(pending[0].signal.aborted,false);
  await new Promise(setImmediate);assert.equal(idle,false);
  pending[0].resolve(projection('Asia/Tashkent'));
  assert.equal((await chosen).stale,false);await waiting;
  assert.equal(data.timeZone,'Asia/Tashkent');
});

test('a bootstrap for someone who signed in from another tab ends this tab\'s session instead of showing their data', async () => {
  const foreign=[];
  const data=signedIn();
  const controller=createBootstrapController({api:{bootstrap:async()=>projection('Asia/Tashkent','u2')},data,onForeign:(userId)=>foreign.push(userId)});
  assert.deepEqual(await controller.load({projectId:'p1'}),{stale:true});
  assert.deepEqual(foreign,['u2']);
  assert.equal(data.timeZone,'UTC');assert.equal(data.session.userId,'u1');
});

test('a tab where no one is signed in takes no bootstrap', async () => {
  const foreign=[];
  const data=createLegacyData();
  const controller=createBootstrapController({api:{bootstrap:async()=>projection('Asia/Tashkent')},data,onForeign:(userId)=>foreign.push(userId)});
  assert.deepEqual(await controller.load(),{stale:true});
  assert.deepEqual(foreign,[]);assert.equal(data.session,null);assert.equal(data.timeZone,'UTC');
});
