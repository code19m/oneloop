import assert from 'node:assert/strict';
import test from 'node:test';
import { createLegacyData, hydrateLegacyData, mergeAdminUsersPage, mergeEpicActivityPage, mergeEpicTaskPage, reconcileCommandResult, appendBoardTasks, appendRoadmapDays, replacePoolPage, replaceTaskDetail, replaceBoardTasks, replaceRoadmap } from '../../../src/data/projection-store.js';
import { toWireStatus } from '../../../src/data/wire.js';

const bootstrap = () => ({
  view: 'board', timeZone: 'Asia/Tashkent',
  session: { userId: 'u1', username: 'taylorwu', name: 'Nico', isAdmin: false },
  users: [{ id:'u1', username:'taylorwu', name:'Nico', isAdmin:false, isActive:true, revision:2 }],
  projects: [{ id:'p1', name:'Birch Grove', taskPrefix:'BIR', revision:3 }],
  memberships: [{ projectId:'p1', userId:'u1', manageRoadmap:true, manageBoard:false, revision:1 }],
  tracks: [{ id:'tr1', projectId:'p1', name:'Web', position:1, revision:1 }],
  epics: [{ id:'e1', projectId:'p1', trackId:'tr1', title:'Launch', description:'Plan', startDate:'2026-09-20', endDate:null, state:'active', position:1, taskDone:0, taskTotal:1, revision:4 }],
  milestones: [{ id:'m1', projectId:'p1', title:'Go live', description:'', milestoneDate:'2026-10-01', revision:1 }],
  tasks: [{ id:'opaque-task', projectId:'p1', trackId:'tr1', epicId:'e1', taskKey:'BIR-001', title:'Ship', description:'Now', status:'in_progress', position:1, deadline:null, createdAt:100, updatedAt:101, revision:5, assigneeIds:['u1'], activeBlock:null }],
});

test('bootstrap hydrates one stable legacy root and performs explicit wire mappings', () => {
  const data = createLegacyData();
  const tasks = data.tasks;
  hydrateLegacyData(data, bootstrap());
  assert.equal(data.tasks, tasks);
  assert.equal(data.timeZone, 'Asia/Tashkent');
  assert.equal(data.session.userId, 'u1');
  assert.deepEqual(data.projects[0].members[0].permissions, ['manage_roadmap']);
  assert.equal(data.tasks[0].id, 'BIR-001');
  assert.equal(data.tasks[0].internalId, 'opaque-task');
  assert.equal(data.tasks[0].state, 'progress');
  assert.equal(data.tasks[0].created, 100000);
  assert.equal(data.epics[0].total, 1);
  replacePoolPage(data, 'p1', 'personal', [{ id:'pool1', projectId:'p1', scope:'personal', ownerUserId:'u1', title:'Later', description:'', createdAt:100, revision:1 }]);
  assert.equal(data.pool[0].scope, 'mine');
  assert.equal(toWireStatus('review'), 'in_review');
});

test('a read and a command result give each entity the same fields under the client\'s names', () => {
  const data = createLegacyData();
  hydrateLegacyData(data, bootstrap());
  const block = { id:'b1', reason:'Waiting', createdBy:'u1', createdAt:100, revision:1, mentions:[] };
  const cases = [
    ['project', data.projects, { id:'p2', name:'Pine', taskPrefix:'PIN', revision:1 }, { name:'Pine', key:'PIN', taskPrefix:'PIN' }],
    ['track', data.tracks, { id:'tr2', projectId:'p1', name:'API', position:2, revision:1 }, { projectId:'p1', name:'API', order:2 }],
    ['epic', data.epics, { id:'e2', projectId:'p1', trackId:'tr1', title:'Beta', description:'Try', startDate:'2026-10-01', endDate:'2026-11-01', state:'planning', position:2, taskTotal:3, taskDone:1, taskOpen:2, completedThisWeek:1, completedSinceStart:1, weeklyCompletions:[1], revision:1 },
      { projectId:'p1', trackId:'tr1', title:'Beta', desc:'Try', start:'2026-10-01', end:'2026-11-01', state:'planning', order:2, total:3, done:1, open:2, closedThisWeek:1, completedSinceStart:1, weekly:[1], counted:true }],
    ['milestone', data.milestones, { id:'m2', projectId:'p1', title:'Beta', description:'Ready', milestoneDate:'2026-11-01', revision:1 }, { projectId:'p1', name:'Beta', desc:'Ready', date:'2026-11-01' }],
    ['task', data.tasks, { id:'opaque-2', projectId:'p1', trackId:'tr1', epicId:null, taskKey:'BIR-002', title:'Test', description:'All', status:'in_review', position:2, deadline:'2026-12-01', createdAt:100, updatedAt:101, startedAt:99, completedAt:null, completionOrder:null, assigneeIds:['u1'], activeBlock:block, revision:1,
      checklistVersion:4, checklistDone:1, checklistTotal:1, checklist:[{ id:'i1', taskId:'opaque-2', position:0, title:'Plan', done:true, revision:3 }] },
      { internalId:'opaque-2', id:'BIR-002', projectId:'p1', trackId:'tr1', epicId:null, title:'Test', desc:'All', state:'review', order:2, deadline:'2026-12-01', created:100000, updatedAt:101000, startedAt:99000, completedAt:null, completionOrder:null, assignees:['u1'],
        block:{ id:'b1', reason:'Waiting', by:'u1', at:100000, revision:1, mentions:[], resolution:null },
        checklistVersion:4, checklistDone:1, checklistTotal:1, checklist:[{ id:'i1', taskId:'opaque-2', title:'Plan', done:true, revision:3 }] }],
    ['poolItem', data.pool, { id:'i2', projectId:'p1', scope:'team', ownerUserId:null, title:'Idea', description:'Later', createdAt:100, revision:1 }, { projectId:'p1', scope:'project', ownerId:null, title:'Idea', desc:'Later', created:100000 }],
  ];
  for (const [entityType, collection, view, expected] of cases) {
    reconcileCommandResult(data, { entities: [{ entityType, ...view }] });
    const item = collection.find((entry) => (entry.internalId ?? entry.id) === view.id);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(item[key], value, `${entityType}.${key} from a read`);
    // A later result with every field changes each of them in place.
    for (const key of Object.keys(expected)) if (key !== 'internalId') item[key] = 'stale';
    reconcileCommandResult(data, { entities: [{ entityType, ...view, revision: 2 }] });
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(item[key], value, `${entityType}.${key} from a command result`);
    assert.equal(item.revision, 2);
  }
});

test('canonical command entities replace by opaque identity and never create activity', () => {
  const data = createLegacyData();
  hydrateLegacyData(data, bootstrap());
  data.tasks[0].activity.push({ id:'existing' });
  reconcileCommandResult(data, { entities: [{
    entityType:'task', id:'opaque-task', projectId:'p1', epicId:'e1', taskKey:'BIR-001',
    title:'Updated', description:'Now', status:'done', position:1, deadline:null,
    createdAt:100, updatedAt:102, revision:6, assigneeIds:['u1'], activeBlock:null,
  }], events:[{ id:'server-event' }] });
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].title, 'Updated');
  assert.equal(data.tasks[0].state, 'done');
  assert.deepEqual(data.tasks[0].activity, [{ id:'existing' }]);
  assert.equal(data.epics[0].done, 0);
  reconcileCommandResult(data, { entities:[{ entityType:'task', id:'opaque-task', deleted:true }] });
  assert.equal(data.tasks.length, 0);
});

test('membership reconciliation updates the owning project without leaking a global membership list', () => {
  const data = createLegacyData();
  hydrateLegacyData(data, bootstrap());
  reconcileCommandResult(data, { entities:[{ entityType:'membership', projectId:'p1', userId:'u1', manageRoadmap:false, manageBoard:true, revision:2 }] });
  assert.deepEqual(data.projects[0].members[0].permissions, ['manage_board']);
  reconcileCommandResult(data, { entities:[{ entityType:'membership', projectId:'p1', userId:'u1', deleted:true, revision:3 }] });
  assert.equal(data.projects[0].members.length, 0);
});

test('partial reorder entities update revisions without erasing canonical fields',()=>{
  const data=createLegacyData();hydrateLegacyData(data,bootstrap());
  reconcileCommandResult(data,{entities:[{entityType:'track',id:'tr1',projectId:'p1',position:0,revision:2}]});
  assert.equal(data.tracks[0].name,'Web');assert.equal(data.tracks[0].order,0);assert.equal(data.tracks[0].revision,2);
});

test('paged and filtered task reads never overwrite authoritative epic aggregates',()=>{
  const data=createLegacyData(),value=bootstrap();value.epics[0].taskTotal=100;value.epics[0].taskDone=20;hydrateLegacyData(data,value);
  replaceBoardTasks(data,'p1',[{...value.tasks[0],status:'done'}]);
  assert.equal(data.epics[0].total,100);assert.equal(data.epics[0].done,20);
});

test('a bootstrap without epic counts keeps the counts the Roadmap read last',()=>{
  const data=createLegacyData(),roadmap=bootstrap();
  Object.assign(roadmap.epics[0],{taskTotal:12,taskDone:5,taskOpen:7,completedThisWeek:2,completedSinceStart:5,weeklyCompletions:[0,0,1,0,0,1,0]});
  hydrateLegacyData(data,roadmap);
  const board=bootstrap();delete board.epics[0].taskTotal;delete board.epics[0].taskDone;board.epics[0].title='Renamed';
  hydrateLegacyData(data,board);
  assert.equal(data.epics[0].title,'Renamed');
  assert.deepEqual([data.epics[0].done,data.epics[0].total,data.epics[0].open,data.epics[0].closedThisWeek,data.epics[0].weekly],[5,12,7,2,[0,0,1,0,0,1,0]]);
  assert.equal(data.epics[0].counted,true);
  // Without counts read before, the Roadmap waits for its own read.
  const fresh=createLegacyData();hydrateLegacyData(fresh,board);
  assert.equal(fresh.epics[0].counted,false);
  replaceRoadmap(fresh,{projectId:fresh.epics[0].projectId,epics:[roadmap.epics[0]]});
  assert.deepEqual([fresh.epics[0].counted,fresh.epics[0].done,fresh.epics[0].total],[true,5,12]);
});

test('epics from command results keep or bring their counts, never the loading state',()=>{
  const data=createLegacyData(),roadmap=bootstrap();
  Object.assign(roadmap.epics[0],{taskTotal:12,taskDone:5,taskOpen:7,completedThisWeek:2,completedSinceStart:5,weeklyCompletions:[0,0,1,0,0,1,0]});
  hydrateLegacyData(data,roadmap);
  const epic=roadmap.epics[0];
  // An update or a state change carries no counts; the epic keeps the last ones.
  reconcileCommandResult(data,{entities:[{entityType:'epic',id:epic.id,projectId:epic.projectId,trackId:epic.trackId,title:'Renamed',startDate:epic.startDate,state:'active',position:0,revision:5}]});
  reconcileCommandResult(data,{entities:[{entityType:'epic',id:epic.id,projectId:epic.projectId,state:'done',revision:6}]});
  assert.deepEqual([data.epics[0].title,data.epics[0].counted,data.epics[0].done,data.epics[0].total],['Renamed',true,5,12]);
  // A new epic comes with its empty counts.
  reconcileCommandResult(data,{entities:[{entityType:'epic',id:'fresh',projectId:epic.projectId,trackId:epic.trackId,title:'Fresh',startDate:'2026-10-01',state:'planning',position:1,revision:1,
    taskTotal:0,taskDone:0,taskOpen:0,completedThisWeek:0,completedSinceStart:0,weeklyCompletions:[0,0,0,0,0,0,0]}]});
  const fresh=data.epics.find(item=>item.id==='fresh');
  assert.deepEqual([fresh.counted,fresh.done,fresh.total],[true,0,0]);
});

test('a newest-first Done keeps live cards in completion order, newest first',()=>{
  const data=createLegacyData(),value=bootstrap();
  value.boardFilter={doneOrder:'completed'};value.boardPages={done:{nextCursor:null,total:0}};value.selectedProjectId='p1';
  hydrateLegacyData(data,value);
  assert.equal(data.boardPageInfo.filters.doneOrder,'completed');
  const done=(id,position,completedAt)=>({...value.tasks[0],id,taskKey:`BIR-${id}`,status:'done',position,completedAt});
  appendBoardTasks(data,[done('old',1,100),done('undated',2,null),done('new',3,300),done('tie-b',4,200),done('tie-a',5,200)]);
  assert.deepEqual(data.tasks.filter(item=>item.state==='done').map(item=>item.internalId),['new','tie-b','tie-a','old','undated']);
  assert.equal(data.tasks.find(item=>item.internalId==='new').completedAt,300000);
  data.boardPageInfo.filters={};
  appendBoardTasks(data,[]);
  assert.deepEqual(data.tasks.filter(item=>item.state==='done').map(item=>item.internalId),['old','undated','new','tie-b','tie-a']);
  reconcileCommandResult(data,{entities:[{...done('new',3,null),entityType:'task',status:'in_review',revision:9}]});
  assert.equal(data.tasks.find(item=>item.internalId==='new').completedAt,null);
});

test('a newest-first Done puts the task completed last first within one second',()=>{
  const data=createLegacyData(),value=bootstrap();
  value.boardFilter={doneOrder:'completed'};value.boardPages={done:{nextCursor:null,total:0}};value.selectedProjectId='p1';
  hydrateLegacyData(data,value);
  const done=(id,completionOrder)=>({...value.tasks[0],id,taskKey:`BIR-${id}`,status:'done',position:1,completedAt:200,completionOrder});
  appendBoardTasks(data,[done('first',7),done('last',9),done('second',8)]);
  assert.deepEqual(data.tasks.filter(item=>item.state==='done').map(item=>item.internalId),['last','second','first']);
});

test('an explicitly empty roadmap clears stale project collections',()=>{
  const data=createLegacyData();hydrateLegacyData(data,bootstrap());
  replaceRoadmap(data,{projectId:'p1',tracks:[],epics:[],milestones:[]});
  assert.equal(data.tracks.length,0);assert.equal(data.epics.length,0);assert.equal(data.milestones.length,0);
});

test('task block entities update and resolve the owning task without client activity',()=>{
  const data=createLegacyData();hydrateLegacyData(data,bootstrap());
  reconcileCommandResult(data,{entities:[
    {...bootstrap().tasks[0],entityType:'task',revision:6,activeBlock:{id:'b1',reason:'Waiting',createdBy:'u1',createdAt:200,revision:1}},
    {entityType:'taskBlock',id:'b1',taskId:'opaque-task',reason:'Waiting',createdBy:'u1',createdAt:200,revision:1},
  ],events:[]});
  assert.equal(data.tasks[0].block.reason,'Waiting');
  reconcileCommandResult(data,{entities:[{entityType:'taskBlock',id:'b1',taskId:'opaque-task',reason:'Still waiting',revision:2}],events:[]});
  assert.equal(data.tasks[0].block.reason,'Still waiting');
  reconcileCommandResult(data,{entities:[{entityType:'taskBlock',id:'b1',taskId:'opaque-task',resolved:true,revision:3}],events:[]});
  assert.equal(data.tasks[0].block,null);
  assert.deepEqual(data.tasks[0].activity,[]);
});

test('admin user pages preserve project-member identities outside the global page',()=>{
  const data=createLegacyData(),value=bootstrap();
  value.users.push({id:'member-z',username:'zz-member',name:'Last Member',isAdmin:false,isActive:true,revision:1});
  value.memberships.push({projectId:'p1',userId:'member-z',manageRoadmap:false,manageBoard:false,revision:1});
  hydrateLegacyData(data,value);
  const page=Array.from({length:50},(_,index)=>({id:`global-${index}`,username:`account-${String(index).padStart(2,'0')}`,name:`Account ${index}`,admin:false,active:true,revision:1}));
  mergeAdminUsersPage(data,page,{nextCursor:'account-49'});
  assert.equal(data.adminUsers.ids.length,50);
  assert.equal(data.adminUsers.nextCursor,'account-49');
  assert.equal(data.users.find((user)=>user.id==='member-z').name,'Last Member');
  assert.ok(!data.adminUsers.ids.includes('member-z'));
});

test('epic pages append all tasks and projected activity without replacing board state',()=>{
  const data=createLegacyData();hydrateLegacyData(data,bootstrap());
  const first={...bootstrap().tasks[0],id:'epic-task-1',taskKey:'BIR-101'};
  const second={...bootstrap().tasks[0],id:'epic-task-2',taskKey:'BIR-102'};
  mergeEpicTaskPage(data,'e1',[first],{nextCursor:'next',total:2});
  mergeEpicTaskPage(data,'e1',[second],{nextCursor:null,total:2},true);
  assert.deepEqual(data.epicPageInfo.e1.taskIds,['epic-task-1','epic-task-2']);
  assert.equal(data.epicPageInfo.e1.tasksTotal,2);
  assert.ok(data.tasks.some((task)=>task.internalId==='opaque-task'));
  mergeEpicActivityPage(data,'e1',[{id:'later',ts:20},{id:'earlier',ts:10}],'older');
  assert.deepEqual(data.epics[0].activity.map((item)=>item.id),['earlier','later']);
  assert.equal(data.epicPageInfo.e1.activityCursor,'older');
});

test('authorized bootstrap keeps separately loaded task data but removes omitted tasks',()=>{
  const data=createLegacyData();hydrateLegacyData(data,bootstrap());
  const attachments=[{id:'file',name:'context.pdf'}],comments=[{id:'comment',text:'Saved'}];
  Object.assign(data.tasks[0],{attachments,comments});
  hydrateLegacyData(data,bootstrap());
  assert.equal(data.tasks[0].attachments,attachments);assert.equal(data.tasks[0].comments,comments);
  hydrateLegacyData(data,{...bootstrap(),tasks:[]});assert.equal(data.tasks.length,0);
});

test('project capabilities keep every member project visible without inventing admin memberships',()=>{
  const value=bootstrap();value.projects.push({id:'p2',manageRoadmap:false,manageBoard:true},{id:'p3',manageRoadmap:false,manageBoard:false});
  const data=createLegacyData();hydrateLegacyData(data,value);
  assert.deepEqual(data.projects.map(project=>project.members),[
    [{userId:'u1',permissions:['manage_roadmap'],revision:1}],
    [{userId:'u1',permissions:['manage_board'],revision:null}],
    [{userId:'u1',permissions:[],revision:null}],
  ]);
  value.session.isAdmin=true;hydrateLegacyData(data,value);
  assert.deepEqual(data.projects.slice(1).map(project=>project.members),[[],[]]);
});

test('epic history and its older cursor survive roadmap and same-account metadata refreshes',()=>{
  const data=createLegacyData();hydrateLegacyData(data,bootstrap());
  mergeEpicActivityPage(data,'e1',[{id:'a3',ts:3}], 'page2');
  mergeEpicActivityPage(data,'e1',[{id:'a2',ts:2}], 'page3',true);
  mergeEpicActivityPage(data,'e1',[{id:'a1',ts:1}], 'page4',true);
  replaceRoadmap(data,{projectId:'p1',tracks:bootstrap().tracks,epics:bootstrap().epics,milestones:[]});
  mergeEpicActivityPage(data,'e1',[{id:'a3',ts:3,text:'updated'}], 'page2');
  assert.deepEqual(data.epics[0].activity.map(item=>item.id),['a1','a2','a3']);assert.equal(data.epicPageInfo.e1.activityCursor,'page4');
  hydrateLegacyData(data,{...bootstrap(),view:'metadata'});assert.equal(data.epics[0].activity.length,3);assert.equal(data.epicPageInfo.e1.activityCursor,'page4');
  hydrateLegacyData(data,{...bootstrap(),session:{userId:'other'}});assert.equal(data.epics[0].activity.length,0);assert.deepEqual(data.epicPageInfo,{});
});


test('same-size people replacements invalidate renderer lookup ownership',()=>{
  const data=createLegacyData();hydrateLegacyData(data,bootstrap());
  const initial=data.peopleVersion,users=data.users;
  const next=bootstrap();next.users[0].displayName='Updated';next.users[0].isActive=false;
  hydrateLegacyData(data,next);assert.equal(data.users,users);assert.ok(data.peopleVersion>initial);
  const hydrated=data.peopleVersion;mergeAdminUsersPage(data,[{...data.users[0],name:'Canonical admin read'}]);
  assert.ok(data.peopleVersion>hydrated);assert.equal(data.users.length,1);
});


test('a task keeps the newer of two checklists of one revision, whichever read or result brings them',()=>{
  const data=createLegacyData();hydrateLegacyData(data,bootstrap());
  // A tick leaves the task's revision as it is; the checklist's version tells which is newer.
  const detail=(version,done)=>({...bootstrap().tasks[0],checklistVersion:version,checklistDone:Number(done),checklistTotal:1,checklist:[{id:'i1',taskId:'opaque-task',position:0,title:'Plan',done,revision:version+1}]});
  const card=(version,done)=>{const view=detail(version,done);delete view.description;delete view.checklist;return view;};
  const shown=()=>[data.tasks[0].checklistVersion,data.tasks[0].checklistDone,data.tasks[0].checklist?.[0]?.done,data.tasks[0].detailsLoaded];
  replaceTaskDetail(data,detail(2,true));
  replaceBoardTasks(data,'p1',[card(2,true)]);
  assert.deepEqual(shown(),[2,1,true,true],'a card of the same version keeps the items');
  for(const [older,read] of [['card',()=>replaceBoardTasks(data,'p1',[card(1,false)])],['detail',()=>replaceTaskDetail(data,detail(1,false))],['result',()=>reconcileCommandResult(data,{entities:[{entityType:'task',...detail(1,false)}]})]]){
    read();
    assert.deepEqual(shown(),[2,1,true,true],`an older ${older} leaves the newer checklist`);
  }
  replaceBoardTasks(data,'p1',[card(3,false)]);
  assert.deepEqual(shown(),[3,0,undefined,false],'a newer card drops the old items, so the task page reads them again');
});

test('older command responses cannot roll back a newer task snapshot or membership',()=>{
  const data=createLegacyData();hydrateLegacyData(data,bootstrap());
  const newer={...bootstrap().tasks[0],revision:7,title:'Newer',status:'done'};
  replaceBoardTasks(data,'p1',[newer]);
  reconcileCommandResult(data,{entities:[{...newer,entityType:'task',revision:6,title:'Older',status:'planning'}]});
  assert.equal(data.tasks[0].revision,7);assert.equal(data.tasks[0].title,'Newer');assert.equal(data.tasks[0].state,'done');
  reconcileCommandResult(data,{entities:[{entityType:'membership',projectId:'p1',userId:'u1',revision:3,manageBoard:true}]});
  reconcileCommandResult(data,{entities:[{entityType:'membership',projectId:'p1',userId:'u1',revision:2,manageBoard:false}]});
  assert.deepEqual(data.projects[0].members[0].permissions,['manage_board']);
  reconcileCommandResult(data,{entities:[{entityType:'task',id:newer.id,deleted:true,revision:6}]});
  assert.equal(data.tasks.length,0,'explicit deletions still apply');
});

test('older board, detail, epic and bootstrap reads preserve newer task commands',()=>{
  for(const read of [
    (data,view)=>replaceBoardTasks(data,'p1',[view]),
    (data,view)=>appendBoardTasks(data,[view]),
    (data,view)=>replaceTaskDetail(data,view),
    (data,view)=>mergeEpicTaskPage(data,'e1',[view],{}),
    (data,view)=>hydrateLegacyData(data,{...bootstrap(),tasks:[view]}),
  ]){
    const data=createLegacyData();hydrateLegacyData(data,bootstrap());
    reconcileCommandResult(data,{entities:[{entityType:'task',id:'opaque-task',revision:8,title:'Newer',status:'done'}]});
    const task=data.tasks[0];task.comments.push({id:'retained'});
    read(data,{...bootstrap().tasks[0],revision:7,title:'Older',status:'planning'});
    assert.equal(data.tasks[0],task);assert.equal(task.revision,8);assert.equal(task.title,'Newer');assert.equal(task.state,'done');assert.equal(task.comments.length,1);
    read(data,{...bootstrap().tasks[0],revision:8,title:'Equal canonical'});
    assert.equal(data.tasks[0].title,'Equal canonical','equal revisions can fill unloaded fields');
  }
});

test('a different account bootstrap never retains the previous account task details',()=>{
  const data=createLegacyData();hydrateLegacyData(data,bootstrap());
  data.tasks[0].revision=99;data.tasks[0].comments.push({id:'private'});
  hydrateLegacyData(data,{...bootstrap(),session:{userId:'other'}});
  assert.equal(data.tasks[0].revision,5);assert.deepEqual(data.tasks[0].comments,[]);
});

test('bootstrap keeps the server file limits',()=>{
  const data=createLegacyData(),limits={maxAttachmentBytes:123,maxAvatarBytes:456,maxAttachmentsPerTask:7};
  hydrateLegacyData(data,{limits});assert.deepEqual(data.limits,limits);
});

test('an administrator keeps loaded account pages through a project bootstrap until Users reloads them',()=>{
  const data=createLegacyData(),admin={...bootstrap(),session:{...bootstrap().session,isAdmin:true}};
  hydrateLegacyData(data,admin);
  const accounts=Array.from({length:3},(_,index)=>({id:`account-${index}`,username:`account${index}`,name:`Account ${index}`,admin:false,active:true,revision:1}));
  mergeAdminUsersPage(data,accounts,{nextCursor:'account2'});
  hydrateLegacyData(data,admin);
  assert.deepEqual(data.adminUsers.ids,['account-0','account-1','account-2']);assert.equal(data.adminUsers.nextCursor,'account2');
  assert.equal(data.users.find(user=>user.id==='account-2')?.name,'Account 2');
  hydrateLegacyData(data,{...admin,session:{...admin.session,isAdmin:false}});
  assert.equal(data.adminUsers.loaded,false);assert.equal(data.users.some(user=>user.id==='account-2'),false,'a former admin keeps no directory');
});

test('an epic drawer keeps its loaded tasks through a Roadmap bootstrap, but Board cards stay the Board window',()=>{
  const data=createLegacyData(),epicTask=(id)=>({...bootstrap().tasks[0],id,taskKey:id.toUpperCase(),status:'done'});
  hydrateLegacyData(data,bootstrap());
  mergeEpicTaskPage(data,'e1',[epicTask('epic-task-1'),epicTask('epic-task-2')],{nextCursor:'more',total:3});
  hydrateLegacyData(data,{...bootstrap(),view:'roadmap',tasks:[]});
  assert.deepEqual(data.epicPageInfo.e1.taskIds,['epic-task-1','epic-task-2']);assert.equal(data.epicPageInfo.e1.loaded,true);
  assert.deepEqual(data.tasks.map(item=>item.internalId).sort(),['epic-task-1','epic-task-2']);
  hydrateLegacyData(data,{...bootstrap(),view:'board',boardPages:{planning:{nextCursor:null,total:0},in_progress:{nextCursor:null,total:1},in_review:{nextCursor:null,total:0},done:{nextCursor:null,total:0}}});
  assert.deepEqual(data.tasks.map(item=>item.internalId),['opaque-task']);
});

/** Seconds since the epoch at `hour` o'clock on a day in the fixture's time zone, Asia/Tashkent (UTC+5). */
const tashkent = (day, hour = 10) => Date.parse(`${day}T${String(hour - 5).padStart(2, '0')}:00:00Z`) / 1000;
/** A task as a mark of a read gives it: within its section, or, with `trackId` and `epicId`, anywhere. */
const markView = (id, extra) => ({ id, taskKey:id.toUpperCase(), title:id, ...extra });
/**
 * The Roadmap's lanes as a read gives them: the work in progress drawn, the
 * longest overdue, each section's counts, and the days of Sep 1 to 10:
 * counts by day and the task of a day with one.
 */
const lanes = (task) => ({
  overdue:1, firstDay:'2025-01-01', lastDay:'2027-05-01',
  sections:[{ trackId:'tr1', epicId:null, planning:3, inProgress:1, inReview:0, done:2 }, { trackId:'tr1', epicId:'e1', planning:1, inProgress:0, inReview:0, done:5 }],
  open:[task], late:[markView('late', { trackId:'tr1', epicId:'e1', status:'planning', deadline:'2026-09-01', blocked:true })],
  days:{ from:'2026-09-01', to:'2026-09-10', sections:[{ trackId:'tr1', epicId:'e1', done:[0, 2, 0, 1], plans:[1], blocked:[1],
    marks:[markView('late', { status:'planning', deadline:'2026-09-01', blocked:true }), markView('old', { status:'done', completedAt:tashkent('2026-09-04', 23), assigneeIds:['u1'] })] }] },
});
const day = (done, plans = 0, blocked = 0) => ({ done, plans, blocked });
const mark = (id, extra) => ({ internalId:id, id:id.toUpperCase(), projectId:'p1', trackId:'tr1', epicId:'e1', title:id, deadline:null, startedAt:null, completedAt:null, assignees:[], block:null, ...extra });

test('a Roadmap bootstrap gives the lanes their work in progress, the counts of their days and the tasks of days with one, and another bootstrap forgets them', () => {
  const data = createLegacyData(), value = { ...bootstrap(), view:'roadmap', selectedProjectId:'p1' };
  value.roadmap = lanes(value.tasks[0]); value.tasks = [];
  hydrateLegacyData(data, value);
  const late = mark('late', { state:'planning', deadline:'2026-09-01', block:{}, day:'2026-09-01' });
  assert.deepEqual(data.roadmap, {
    projectId:'p1', window:{ from:'2026-09-01', to:'2026-09-10' }, shown:null, open:['opaque-task'], late:[late],
    sections:{ 'tr1/':{ planning:3, progress:1, review:0, done:2 }, 'tr1/e1':{ planning:1, progress:0, review:0, done:5 } },
    trackCounts:{ tr1:{ planning:4, progress:1, review:0, done:7 } }, overdue:1, firstDay:'2025-01-01', lastDay:'2027-05-01',
    days:{ 'tr1/e1':{ '2026-09-01':day(0, 1, 1), '2026-09-02':day(2), '2026-09-04':day(1) } },
    // A task done late in the evening is on its day in the project's time zone.
    marks:{ late, old:mark('old', { state:'done', completedAt:tashkent('2026-09-04', 23) * 1000, assignees:['u1'], day:'2026-09-04' }) },
  });
  assert.deepEqual(data.tasks.map((task) => [task.id, task.state]), [['BIR-001', 'progress']], 'only the work in progress is a task of the page');
  hydrateLegacyData(data, { ...bootstrap(), selectedProjectId:'p1' });
  assert.equal(data.roadmap, null);
});

test('days next to the ones the lanes hold join them, in place of what they held of those days, and others take their place', () => {
  const data = createLegacyData(), value = bootstrap();
  hydrateLegacyData(data, value);
  replaceRoadmap(data, { projectId:'p1', tracks:value.tracks, epics:value.epics, milestones:[], lanes:lanes(value.tasks[0]) });
  const roadmap = data.roadmap;
  // The days before, and Sep 1 again, where the plan is gone.
  appendRoadmapDays(data, 'p1', { from:'2026-08-20', to:'2026-09-01', sections:[{ trackId:'tr1', epicId:null, done:[1], marks:[markView('older', { status:'done', completedAt:tashkent('2026-08-20') })] }] });
  assert.equal(data.roadmap, roadmap, 'the same lanes');
  assert.deepEqual(roadmap.window, { from:'2026-08-20', to:'2026-09-10' });
  assert.deepEqual(roadmap.days, { 'tr1/e1':{ '2026-09-02':day(2), '2026-09-04':day(1) }, 'tr1/':{ '2026-08-20':day(1) } });
  assert.deepEqual(Object.keys(roadmap.marks).sort(), ['old', 'older']);
  assert.deepEqual([roadmap.marks.older.trackId, roadmap.marks.older.epicId, roadmap.marks.older.day], ['tr1', null, '2026-08-20'], 'in its section, on its day');
  assert.equal(roadmap.late.length, 1, 'the longest overdue stay');
  // Days apart from the ones held, as after a jump, take their place.
  appendRoadmapDays(data, 'p1', { from:'2027-01-01', to:'2027-01-31', sections:[] });
  assert.deepEqual([roadmap.window, roadmap.days, roadmap.marks], [{ from:'2027-01-01', to:'2027-01-31' }, {}, {}]);
  assert.equal(appendRoadmapDays(data, 'p2', { from:'2027-01-01', to:'2027-01-31', sections:[] }), null, 'another project\'s days');
});

test('a read of named tasks gives the days in view of the sections it changed, and the lanes keep the tasks of days that still have their one task', () => {
  const data = createLegacyData(), value = bootstrap();
  hydrateLegacyData(data, value);
  const opening = lanes(value.tasks[0]);
  // The track's own work has a done task on Sep 5, and one long before the view.
  opening.days.sections.push({ trackId:'tr1', epicId:null, done:[0, 0, 0, 0, 1], marks:[markView('own', { status:'done', completedAt:tashkent('2026-09-05') })] });
  replaceRoadmap(data, { projectId:'p1', tracks:value.tracks, epics:value.epics, milestones:[], lanes:opening });
  appendRoadmapDays(data, 'p1', { from:'2026-08-20', to:'2026-08-31', sections:[{ trackId:'tr1', epicId:null, done:[1] }] });
  // A teammate moved the late plan to Sep 3: the read counts the epic's days the lanes hold, Aug 20 to Sep 10, alone.
  const moved = { ...value.tasks[0], id:'late', taskKey:'LATE', status:'planning', deadline:'2026-09-03' };
  replaceRoadmap(data, { projectId:'p1', lanes:{ ...lanes(value.tasks[0]), open:[], late:undefined, overdue:0, tasks:[moved],
    days:{ from:'2026-08-20', to:'2026-09-10', sections:[{ trackId:'tr1', epicId:'e1', done:[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1], plans:[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] }] } } }, ['late'], []);
  const roadmap = data.roadmap;
  assert.deepEqual(roadmap.days, { 'tr1/e1':{ '2026-09-02':day(2), '2026-09-03':day(0, 1), '2026-09-04':day(1) }, 'tr1/':{ '2026-08-20':day(1), '2026-09-05':day(1) } }, 'another section\'s days stay');
  assert.deepEqual([roadmap.window, Object.keys(roadmap.marks).sort(), roadmap.marks.late.day, roadmap.overdue], [{ from:'2026-08-20', to:'2026-09-10' }, ['late', 'old', 'own'], '2026-09-03', 0]);
  assert.deepEqual(roadmap.open, [], 'the epic\'s work in progress came again: it has none');
  assert.deepEqual([data.tracks.map((track) => track.id), data.milestones.map((item) => item.id), roadmap.late.map((task) => task.id)], [['tr1'], [], ['LATE']], 'the tracks and longest overdue stay without a read of them');
  // A read of named tasks gives the epics it changed alone; the others stay.
  data.epics.push({ ...data.epics[0], id:'e2', title:'Other' });
  replaceRoadmap(data, { projectId:'p1', tracks:[], milestones:[], epics:[{ ...value.epics[0], title:'Launch now', taskDone:1 }], lanes:{ ...lanes(value.tasks[0]), open:[], tasks:[], late:[],
    days:{ from:'2026-08-20', to:'2026-09-10', sections:[] } } }, ['old'], ['tr1/e1']);
  assert.deepEqual(data.epics.map((epic) => [epic.id, epic.title]).sort(), [['e1', 'Launch now'], ['e2', 'Other']]);
  assert.deepEqual([data.tracks.length, data.roadmap.late], [1, []], 'the longest overdue it gives');
  replaceRoadmap(data, { projectId:'p1', lanes:{ ...lanes(value.tasks[0]), open:[], tasks:[],
    days:{ from:'2026-09-01', to:'2026-09-10', sections:[{ trackId:'tr1', epicId:'e1', done:[0, 2, 0, 1], plans:[0, 0, 1] }] } } }, ['late'], []);
  // Sep 4 gets another done task, a task the lanes saw in the epic: its mark no longer stands for the day.
  replaceRoadmap(data, { projectId:'p1', lanes:{ ...lanes(value.tasks[0]), open:[], tasks:[],
    days:{ from:'2026-09-01', to:'2026-09-10', sections:[{ trackId:'tr1', epicId:'e1', done:[0, 2, 0, 2] }] } } }, ['other'], ['tr1/e1']);
  assert.deepEqual(Object.keys(data.roadmap.marks).sort(), ['own']);
  assert.equal(data.roadmap.days['tr1/e1']['2026-09-03'], undefined, 'the section it names counts again');
});
