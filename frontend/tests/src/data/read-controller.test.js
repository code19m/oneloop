import assert from 'node:assert/strict';
import test from 'node:test';
import {createReadController} from '../../../src/data/read-controller.js';
import {createLegacyData} from '../../../src/data/projection-store.js';
import {saveDoneOrder} from '../../../src/data/done-order.js';

const task=(id,status)=>({id,projectId:'p1',epicId:'e1',taskKey:`BIR-${id}`,title:id,description:'',status,position:1,deadline:null,createdAt:1_800_000_000_000,updatedAt:1_800_000_000_000,revision:1,assigneeIds:[],activeBlock:null});

test('board reads all statuses with server-wide filters and appends only explicit next pages',async()=>{
  const calls=[];
  const page=(status)=>({items:[task(status,status)],nextCursor:status==='planning'?'next':null,total:status==='planning'?2:1});
  const api={
    boardView:async(_project,filters)=>{calls.push(['view',filters]);return {planning:page('planning'),inProgress:page('in_progress'),inReview:page('in_review'),done:page('done'),counts:{planning:2,inProgress:1,inReview:1,done:1,blocked:0}};},
    board:async(_project,filters)=>{calls.push(['page',filters]);return page(filters.status);},
  };
  const data=createLegacyData();let paints=0;
  const reads=createReadController({api,data,onBoard:()=>paints++});
  await reads.board('p1',{search:'checkout',trackIds:['t1'],assigneeIds:['u1','__unassigned__'],blocked:true});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'view');assert.equal(calls[0][1].search,'checkout');assert.equal(calls[0][1].blocked,true);assert.equal(calls[0][1].noAssignee,true);
  assert.equal(data.tasks.length,4);assert.equal(paints,1);
  await reads.moreBoard('planning');
  assert.equal(calls.at(-1)[1].cursor,'next');assert.equal(data.tasks.length,4);assert.equal(paints,1); // the bridge owns the single append paint
});

test('unfiltered board counts and Pool pagination stay server authoritative',async()=>{
  const api={
    boardView:async(_project,filters)=>({planning:{items:[],nextCursor:filters.limit===1?null:'tasks-next',total:80},inProgress:{items:[],nextCursor:null,total:4},inReview:{items:[],nextCursor:null,total:3},done:{items:[],nextCursor:null,total:20},counts:{planning:80,inProgress:4,inReview:3,done:20,blocked:6}}),
    board:async()=>({items:[],nextCursor:null,total:0}),
    pool:async(_project,filters)=>({items:[{id:filters.cursor?'pool-2':'pool-1',projectId:'p1',scope:filters.scope,ownerUserId:'u1',title:'Item',description:'',createdAt:1,revision:1}],nextCursor:filters.cursor?null:'pool-next',total:2}),
  };
  const data=createLegacyData();
  const reads=createReadController({api,data});
  await reads.board('p1');
  assert.deepEqual(data.projectTaskCounts.p1,{planning:80,progress:4,review:3,done:20,blocked:6,open:87});
  assert.equal(data.boardPageInfo.pages.planning.nextCursor,'tasks-next');
  await reads.pool('p1','personal');
  assert.equal(data.poolPageInfo['p1:mine'].total,2);
  await reads.morePool('p1','personal');
  assert.equal(data.pool.length,2);
  assert.equal(data.poolPageInfo['p1:mine'].nextCursor,null);
});

test('epic panel uses independent bounded task and audit cursors',async()=>{
  const calls=[];
  const api={
    epicTasks:async(_id,options)=>{calls.push(['tasks',options.cursor]);return {items:[task(options.cursor?'t2':'t1','planning')],nextCursor:options.cursor?null:'tasks-next',total:2};},
    epicActivity:async(_id,options)=>{calls.push(['activity',options.cursor]);return {items:[{id:options.cursor?'a2':'a1',entityType:'epic',entityId:'e1',eventType:'epic.updated',fieldKey:'title',actorUserId:'u1',actorName:'Owner',before:'A',after:'B',metadata:{},createdAt:options.cursor?1:2}],nextCursor:options.cursor?null:'activity-next'};},
  };
  const data=createLegacyData();
  data.epics.push({id:'e1',activity:[]});data.users.push({id:'u1',name:'Owner'});
  const reads=createReadController({api,data});
  await reads.epic('e1');
  assert.deepEqual(calls,[['tasks',undefined],['activity',undefined]]);
  assert.equal(data.epicPageInfo.e1.tasksCursor,'tasks-next');
  assert.equal(data.epicPageInfo.e1.activityCursor,'activity-next');
  await reads.moreEpicTasks('e1');
  await reads.moreEpicActivity('e1');
  assert.deepEqual(calls.slice(2),[['tasks','tasks-next'],['activity','activity-next']]);
  assert.deepEqual(data.epicPageInfo.e1.taskIds,['t1','t2']);
  assert.deepEqual(data.epics[0].activity.map((item)=>item.id),['a2','a1']);
});

test('count-only reads do not fetch cards and initial Board pagination is adopted',async()=>{
  let countReads=0;const data=createLegacyData();
  const api={counts:async()=>{countReads++;return {planning:80,inProgress:4,inReview:3,done:20,blocked:6};},board:async(_id,filters)=>({items:[],nextCursor:null,total:80})};
  const reads=createReadController({api,data});await reads.counts('p1');assert.equal(countReads,1);
  assert.equal(data.projectTaskCounts.p1.open,87);assert.equal(data.tasks.length,0);
  data.bootstrapView='board';data.boardPageInfo={projectId:'p1',pages:{planning:{nextCursor:'next',total:80}}};
  assert.equal(reads.adoptBoard('p1',{search:'filter'}),false);assert.equal(reads.adoptBoard('p1'),true);
  await reads.moreBoard('planning');assert.equal(data.boardPageInfo.pages.planning.nextCursor,null);
});

test('stale task cursors replace the collection and retain Board filters',async()=>{
  const data=createLegacyData();let views=0;const filters=[];
  const empty={items:[],nextCursor:null,total:0};
  const api={
    boardView:async(_id,filter)=>{filters.push(filter);views++;return {planning:{items:[task(`fresh-${views}`,'planning')],nextCursor:'page',total:2},inProgress:empty,inReview:empty,done:empty,counts:{}};},
    board:async()=>{throw {code:'cursor_stale'};},
  };
  const reads=createReadController({api,data});
  await reads.board('p1',{search:'needle',trackIds:['tr'],assigneeIds:['__unassigned__']});
  await reads.moreBoard('planning');
  assert.equal(views,2);assert.deepEqual(filters[1],filters[0]);
  assert.deepEqual(data.tasks.map(t=>t.internalId),['fresh-2']);
});

test('stale epic task cursor restarts tasks without losing independent activity',async()=>{
  const data=createLegacyData();data.epics.push({id:'e1',activity:[]});let reads=0;
  const api={epicTasks:async(_id,options)=>{if(options.cursor)throw {code:'cursor_stale'};return {items:[task(`fresh-${++reads}`,'planning')],nextCursor:'page',total:2};},epicActivity:async()=>({items:[],nextCursor:'older'})};
  const reader=createReadController({api,data});await reader.epic('e1');await reader.moreEpicTasks('e1');
  assert.equal(reads,2);assert.deepEqual(data.epicPageInfo.e1.taskIds,['fresh-2']);assert.equal(data.epicPageInfo.e1.activityCursor,'older');
});

test('three Board pages survive targeted hints, navigation and a bootstrap generation change',async()=>{
  const data=createLegacyData(),calls=[];
  const item=(id)=>({...task(String(id),'done'),position:id});
  const page=(offset)=>({items:[item(offset+1),item(offset+2)],nextCursor:offset<6?String(offset+2):null,total:8});
  const api={
    boardView:async()=>{calls.push('view');return {planning:{items:[],total:0},inProgress:{items:[],total:0},inReview:{items:[],total:0},done:page(0),counts:{planning:0,inProgress:0,inReview:0,done:8,blocked:0}};},
    board:async(_id,filter)=>{calls.push(`page:${filter.cursor}`);return page(Number(filter.cursor));},
    task:async id=>{calls.push(`task:${id}`);return {...item(Number(id)),title:'Changed',revision:2};},
    counts:async()=>{calls.push('counts');return {planning:0,inProgress:0,inReview:0,done:8,blocked:0};},
  };
  const reads=createReadController({api,data});
  await reads.board('p1');await reads.moreBoard('done');await reads.moreBoard('done');
  calls.length=0;
  await reads.patchBoard('p1',{},[{entityType:'task',entityId:'5'}]);
  assert.deepEqual(calls,['task:5','counts']);assert.equal(data.tasks.length,6);
  assert.equal(data.tasks.find(row=>row.internalId==='5').title,'Changed');assert.equal(data.boardPageInfo.pages.done.nextCursor,'6');
  reads.cancel({preserveBoard:true});calls.length=0;
  await reads.board('p1',{}, {skipUnchanged:true});assert.deepEqual(calls,[]);assert.equal(data.tasks.length,6);
  data.projectionGeneration++;data.tasks.splice(0);
  await reads.board('p1',{}, {skipUnchanged:true});assert.deepEqual(calls,['view','page:2','page:4']);assert.equal(data.tasks.length,6);
  await reads.moreBoard('done');assert.equal(data.tasks.length,8);
});

test('Board hint removes deleted or filtered-out cards and ignores tasks beyond the loaded window',async()=>{
  const data=createLegacyData();let changed;
  const api={boardView:async()=>({planning:{items:[task('one','planning')],nextCursor:'next',total:9},inProgress:{items:[],total:0},inReview:{items:[],total:0},done:{items:[],total:0},counts:{planning:9,inProgress:0,inReview:0,done:0,blocked:0}}),task:async()=>changed,counts:async()=>({planning:9,inProgress:0,inReview:0,done:0,blocked:0})};
  const reads=createReadController({api,data});await reads.board('p1');
  changed={...task('far','planning'),position:99};await reads.patchBoard('p1',{},[{entityId:'far'}]);assert.equal(data.tasks.length,1);
  api.task=async()=>{throw {status:404};};await reads.patchBoard('p1',{},[{entityId:'one'}]);assert.equal(data.tasks.length,0);assert.equal(data.boardPageInfo.pages.planning.nextCursor,'next');
});

test('a newest-first Done reads, adopts and patches the Done column in completion order',async(t)=>{
  saveDoneOrder('completed',undefined);t.after(()=>saveDoneOrder('manual',undefined));
  const calls=[],data=createLegacyData();let changed;
  const done=(id,completedAt)=>({...task(id,'done'),completedAt});
  const api={
    boardView:async(_project,filters)=>{calls.push(['view',filters]);return {planning:{items:[],total:0},inProgress:{items:[],total:0},inReview:{items:[],total:0},done:{items:[done('later',300),done('earlier',200)],nextCursor:'done-next',total:9},counts:{planning:0,inProgress:0,inReview:0,done:9,blocked:0}};},
    board:async(_project,filters)=>{calls.push(['page',filters]);return {items:[done('earliest',100)],nextCursor:'older',total:9};},
    task:async()=>changed,counts:async()=>({planning:0,inProgress:0,inReview:0,done:10,blocked:0}),
  };
  const reads=createReadController({api,data});
  data.bootstrapView='board';data.boardPageInfo={projectId:'p1',filters:{},pages:{done:{nextCursor:null,total:9}}};
  assert.equal(reads.adoptBoard('p1'),false,'Board pages in manual order are not reused');
  data.boardPageInfo.filters={doneOrder:'completed'};assert.equal(reads.adoptBoard('p1'),true);
  await reads.board('p1');
  assert.equal(calls[0][1].doneOrder,'completed');
  await reads.moreBoard('done');
  assert.equal(calls[1][1].doneOrder,'completed');assert.equal(calls[1][1].status,'done');
  changed=done('finished-now',400);
  await reads.patchBoard('p1',{},[{entityId:'finished-now'}]);
  changed=done('long-ago',50);
  await reads.patchBoard('p1',{},[{entityId:'long-ago'}]);
  assert.deepEqual(data.tasks.filter(item=>item.state==='done').map(item=>item.internalId),['finished-now','later','earlier','earliest'],'only cards inside the loaded window join it');
});

test('a Board hint waits for foreground pagination instead of aborting or discarding it',async()=>{
  const data=createLegacyData();let release,signal;
  const gate=new Promise(resolve=>{release=resolve;});
  const counts={planning:3,inProgress:0,inReview:0,done:0,blocked:0};
  const api={boardView:async()=>({planning:{items:[task('one','planning')],nextCursor:'next',total:3},inProgress:{items:[],total:0},inReview:{items:[],total:0},done:{items:[],total:0},counts}),board:async(_id,_filter,options)=>{signal=options.signal;await gate;return {items:[task('two','planning')],nextCursor:'last',total:3};},counts:async()=>counts,task:async()=>({...task('one','planning'),title:'Updated'})};
  const reads=createReadController({api,data});await reads.board('p1');
  const page=reads.moreBoard('planning'),hint=reads.patchBoard('p1',{},[{entityId:'one'}]);assert.equal(signal.aborted,false);release();await Promise.all([page,hint]);
  assert.equal(data.tasks.length,2);assert.equal(data.boardPageInfo.pages.planning.nextCursor,'last');assert.equal(data.tasks.find(row=>row.internalId==='one').title,'Updated');
});

test('a stale deep Board cursor discards the old window before restarting',async()=>{
  const data=createLegacyData();let views=0,pages=0;
  const empty={items:[],nextCursor:null,total:0};
  const api={
    boardView:async()=>({planning:{items:[task(`head-${++views}`,'planning')],nextCursor:'next',total:4},inProgress:empty,inReview:empty,done:empty,counts:{}}),
    board:async()=>{if(++pages>1)throw {code:'cursor_stale'};return {items:[task('older','planning')],nextCursor:'last',total:4};},
  };
  const reads=createReadController({api,data});
  await reads.board('p1');await reads.moreBoard('planning');
  assert.equal(data.tasks.length,2);
  await reads.moreBoard('planning');
  assert.deepEqual(data.tasks.map(item=>item.internalId),['head-2']);
  assert.equal(pages,2,'restart does not follow cursors from the old loaded depth');
});
