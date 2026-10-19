import assert from 'node:assert/strict';
import test from 'node:test';
import {createCommandGateway} from '../../../src/data/command-gateway.js';
import {createReadController} from '../../../src/data/read-controller.js';
import {createLegacyData} from '../../../src/data/projection-store.js';
import {ApiError} from '../../../src/data/api-client.js';
import {saveDoneOrder} from '../../../src/data/done-order.js';
import {settle} from '../../support/helpers.cjs';

const task=(id,status)=>({id,projectId:'p1',epicId:'e1',taskKey:`BIR-${id}`,title:id,description:'',status,position:1,deadline:null,createdAt:1_800_000_000_000,updatedAt:1_800_000_000_000,revision:1,assigneeIds:[],activeBlock:null});
/** API methods whose answers wait in `calls` until the test settles them. */
function held(){const calls=[];const api=(name)=>(...args)=>new Promise((resolve,reject)=>calls.push({name,args,signal:args.at(-1)?.signal,resolve,reject}));return {calls,api};}
const counts={planning:1,inProgress:0,inReview:0,done:0,blocked:0};
/** A Board read: empty columns unless `columns` gives one. */
const boardColumns=(columns)=>({planning:{items:[],total:0},inProgress:{items:[],total:0},inReview:{items:[],total:0},done:{items:[],total:0},counts,...columns});
/** A Board read with `items` in Planning. */
const boardView=(items=[task('one','planning')])=>boardColumns({planning:{items,nextCursor:null,total:items.length}});

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
  const more=reads.moreEpicTasks('e1');await settle();
  const live=reads.epic('e1',{background:true});await settle();
  assert.equal(requests.calls[0].signal.aborted,false,'the live read leaves Load more running');
  assert.deepEqual(epic.calls,['first'],'the live read has not started');
  requests.calls[0].resolve(await epic.api.epicTasks('e1',{cursor:'1:2'}));
  assert.equal((await more).stale,false);
  while(!requests.calls[1])await settle();
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
  const live=reads.epic('e1',{background:true});await settle();
  const more=reads.moreEpicTasks('e1');await settle();
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
    boardView:async()=>{calls.push('view');return boardColumns({done:page(0),counts:{planning:0,inProgress:0,inReview:0,done:8,blocked:0}});},
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
  const api={boardView:async()=>boardColumns({planning:{items:[task('one','planning')],nextCursor:'next',total:9},counts:{planning:9,inProgress:0,inReview:0,done:0,blocked:0}}),task:async()=>changed,counts:async()=>({planning:9,inProgress:0,inReview:0,done:0,blocked:0})};
  const reads=createReadController({api,data});await reads.board('p1');
  changed={...task('far','planning'),position:99};await reads.patchBoard('p1',{},[{entityId:'far'}]);assert.equal(data.tasks.length,1);
  api.task=async()=>{throw {status:404};};await reads.patchBoard('p1',{},[{entityId:'one'}]);assert.equal(data.tasks.length,0);assert.equal(data.boardPageInfo.pages.planning.nextCursor,'next');
});

test('a newest-first Done reads, adopts and patches the Done column in completion order',async(t)=>{
  saveDoneOrder('completed',undefined);t.after(()=>saveDoneOrder('manual',undefined));
  const calls=[],data=createLegacyData();let changed;
  const done=(id,completedAt)=>({...task(id,'done'),completedAt});
  const api={
    boardView:async(_project,filters)=>{calls.push(['view',filters]);return boardColumns({done:{items:[done('later',300),done('earlier',200)],nextCursor:'done-next',total:9},counts:{planning:0,inProgress:0,inReview:0,done:9,blocked:0}});},
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
  // The loaded window ends at the oldest loaded completion, not at the last card in manual order.
  changed=done('in-between',150);
  await reads.patchBoard('p1',{},[{entityId:'in-between'}]);
  assert.deepEqual(data.tasks.filter(item=>item.state==='done').map(item=>item.internalId),['finished-now','later','earlier','in-between','earliest'],'only cards inside the loaded window join it');
});

test('a Board hint waits for foreground pagination instead of aborting or discarding it',async()=>{
  const data=createLegacyData();let release,signal;
  const gate=new Promise(resolve=>{release=resolve;});
  const counts={planning:3,inProgress:0,inReview:0,done:0,blocked:0};
  const api={boardView:async()=>boardColumns({planning:{items:[task('one','planning')],nextCursor:'next',total:3},counts}),board:async(_id,_filter,options)=>{signal=options.signal;await gate;return {items:[task('two','planning')],nextCursor:'last',total:3};},counts:async()=>counts,task:async()=>({...task('one','planning'),title:'Updated'})};
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

test('reads of different things never cancel each other',async()=>{
  const data=createLegacyData(),requests=held();
  const reads=createReadController({data,api:{boardView:async()=>boardView(),task:requests.api('task'),counts:requests.api('counts'),pool:requests.api('pool'),roadmapLanes:requests.api('roadmapLanes')}});
  await reads.board('p1');
  const opening=reads.task('BIR-1'),pool=reads.pool('p1','personal'),count=reads.counts('p1'),roadmap=reads.roadmap('p1'),patch=reads.patchBoard('p1',{},[{entityId:'one'}]);
  await settle();
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

test('a task on a track or in an epic not loaded yet reads its project\'s Roadmap too and shows again, and a known one reads nothing more',async()=>{
  const data=createLegacyData(),requests=held(),shown=[];
  data.projects.push({id:'p1',members:[]});data.tracks.push({id:'known',projectId:'p1',name:'Backend'});
  const reads=createReadController({data,api:{task:requests.api('task'),roadmap:requests.api('roadmap')},onTask:(item)=>shown.push([item.trackId,item.epicId,data.epics.some((epic)=>epic.id===item.epicId)])});
  const known=reads.task('BIR-1');await settle();
  requests.calls[0].resolve({...task('bir-1','planning'),taskKey:'BIR-1',trackId:'known',epicId:null});
  assert.equal((await known).stale,false);
  assert.deepEqual(requests.calls.map((call)=>call.name),['task']);
  const moved=reads.task('BIR-2');await settle();
  requests.calls[1].resolve({...task('bir-2','planning'),taskKey:'BIR-2',trackId:'known',epicId:'new-epic'});await settle();
  assert.deepEqual(requests.calls.map((call)=>[call.name,call.args[0]]),[['task','BIR-1'],['task','BIR-2'],['roadmap','p1']]);
  requests.calls[2].resolve({projectId:'p1',tracks:[{id:'known',projectId:'p1',name:'Backend',position:1,revision:1}],epics:[{id:'new-epic',projectId:'p1',trackId:'known',title:'Payments v2',startDate:'2026-10-01',state:'planning',position:1,revision:1}],milestones:[]});
  assert.equal((await moved).task.epicId,'new-epic');
  assert.deepEqual(shown,[['known',null,false],['known','new-epic',false],['known','new-epic',true]]);
});

test('a task\'s track and epic come from the light Roadmap structure read, in a slot of its own, so the Roadmap\'s read goes on',async()=>{
  const data=createLegacyData(),requests=held();
  data.projects.push({id:'p1',members:[]});
  const reads=createReadController({data,api:{task:requests.api('task'),roadmap:requests.api('roadmap')}});
  const page=reads.roadmap('p1'),opening=reads.task('BIR-2');await settle();
  requests.calls.find((call)=>call.name==='task').resolve({...task('bir-2','planning'),taskKey:'BIR-2',trackId:'new-track',epicId:null});await settle();
  const [pageRead,structureRead]=requests.calls.filter((call)=>call.name==='roadmap');
  assert.equal(pageRead.signal.aborted,false,'the Roadmap\'s read goes on');
  assert.ok(structureRead,'the task reads the structure on its own');
  for(const call of [pageRead,structureRead])call.resolve({projectId:'p1',tracks:[{id:'new-track',projectId:'p1',name:'Android',position:1,revision:1}],epics:[],milestones:[]});
  assert.equal((await page).stale,false);assert.equal((await opening).stale,false);
});

test('a live Board read waits for the Board read someone started instead of replacing it',async()=>{
  const data=createLegacyData(),views=[];
  const reads=createReadController({data,api:{boardView:(_id,_filters,options)=>new Promise(resolve=>views.push({options,resolve}))}});
  const opening=reads.board('p1'),live=reads.board('p1',{},{background:true});
  await settle();
  assert.equal(views.length,1,'the live read has not started');assert.equal(views[0].options.signal.aborted,false);
  views[0].resolve(boardView());assert.equal((await opening).stale,false);
  await settle();views[1].resolve(boardView([task('two','planning')]));
  assert.equal((await live).stale,false);assert.deepEqual(data.tasks.map(item=>item.internalId),['two']);
});

test('a live Board patch that lands while a task is open still shows on the Board afterwards',async()=>{
  const data=createLegacyData(),requests=held();let views=0;
  const reads=createReadController({data,api:{boardView:async()=>{views++;return boardView();},task:requests.api('task'),counts:async()=>counts}});
  await reads.board('p1');
  const patch=reads.patchBoard('p1',{},[{entityId:'one'}]);await settle();
  const opening=reads.task('BIR-9');await settle();
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
  const patch=reads.patchBoard('p1',{},[{entityId:'one'}]);await settle();
  data.projectionGeneration++;pending[0]({...task('one','done'),revision:2});
  assert.equal((await patch).stale,true);assert.equal(data.tasks[0].state,'planning');
  await reads.board('p1',{},{skipUnchanged:true});assert.equal(views,2);
});

test('idle waits only for reads someone started',async()=>{
  const data=createLegacyData(),requests=held();
  const reads=createReadController({data,api:{roadmapLanes:requests.api('roadmapLanes'),counts:requests.api('counts')}});
  void reads.roadmap('p1',{background:true});const count=reads.counts('p1');
  let settled=false;const idle=reads.idle().then(()=>{settled=true;});
  await settle();assert.equal(settled,false);
  requests.calls.find(call=>call.name==='counts').resolve(counts);await count;await idle;
  assert.equal(settled,true,'a live read in flight does not hold up idle');
});

test('a live Board patch for filters the Board no longer shows does not bring them back',async()=>{
  const data=createLegacyData(),views=[];
  const reads=createReadController({data,api:{boardView:(_id,filters)=>new Promise(resolve=>views.push({filters,resolve})),task:async()=>({...task('one','done'),revision:2}),counts:async()=>counts}});
  const first=reads.board('p1');views[0].resolve(boardView());await first;
  const filtered=reads.board('p1',{search:'two'}),patch=reads.patchBoard('p1',{},[{entityId:'one'}]);
  await settle();
  views[1].resolve(boardView([task('two','planning')]));await filtered;
  assert.equal((await patch).stale,true);
  assert.equal(views.length,2,'no read of the old filters');assert.deepEqual(data.tasks.map(item=>item.internalId),['two']);
});

test('a live Board read never undoes a move the tab makes while it runs, whichever answer lands first',async()=>{
  for(const first of ['move','read']){
    const requests=held(),api={boardView:requests.api('boardView'),command:requests.api('command')};
    const data=createLegacyData();data.session={id:'s1',userId:'u1'};
    const gateway=createCommandGateway({api,data}),reads=createReadController({api,data,writes:gateway});
    const card=(id,position,revision=1)=>({...task(id,'planning'),position,revision});
    const order=()=>data.tasks.map(item=>item.internalId),boardViews=()=>requests.calls.filter(call=>call.name==='boardView');
    const shown=reads.board('p1');boardViews()[0].resolve(boardView([card('a',1),card('b',2),card('c',3),card('d',4)]));await shown;
    // A hint that the column was re-spaced reads the Board again, and the
    // person moves d to the top while that read runs. The move shows at once,
    // as the Board shows its own moves.
    const live=reads.board('p1',{},{background:true});await settle();
    const d=data.tasks.find(item=>item.internalId==='d');
    data.tasks.splice(data.tasks.indexOf(d),1);data.tasks.unshift(d);d.order=data.tasks[1].order-1;
    const moved=gateway.execute('task.move',{taskId:'d',status:'planning',position:0},{expectedRevision:1});await settle();
    const command=requests.calls.find(call=>call.name==='command'),saved={entities:[{entityType:'task',...card('d',0,2)}],events:[]};
    // The read answers from before the move, in the column's new spacing.
    const before=boardView([card('a',1024),card('b',2048),card('c',3072),card('d',4096)]);
    if(first==='move'){command.resolve(saved);await moved;boardViews()[1].resolve(before);}
    else{boardViews()[1].resolve(before);await settle();assert.deepEqual(order(),['d','a','b','c'],'the move stays while it is saved');command.resolve(saved);await moved;}
    await settle();
    assert.equal(boardViews().length,3,`${first}: it reads again once the move is saved`);
    boardViews()[2].resolve(boardView([card('d',0,2),card('a',1024),card('b',2048),card('c',3072)]));
    assert.equal((await live).stale,false);
    assert.deepEqual(order(),['d','a','b','c'],first);
    assert.deepEqual(data.tasks.map(item=>item.order),[0,1024,2048,3072],first);
  }
});

test('a live Roadmap or Pool read never undoes a change the tab makes while it runs',async()=>{
  const track=(id,position,revision=1)=>({id,projectId:'p1',name:id,position,revision});
  const item=(id,revision=1)=>({id,projectId:'p1',scope:'personal',ownerUserId:'u1',title:id,description:'',createdAt:1,revision});
  const roadmap=(tracks)=>({projectId:'p1',tracks,epics:[],milestones:[]});
  const changes={
    // The tab moves t2 above t1; the Roadmap shows that at once.
    'a track moved':{api:'roadmapLanes',open:(reads)=>reads.roadmap('p1'),live:(reads)=>reads.roadmap('p1',{background:true}),
      before:roadmap([track('t1',1),track('t2',2)]),after:roadmap([track('t2',0,2),track('t1',1)]),
      change:(data,gateway)=>{data.tracks.find(entry=>entry.id==='t2').order=0;return gateway.execute('track.reorder',{trackId:'t2',position:0},{expectedRevision:1});},
      saved:{entityType:'track',...track('t2',0,2)},shown:(data)=>[...data.tracks].sort((left,right)=>left.order-right.order).map(entry=>entry.id),expected:['t2','t1']},
    'a Pool item added':{api:'pool',open:(reads)=>reads.pool('p1','personal'),live:(reads)=>reads.pool('p1','personal',false,undefined,{background:true}),
      before:{items:[item('i1')],nextCursor:null,total:1},after:{items:[item('i2'),item('i1')],nextCursor:null,total:2},
      change:(_data,gateway)=>gateway.execute('pool.create',{projectId:'p1',scope:'personal',title:'i2'}),
      saved:{entityType:'poolItem',...item('i2')},shown:(data)=>data.pool.map(entry=>entry.id).sort(),expected:['i1','i2']},
  };
  for(const [name,{api:read,open,live,before,after,change,saved,shown,expected}] of Object.entries(changes)){
    const requests=held(),api={[read]:requests.api(read),command:requests.api('command')};
    const data=createLegacyData();data.session={id:'s1',userId:'u1'};
    const gateway=createCommandGateway({api,data}),reads=createReadController({api,data,writes:gateway});
    const answers=()=>requests.calls.filter(call=>call.name===read);
    const opened=open(reads);answers()[0].resolve(before);await opened;
    const reading=live(reads);await settle();
    const sent=change(data,gateway);await settle();
    requests.calls.find(call=>call.name==='command').resolve({entities:[saved],events:[]});await sent;
    // The live read answers from before the change.
    answers()[1].resolve(before);await settle();
    assert.deepEqual(shown(data),expected,`${name}: the tab's change stays`);
    assert.equal(answers().length,3,`${name}: it reads again once the change is saved`);
    answers()[2].resolve(after);
    assert.equal((await reading).stale,false);
    assert.deepEqual(shown(data),expected,name);
  }
});

test('a live patch of a card that the tab is moving never puts the card back',async()=>{
  const requests=held(),api={boardView:requests.api('boardView'),task:requests.api('task'),command:requests.api('command')};
  const data=createLegacyData();data.session={id:'s1',userId:'u1'};
  const gateway=createCommandGateway({api,data}),reads=createReadController({api,data,writes:gateway});
  const card=(id,status,position,revision=1,checklist=0)=>({...task(id,status),position,revision,checklistTotal:1,checklistDone:checklist});
  const shown=()=>{const moved=data.tasks.find(item=>item.internalId==='b');return [moved.state,moved.checklistDone];};
  const opened=reads.board('p1');requests.calls[0].resolve(boardView([card('a','planning',1),card('b','planning',2)]));await opened;
  // The tab moves b to In progress; the Board shows that at once.
  const b=data.tasks.find(item=>item.internalId==='b');b.state='progress';b.order=0;
  const moved=gateway.execute('task.move',{taskId:'b',status:'in_progress',position:0},{expectedRevision:1});await settle();
  // Meanwhile another person ticks b's checklist, and the patch reads b as the server had it before the move.
  const patch=reads.patchBoard('p1',{},[{entityType:'checklist',entityId:'b',taskId:'b'}]);await settle();
  const cardReads=()=>requests.calls.filter(call=>call.name==='task');
  cardReads()[0].resolve(card('b','planning',2,1,1));await settle();
  assert.deepEqual(shown(),['progress',0],'the move stays while it is saved');
  requests.calls.find(call=>call.name==='command').resolve({entities:[{entityType:'task',...card('b','in_progress',0,2)}],events:[]});await moved;await settle();
  assert.equal(cardReads().length,2,'it reads the card again once the move is saved');
  cardReads()[1].resolve(card('b','in_progress',0,2,1));
  assert.equal((await patch).stale,false);
  assert.deepEqual(shown(),['progress',1]);
});

/** Work in progress of track t1's own work. */
const open=(id)=>({...task(id,'in_progress'),trackId:'t1',epicId:null});
/** A day of t1's own work with one done task. */
const doneDay=(from,id)=>({from,to:from,sections:[{trackId:'t1',epicId:null,done:[1],marks:[{id,taskKey:`BIR-${id}`,title:id,status:'done',completedAt:1_790_000_000}]}],marked:{from,to:from}});
/** What one read of the lanes may ask for, as the server says. */
const limits={days:400,marks:400,changeDays:3660};
/** A Roadmap read of `p1`: its lanes with one task in progress, its counts, and the days of `window`. */
const roadmapRead=(window={from:'2026-06-01',to:'2027-03-01'})=>({projectId:'p1',tracks:[],epics:[],milestones:[],lanes:{sections:[{trackId:'t1',epicId:null,planning:0,inProgress:1,inReview:0,done:9}],overdue:0,firstDay:'2025-01-01',lastDay:null,
  open:[open('open')],late:[],days:{...window,sections:[]},limits}});

test('a live Roadmap read reads the days the view shows, in one read, however many reads of days the lanes took',async()=>{
  const data=createLegacyData(),lanes=[],days=[];
  const api={
    roadmapLanes:async(_project,window)=>{lanes.push(window);return roadmapRead(window?{from:window.from,to:window.to}:undefined);},
    roadmapDays:async(_project,wanted)=>{days.push(wanted);return doneDay(wanted.from,`done-${days.length}`);},
  };
  const reads=createReadController({data,api});
  await reads.roadmap('p1');
  assert.deepEqual([lanes,data.roadmap.window],[[null],{from:'2026-06-01',to:'2027-03-01'}],'first, the days the Roadmap opens with');
  for(const from of ['2026-05-31','2026-05-30'])assert.deepEqual(await reads.roadmapDays('p1',{from,to:from,anchor:'2026-07-01',marks:400}),{stale:false,marked:{from,to:from}},'with the days whose tasks all came');
  assert.deepEqual([data.roadmap.window,Object.keys(data.roadmap.marks)],[{from:'2026-05-30',to:'2027-03-01'},['done-1','done-2']]);
  // The view now shows late May to July.
  data.roadmap.shown={from:'2026-05-30',to:'2026-07-31',anchor:'2026-07-01'};
  await reads.roadmap('p1',{background:true});
  assert.equal(days.length,2,'no days are read again one by one');
  assert.deepEqual(lanes,[null,{from:'2026-05-30',to:'2026-07-31',anchor:'2026-07-01'}],'one read of the days in view');
  assert.deepEqual([data.roadmap.open,data.roadmap.window,data.roadmap.shown],[['open'],{from:'2026-05-30',to:'2026-07-31'},{from:'2026-05-30',to:'2026-07-31',anchor:'2026-07-01'}]);
  assert.deepEqual(data.roadmap.trackCounts,{t1:{planning:0,progress:1,review:0,done:9}});
  assert.equal((await reads.roadmapDays('p2',{from:'2026-01-01',to:'2026-01-01'})).stale,true,'nothing to read for lanes of another project');
});

test('a change made elsewhere reads only the tasks it named, with the lanes\' counts and the counts of the days in view',async()=>{
  const data=createLegacyData(),asked=[];
  const named=(ids)=>({projectId:'p1',tracks:[],epics:[],milestones:[],lanes:{sections:[{trackId:'t1',epicId:null,planning:1,inProgress:1,inReview:0,done:10}],overdue:0,firstDay:'2025-01-01',lastDay:null,
    open:[{...open('open'),title:'open renamed'}],late:[],days:{from:'2026-07-01',to:'2026-07-31',sections:[]},tasks:ids.filter((id)=>id!=='open'&&id!=='done-1').map((id)=>task(id,'planning'))}});
  const api={roadmapLanes:async(_project,lanes)=>{asked.push(lanes);return lanes&&'tasks' in lanes?named(lanes.tasks):roadmapRead();}};
  const reads=createReadController({data,api});
  await reads.roadmap('p1');
  const lanes=data.roadmap;
  lanes.shown={from:'2026-07-01',to:'2026-07-31',anchor:'2026-07-15'};
  // Elsewhere, open is renamed and done-1 deleted.
  assert.equal((await reads.patchRoadmap('p1',['open','done-1','open'],{background:true})).stale,false);
  assert.deepEqual(asked,[null,{from:'2026-06-01',to:'2027-03-01',marks:0,tasks:['open','done-1'],sections:['t1/']}],'one read of the named tasks and the section that draws open, with counts alone, of every day the lanes hold');
  assert.equal(data.roadmap,lanes);
  assert.deepEqual([lanes.open,lanes.window],[['open'],{from:'2026-06-01',to:'2027-03-01'}]);
  assert.deepEqual(lanes.trackCounts,{t1:{planning:1,progress:1,review:0,done:10}});
  assert.equal(data.tasks.find((item)=>item.internalId==='open').title,'open renamed');
  // A named task among the longest overdue: they come again too.
  lanes.late=[{internalId:'open'}];
  await reads.patchRoadmap('p1',['open'],{background:true});
  assert.equal(asked.at(-1).late,true);
  // More tasks than one read names: the lanes are read again, for the days in view.
  await reads.patchRoadmap('p1',Array.from({length:51},(_,index)=>`t${index}`));
  assert.deepEqual(asked.at(-1),{from:'2026-07-01',to:'2026-07-31',anchor:'2026-07-15'});
  // And so are lanes that hold more days than one read of a change covers.
  data.roadmap.window={from:'2015-01-01',to:'2027-01-01'};data.roadmap.shown={from:'2026-07-01',to:'2026-07-31',anchor:'2026-07-15'};
  await reads.patchRoadmap('p1',['open']);
  assert.deepEqual(asked.at(-1),{from:'2026-07-01',to:'2026-07-31',anchor:'2026-07-15'});
});

test('a change that took a task the lanes didn\'t hold out of a section reads that section\'s days again, once',async()=>{
  const data=createLegacyData(),asked=[];
  const counts=(own,other)=>[{trackId:'t1',epicId:null,planning:0,inProgress:1,inReview:0,done:own},{trackId:'t2',epicId:null,planning:0,inProgress:0,inReview:0,done:other}];
  const lanesOf=(sections,extra)=>({projectId:'p1',tracks:[],epics:[],milestones:[],lanes:{sections,overdue:0,firstDay:null,lastDay:null,open:[],late:[],days:{from:'2026-06-01',to:'2027-03-01',sections:[]},limits,...extra}});
  const answers=[lanesOf(counts(9,3),{open:[open('open')]}),lanesOf(counts(10,2),{tasks:[{...task('x','done'),trackId:'t1',epicId:null}]}),lanesOf(counts(10,1),{tasks:[]})];
  const reads=createReadController({data,api:{roadmapLanes:async(_project,lanes)=>{asked.push(lanes);return answers[asked.length-1];}}});
  await reads.roadmap('p1');
  // Elsewhere, x, which the lanes never held, moved from t2's own work to t1's and was done.
  assert.equal((await reads.patchRoadmap('p1',['x'],{background:true})).stale,false);
  assert.deepEqual(asked.slice(1).map((lanes)=>[lanes.tasks,lanes.sections]),[[['x'],[]],[[],['t2/']]],'t1 came with x; t2 lost a done task, so its days come next');
  assert.deepEqual(data.roadmap.trackCounts.t2.done,1,'a second read has the counts of then');
});

test('a read of more days asked for before a change made elsewhere is dropped, as it may miss the change',async()=>{
  const data=createLegacyData(),requests=held();
  const reads=createReadController({data,api:{roadmapLanes:async(_project,lanes)=>lanes?.tasks?{...roadmapRead(),lanes:{...roadmapRead().lanes,open:[],tasks:[]}}:roadmapRead(),roadmapDays:requests.api('roadmapDays')}});
  await reads.roadmap('p1');
  const days=reads.roadmapDays('p1',{from:'2026-05-31',to:'2026-05-31'});
  await reads.patchRoadmap('p1',['x'],{background:true});
  requests.calls[0].resolve(doneDay('2026-05-31','missed'));
  assert.equal((await days).stale,true);
  assert.deepEqual([data.roadmap.window,data.roadmap.marks],[{from:'2026-06-01',to:'2027-03-01'},{}]);
  // One asked for after the change lands.
  const again=reads.roadmapDays('p1',{from:'2026-05-31',to:'2026-05-31'});
  requests.calls[1].resolve(doneDay('2026-05-31','seen'));
  assert.equal((await again).stale,false);
  assert.deepEqual(Object.keys(data.roadmap.marks),['seen']);
});

test('one list of a Roadmap mark reads at a time: a newer list, or closing it, cancels the one before',async()=>{
  const data=createLegacyData(),requests=held();
  const reads=createReadController({data,api:{roadmapList:requests.api('roadmapList')}});
  const first=reads.roadmapList('p1',{track:'t1',kind:'done',from:'2026-09-01',to:'2026-09-02'});
  const second=reads.roadmapList('p1',{track:'t1',kind:'done',from:'2026-09-03',to:'2026-09-04'});
  assert.deepEqual(requests.calls.map(call=>call.signal.aborted),[true,false]);
  requests.calls[0].reject(new ApiError('Request cancelled',{code:'aborted'}));
  assert.equal((await first).stale,true);
  requests.calls[1].resolve({items:[{id:'d1',taskKey:'BIR-1',trackId:'t1',epicId:null,title:'Done',status:'done',completedAt:1_790_000_000}],total:1});
  const list=await second;
  assert.deepEqual([list.stale,list.items.map(item=>item.id),list.total],[false,['BIR-1'],1]);
  const closed=reads.roadmapList('p1',{track:'t1',kind:'open'});
  reads.cancelRoadmapList();
  assert.equal(requests.calls[2].signal.aborted,true);
  requests.calls[2].reject(new ApiError('Request cancelled',{code:'aborted'}));
  assert.equal((await closed).stale,true);
});

test('a read of more days that a newer read of the Roadmap overtakes adds nothing',async()=>{
  const data=createLegacyData(),requests=held();
  const reads=createReadController({data,api:{roadmapLanes:async()=>roadmapRead(),roadmapDays:requests.api('roadmapDays')}});
  await reads.roadmap('p1');
  const days=reads.roadmapDays('p1',{from:'2026-05-31',to:'2026-05-31'});
  await reads.roadmap('p1');
  requests.calls[0].resolve(doneDay('2026-05-31','late'));
  assert.equal((await days).stale,true);
  assert.deepEqual([data.roadmap.window,data.roadmap.marks],[{from:'2026-06-01',to:'2027-03-01'},{}]);
});

test('the tracks, epics and milestones of another project come in one read without its lanes',async()=>{
  const data=createLegacyData(),called=[];
  const reads=createReadController({data,api:{roadmap:async(projectId)=>{called.push(['roadmap',projectId]);return {projectId,tracks:[{id:'r2',projectId,name:'Other',position:0,revision:1}],epics:[],milestones:[]};},roadmapLanes:async()=>{called.push(['roadmapLanes']);}}});
  await reads.roadmap('p1').catch(()=>{});called.length=0;
  data.roadmap={projectId:'p1',open:['kept']};
  assert.equal((await reads.roadmapStructure('p2')).stale,false);
  assert.deepEqual(called,[['roadmap','p2']]);
  assert.deepEqual(data.tracks.map(track=>track.id),['r2']);
  assert.deepEqual(data.roadmap,{projectId:'p1',open:['kept']},'the lanes on screen stay');
});
