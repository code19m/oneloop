import assert from 'node:assert/strict';
import test from 'node:test';
import {createReadController} from '../../../src/data/read-controller.js';
import {createLegacyData} from '../../../src/data/projection-store.js';

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

/** An epic with `rows` tasks, two per page. Cursors carry the generation they were read at; a write makes older ones stale. */
function epicTasks(rows){
  const state={generation:1,rows,calls:[]};
  const page=(from)=>({items:state.rows.slice(from,from+2),nextCursor:from+2<state.rows.length?`${state.generation}:${from+2}`:null,total:state.rows.length});
  state.api={
    epicTasks:async(_id,options)=>{state.calls.push(options.cursor??'first');if(!options.cursor)return page(0);const [at,from]=options.cursor.split(':').map(Number);if(at!==state.generation)throw {code:'cursor_stale'};return page(from);},
    epicActivity:async()=>({items:[],nextCursor:'older'}),
  };
  return state;
}
const rows=count=>Array.from({length:count},(_,index)=>task(`row-${index}`,'planning'));

test('a stale epic task cursor reads the drawer tasks again with one more page',async()=>{
  const data=createLegacyData();data.epics.push({id:'e1',activity:[]});const epic=epicTasks(rows(6));
  const reads=createReadController({api:epic.api,data});
  await reads.epic('e1');await reads.moreEpicTasks('e1');
  epic.generation++;
  assert.equal((await reads.moreEpicTasks('e1')).stale,false);
  assert.deepEqual(data.epicPageInfo.e1.taskIds,epic.rows.map(item=>item.id),'the next page shows, read from fresh cursors');
  assert.equal(data.epicPageInfo.e1.activityCursor,'older');
});

test('a live read of the epic drawer keeps the pages of tasks it shows',async()=>{
  const data=createLegacyData();data.epics.push({id:'e1',activity:[]});const epic=epicTasks(rows(6));
  const reads=createReadController({api:epic.api,data});
  await reads.epic('e1');await reads.moreEpicTasks('e1');
  // Someone adds a task at the top.
  epic.rows=[task('new','in_progress'),...epic.rows];epic.generation++;
  await reads.epic('e1',{background:true});
  assert.deepEqual(data.epicPageInfo.e1.taskIds,['new','row-0','row-1','row-2'],'as many tasks as before, read again');
  await reads.moreEpicTasks('e1');
  assert.deepEqual(data.epicPageInfo.e1.taskIds,epic.rows.slice(0,6).map(item=>item.id),'Load more goes on from there');
});

test('a live read of the epic drawer waits for Load more instead of cancelling it',async()=>{
  const data=createLegacyData();data.epics.push({id:'e1',activity:[]});const epic=epicTasks(rows(6)),requests=held();
  const reads=createReadController({api:{...epic.api,epicTasks:(...args)=>args[1].cursor?requests.api('more')(...args):epic.api.epicTasks(...args)},data});
  await reads.epic('e1');
  const more=reads.moreEpicTasks('e1');await new Promise(setImmediate);
  const live=reads.epic('e1',{background:true});await new Promise(setImmediate);
  assert.equal(requests.calls[0].signal.aborted,false,'the live read leaves Load more running');
  assert.deepEqual(epic.calls,['first'],'the live read has not started');
  requests.calls[0].resolve(await epic.api.epicTasks('e1',{cursor:'1:2'}));
  assert.equal((await more).stale,false);
  while(!requests.calls[1])await new Promise(setImmediate);
  requests.calls[1].resolve(await epic.api.epicTasks('e1',{cursor:'1:2'}));
  assert.equal((await live).stale,false);
  assert.deepEqual(data.epicPageInfo.e1.taskIds,['row-0','row-1','row-2','row-3'],'the live read kept the page Load more added');
});

test('Load more in the epic drawer waits for a live read and goes on from what it read',async()=>{
  const data=createLegacyData();data.epics.push({id:'e1',activity:[]});const epic=epicTasks(rows(6));let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const reads=createReadController({api:{...epic.api,epicActivity:async(_id,options)=>{if(options.background)await gate;return {items:[],nextCursor:null};}},data});
  await reads.epic('e1');
  epic.generation++;
  const live=reads.epic('e1',{background:true});await new Promise(setImmediate);
  const more=reads.moreEpicTasks('e1');await new Promise(setImmediate);
  release();
  assert.equal((await live).stale,false,'Load more did not cancel the live read');
  assert.equal((await more).stale,false);
  assert.deepEqual(data.epicPageInfo.e1.taskIds,['row-0','row-1','row-2','row-3']);
  assert(!epic.calls.includes('1:2'),'Load more used the cursor the live read brought');
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
  await reads.task('5');calls.length=0;
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

test('a Board hint waits for foreground pagination instead of aborting or discarding it',async()=>{
  const data=createLegacyData();let release,signal;
  const gate=new Promise(resolve=>{release=resolve;});
  const counts={planning:3,inProgress:0,inReview:0,done:0,blocked:0};
  const api={boardView:async()=>({planning:{items:[task('one','planning')],nextCursor:'next',total:3},inProgress:{items:[],total:0},inReview:{items:[],total:0},done:{items:[],total:0},counts}),board:async(_id,_filter,options)=>{signal=options.signal;await gate;return {items:[task('two','planning')],nextCursor:'last',total:3};},counts:async()=>counts,task:async()=>({...task('one','planning'),title:'Updated'})};
  const reads=createReadController({api,data});await reads.board('p1');
  const page=reads.moreBoard('planning'),hint=reads.patchBoard('p1',{},[{entityId:'one'}]);assert.equal(signal.aborted,false);release();await Promise.all([page,hint]);
  assert.equal(data.tasks.length,2);assert.equal(data.boardPageInfo.pages.planning.nextCursor,'last');assert.equal(data.tasks.find(row=>row.internalId==='one').title,'Updated');
});

test('a stale Board cursor reads the Board again with one more page of that column',async()=>{
  // Cursors carry the generation they were read at; a write makes older ones stale.
  const data=createLegacyData();let generation=1;const empty={items:[],nextCursor:null,total:0};
  const rows=Array.from({length:6},(_,index)=>task(`row-${index}`,'planning'));
  const page=(from)=>({items:rows.slice(from,from+2),nextCursor:from+2<rows.length?`${generation}:${from+2}`:null,total:rows.length});
  const api={
    boardView:async()=>({planning:page(0),inProgress:empty,inReview:empty,done:empty,counts:{}}),
    board:async(_id,filters)=>{const [at,from]=filters.cursor.split(':').map(Number);if(at!==generation)throw {code:'cursor_stale'};return page(from);},
  };
  const reads=createReadController({api,data});
  await reads.board('p1');await reads.moreBoard('planning');
  assert.deepEqual(data.tasks.map(item=>item.internalId),['row-0','row-1','row-2','row-3']);
  generation++;
  assert.equal((await reads.moreBoard('planning')).stale,false);
  assert.deepEqual(data.tasks.map(item=>item.internalId),rows.map(item=>item.id),'the next page shows, read from fresh cursors');
  assert.equal(data.boardPageInfo.pages.planning.nextCursor,null);
});

function held(){const calls=[];const api=(name)=>(...args)=>new Promise((resolve,reject)=>calls.push({name,args,signal:args.at(-1)?.signal,resolve,reject}));return {calls,api};}
const counts={planning:1,inProgress:0,inReview:0,done:0,blocked:0};
const boardView=(items=[task('one','planning')])=>({planning:{items,nextCursor:null,total:items.length},inProgress:{items:[],total:0},inReview:{items:[],total:0},done:{items:[],total:0},counts});

test('reads of different things never cancel each other',async()=>{
  const data=createLegacyData(),requests=held();
  const reads=createReadController({data,api:{boardView:async()=>boardView(),task:requests.api('task'),counts:requests.api('counts'),pool:requests.api('pool'),roadmap:requests.api('roadmap')}});
  await reads.board('p1');
  const opening=reads.task('BIR-1'),pool=reads.pool('p1','personal'),count=reads.counts('p1'),roadmap=reads.roadmap('p1'),patch=reads.patchBoard('p1',{},[{entityId:'one'}]);
  await new Promise(setImmediate);
  assert.deepEqual(requests.calls.map(call=>call.signal.aborted),requests.calls.map(()=>false));
  for(const call of requests.calls){
    if(call.name==='task')call.resolve({...task(call.args[0]==='one'?'one':'bir-1','planning'),taskKey:call.args[0]==='one'?'BIR-one':'BIR-1'});
    else if(call.name==='counts')call.resolve(counts);
    else if(call.name==='pool')call.resolve({items:[],nextCursor:null,total:0});
    else call.resolve({projectId:'p1',tracks:[],epics:[],milestones:[]});
  }
  for(const result of await Promise.all([opening,pool,count,roadmap,patch]))assert.equal(result.stale,false);
  assert.equal(data.poolPageInfo['p1:mine'].loading,undefined);
});

test('a newer read of the same task answers the earlier caller too',async()=>{
  const data=createLegacyData(),requests=held();
  const reads=createReadController({data,api:{task:requests.api('task')}});
  const first=reads.task('BIR-1'),second=reads.task('BIR-1');
  assert.equal(requests.calls[0].signal.aborted,true);
  requests.calls[0].reject(Object.assign(new Error('cancelled'),{code:'aborted'}));
  requests.calls[1].resolve({...task('bir-1','planning'),taskKey:'BIR-1',title:'Latest'});
  assert.equal((await first).task.title,'Latest');assert.equal((await second).task.title,'Latest');
});

test('a live Board read waits for the Board read someone started instead of replacing it',async()=>{
  const data=createLegacyData(),views=[];
  const reads=createReadController({data,api:{boardView:(_id,_filters,options)=>new Promise(resolve=>views.push({options,resolve}))}});
  const opening=reads.board('p1'),live=reads.board('p1',{},{background:true});
  await new Promise(setImmediate);
  assert.equal(views.length,1,'the live read has not started');assert.equal(views[0].options.signal.aborted,false);
  views[0].resolve(boardView());assert.equal((await opening).stale,false);
  await new Promise(setImmediate);views[1].resolve(boardView([task('two','planning')]));
  assert.equal((await live).stale,false);assert.deepEqual(data.tasks.map(item=>item.internalId),['two']);
});

test('a live Board patch that lands while a task is open still shows on the Board afterwards',async()=>{
  const data=createLegacyData(),requests=held();let views=0;
  const reads=createReadController({data,api:{boardView:async()=>{views++;return boardView();},task:requests.api('task'),counts:async()=>counts}});
  await reads.board('p1');
  const patch=reads.patchBoard('p1',{},[{entityId:'one'}]);await new Promise(setImmediate);
  const opening=reads.task('BIR-9');await new Promise(setImmediate);
  const [hint,open]=requests.calls;
  assert.equal(hint.signal.aborted,false,'opening a task leaves the live patch running');
  hint.resolve({...task('one','in_progress'),revision:2});open.resolve({...task('nine','planning'),taskKey:'BIR-9'});
  assert.equal((await patch).stale,false);await opening;
  await reads.board('p1',{},{skipUnchanged:true});
  assert.equal(views,1);assert.equal(data.tasks.find(item=>item.internalId==='one').state,'progress');
});

test('a live read that spans a newer projection is dropped and the Board reads again',async()=>{
  const data=createLegacyData(),pending=[];let views=0;
  const reads=createReadController({data,api:{boardView:async()=>{views++;return boardView();},task:()=>new Promise(resolve=>pending.push(resolve)),counts:async()=>counts}});
  await reads.board('p1');
  const patch=reads.patchBoard('p1',{},[{entityId:'one'}]);await new Promise(setImmediate);
  data.projectionGeneration++;pending[0]({...task('one','done'),revision:2});
  assert.equal((await patch).stale,true);assert.equal(data.tasks[0].state,'planning');
  await reads.board('p1',{},{skipUnchanged:true});assert.equal(views,2);
});

test('idle waits only for reads someone started',async()=>{
  const data=createLegacyData(),requests=held();
  const reads=createReadController({data,api:{roadmap:requests.api('roadmap'),counts:requests.api('counts')}});
  void reads.roadmap('p1',{background:true});const count=reads.counts('p1');
  let settled=false;const idle=reads.idle().then(()=>{settled=true;});
  await new Promise(setImmediate);assert.equal(settled,false);
  requests.calls.find(call=>call.name==='counts').resolve(counts);await count;await idle;
  assert.equal(settled,true,'a live read in flight does not hold up idle');
});

test('a live Board patch for filters the Board no longer shows does not bring them back',async()=>{
  const data=createLegacyData(),views=[];
  const reads=createReadController({data,api:{boardView:(_id,filters)=>new Promise(resolve=>views.push({filters,resolve})),task:async()=>({...task('one','done'),revision:2}),counts:async()=>counts}});
  const first=reads.board('p1');views[0].resolve(boardView());await first;
  const filtered=reads.board('p1',{search:'two'}),patch=reads.patchBoard('p1',{},[{entityId:'one'}]);
  await new Promise(setImmediate);
  views[1].resolve(boardView([task('two','planning')]));await filtered;
  assert.equal((await patch).stale,true);
  assert.equal(views.length,2,'no read of the old filters');assert.deepEqual(data.tasks.map(item=>item.internalId),['two']);
});
