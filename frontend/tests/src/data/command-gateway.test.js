import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../../../src/data/api-client.js';
import { createCommandGateway } from '../../../src/data/command-gateway.js';
import { createLegacyData, hydrateLegacyData } from '../../../src/data/projection-store.js';

function seededData() {
  const data=createLegacyData();
  hydrateLegacyData(data,{timeZone:'UTC',session:{userId:'u1'},users:[],projects:[],memberships:[],tracks:[],epics:[],milestones:[],tasks:[],pool:[],notifications:[],browserSessions:[],appGrants:[]});
  return data;
}

test('uncertain commands retry with the exact prepared identity and do not auto retry', async () => {
  const calls=[];
  const api={command:async command=>{calls.push(command);if(calls.length===1)throw new ApiError('Network',{uncertain:true});return {entities:[],events:[],replayed:true};}};
  const data=seededData(),errors=[];
  const gateway=createCommandGateway({api,data,onError:(error,context)=>errors.push(context)});
  await assert.rejects(gateway.execute('task.create',{projectId:'p1'},{interactionKey:'form:new'}));
  assert.equal(calls.length,1);
  assert.equal(gateway.hasUncertain('form:new'),true);
  await gateway.retry('form:new');
  assert.equal(calls.length,2);
  assert.equal(calls[0],calls[1]);
  assert.equal(errors[0].uncertain,true);
});

test('duplicate submits in one interaction share the in-flight request', async () => {
  let release;
  const api={command:()=>new Promise(resolve=>{release=resolve;})};
  const gateway=createCommandGateway({api,data:seededData()});
  const first=gateway.execute('task.create',{projectId:'p1'},{interactionKey:'form:new'});
  const second=gateway.execute('task.create',{projectId:'p1'},{interactionKey:'form:new'});
  assert.equal(first,second);
  release({entities:[],events:[],replayed:false});
  await first;
});

test('a different value in the same pending interaction is never reported as the earlier save', async()=>{
  let release;
  const calls=[];
  const api={command:(command)=>{calls.push(command);return new Promise(resolve=>{release=resolve;});}};
  const gateway=createCommandGateway({api,data:seededData()});
  const first=gateway.execute('task.update',{taskId:'t1',title:'First'},{expectedRevision:1,interactionKey:'task-title'});
  await assert.rejects(
    gateway.execute('task.update',{taskId:'t1',title:'Second'},{expectedRevision:1,interactionKey:'task-title'}),
    (error)=>error instanceof ApiError&&error.code==='interaction_pending',
  );
  assert.equal(calls.length,1);
  release({entities:[],events:[],replayed:false});
  await first;
});

test('editing after an uncertain result starts the new intent instead of retrying stale input',async()=>{
  const calls=[];
  const api={command:async(command)=>{calls.push(command);if(calls.length===1)throw new ApiError('Network',{uncertain:true});return {entities:[],events:[],replayed:false};}};
  const gateway=createCommandGateway({api,data:seededData()});
  await assert.rejects(gateway.execute('task.update',{taskId:'t1',title:'First'},{expectedRevision:1,interactionKey:'task-title'}));
  await gateway.execute('task.update',{taskId:'t1',title:'Second'},{expectedRevision:1,interactionKey:'task-title'});
  assert.equal(calls.length,2);
  assert.equal(calls[0].payload.title,'First');
  assert.equal(calls[1].payload.title,'Second');
  assert.notEqual(calls[0].idempotencyKey,calls[1].idempotencyKey);
  assert.equal(gateway.hasUncertain('task-title'),false);
});

test('responses and uncertain retries never cross browser sessions', async()=>{
  let session='first',release;
  const api={command:()=>new Promise(resolve=>{release=resolve;})};
  const data=seededData(),changes=[];
  const gateway=createCommandGateway({api,data,getScope:()=>session,onChange:result=>changes.push(result)});
  const pending=gateway.execute('task.create',{projectId:'p1'},{interactionKey:'form:new'});
  session='second';
  release({entities:[{entityType:'project',id:'stale',name:'Stale',taskPrefix:'OLD',revision:1}],events:[],replayed:false});
  const result=await pending;
  assert.equal(result.stale,true);
  assert.equal(data.projects.some(project=>project.id==='stale'),false);
  assert.deepEqual(changes,[]);

  const uncertainApi={command:async()=>{throw new ApiError('Network',{uncertain:true});}};
  session='first';
  const uncertain=createCommandGateway({api:uncertainApi,data,getScope:()=>session});
  await assert.rejects(uncertain.execute('task.create',{projectId:'p1'},{interactionKey:'form:new'}));
  assert.equal(uncertain.hasUncertain('form:new'),true);
  session='second';
  assert.equal(uncertain.hasUncertain('form:new'),false);
});
