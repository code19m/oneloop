import assert from 'node:assert/strict';
import test from 'node:test';
import { createBootstrapController } from '../../../src/data/bootstrap-controller.js';
import { createCommandGateway } from '../../../src/data/command-gateway.js';
import { createLegacyData, hydrateLegacyData } from '../../../src/data/projection-store.js';
import { settle } from '../../support/helpers.cjs';

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
  await settle();assert.equal(idle,false);
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

test('a Roadmap bootstrap reads the days its project\'s lanes hold again, and none for a tab that shows no lanes', async () => {
  const asked=[],data=signedIn();
  const controller=createBootstrapController({api:{bootstrap:async(scope)=>{asked.push(scope.roadmap);return projection('UTC');}},data});
  // The first load of the Roadmap's address, which names no project.
  assert.equal((await controller.load({view:'roadmap'})).stale,false);
  // Each load starts from lanes of p1, which a bootstrap without lanes forgets.
  for(const scope of [{view:'roadmap',projectId:'p1'},{view:'roadmap',projectId:'p2'},{view:'board',projectId:'p1'}]){
    data.roadmap={projectId:'p1',window:{from:'2026-01-01',to:'2026-12-31'}};
    await controller.load(scope);
  }
  assert.deepEqual(asked,[undefined,{from:'2026-01-01',to:'2026-12-31'},undefined,undefined]);
});

/** A task as the server sends it, in Planning at `position`. */
const card = (id, position, revision = 1) => ({id,projectId:'p1',epicId:'e1',taskKey:id.toUpperCase(),title:id,description:'',status:'planning',position,createdAt:1,updatedAt:1,revision,assigneeIds:[],activeBlock:null});
const withTasks = (tasks) => ({...projection('UTC'),tasks});

test('a live bootstrap never undoes a card the tab moves, adds or deletes while it loads', async () => {
  // What each change sends, what the server answers, and the cards the tab then shows.
  const changes = {
    move: {send: (gateway) => gateway.execute('task.move',{taskId:'c',status:'planning',position:0},{expectedRevision:1}), saved: [card('c',0,2)], shown: ['c','a','b'], server: [card('c',0,2),card('a',1),card('b',2)]},
    add: {send: (gateway) => gateway.execute('task.create',{projectId:'p1',epicId:'e1',title:'d'}), saved: [card('d',0)], shown: ['a','b','c','d'], server: [card('d',0),card('a',1),card('b',2),card('c',3)]},
    delete: {send: (gateway) => gateway.execute('task.delete',{id:'b'},{expectedRevision:1}), saved: [{id:'b',deleted:true,revision:2}], shown: ['a','c'], server: [card('a',1),card('c',3)]},
  };
  for (const [kind, first] of [['move','command'],['move','load'],['add','command'],['delete','command']]) {
    const {send, saved, shown, server} = changes[kind], label = `${kind}, ${first} answers first`;
    const requests = [], held = (name) => (...args) => new Promise((resolve) => requests.push({name,args,resolve}));
    const api = {bootstrap: held('bootstrap'), command: held('command')};
    const data = signedIn();hydrateLegacyData(data,withTasks([card('a',1),card('b',2),card('c',3)]));
    const gateway = createCommandGateway({api,data}), controller = createBootstrapController({api,data,writes:gateway});
    const loads = () => requests.filter((request) => request.name === 'bootstrap');
    // A move shows at once, as the Board shows its own moves; the order matters only for it.
    const cards = () => { const ids = data.tasks.map((task) => task.internalId); return kind === 'move' ? ids : ids.sort(); };
    const live = controller.load({background:true});await settle();
    if (kind === 'move') { const moved = data.tasks.find((task) => task.internalId === 'c'); data.tasks.splice(data.tasks.indexOf(moved),1); data.tasks.unshift(moved); moved.order = data.tasks[1].order - 1; }
    const sent = send(gateway);await settle();
    const command = requests.find((request) => request.name === 'command'), answer = {entities: saved.map((entity) => ({entityType:'task',...entity})), events: []};
    // The load answers from before the change.
    const before = withTasks([card('a',1),card('b',2),card('c',3)]);
    if (first === 'command') { command.resolve(answer);await sent;loads()[0].resolve(before); }
    else { loads()[0].resolve(before);await settle();assert.deepEqual(cards(),shown,`${label}: the move stays while it is saved`);command.resolve(answer);await sent; }
    await settle();
    assert.deepEqual(cards(),shown,`${label}: the tab's change stays`);
    assert.equal(loads().length,2,`${label}: it loads again once the change is saved`);
    loads()[1].resolve(withTasks(server));
    assert.equal((await live).stale,false);
    assert.deepEqual(cards(),shown,label);
  }
});
