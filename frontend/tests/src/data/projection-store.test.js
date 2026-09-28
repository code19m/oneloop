import assert from 'node:assert/strict';
import test from 'node:test';
import { createLegacyData, hydrateLegacyData, mergeAdminUsersPage, mergeEpicActivityPage, mergeEpicTaskPage, reconcileCommandResult, appendBoardTasks, replaceTaskDetail, replaceBoardTasks, replaceRoadmap, wireStatus } from '../../../src/data/projection-store.js';

const bootstrap = () => ({
  timeZone: 'Asia/Tashkent',
  session: { userId: 'u1', username: 'taylorwu', name: 'Nico', isAdmin: false },
  users: [{ id:'u1', username:'taylorwu', name:'Nico', isAdmin:false, isActive:true, revision:2 }],
  projects: [{ id:'p1', name:'Birch Grove', taskPrefix:'BIR', revision:3 }],
  memberships: [{ projectId:'p1', userId:'u1', manageRoadmap:true, manageBoard:false, revision:1 }],
  tracks: [{ id:'tr1', projectId:'p1', name:'Web', description:'', position:1, revision:1 }],
  epics: [{ id:'e1', projectId:'p1', trackId:'tr1', title:'Launch', description:'Plan', startDate:'2026-09-20', endDate:null, state:'active', position:1, taskDone:0, taskTotal:1, revision:4 }],
  milestones: [{ id:'m1', projectId:'p1', title:'Go live', description:'', milestoneDate:'2026-10-01', revision:1 }],
  tasks: [{ id:'opaque-task', projectId:'p1', epicId:'e1', taskKey:'BIR-001', title:'Ship', description:'Now', status:'in_progress', position:1, deadline:null, createdAt:100, updatedAt:101, revision:5, assigneeIds:['u1'], activeBlock:null }],
  pool: [{ id:'pool1', projectId:'p1', scope:'personal', ownerUserId:'u1', title:'Later', description:'', createdAt:100, revision:1 }],
  notifications: [], browserSessions: [], appGrants: [],
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
  assert.equal(data.pool[0].scope, 'mine');
  assert.equal(wireStatus('review'), 'in_review');
});

test('browser sessions keep a concise device label rather than a raw user agent',()=>{
  const data=createLegacyData(),value=bootstrap();
  const userAgent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  value.browserSessions=[{id:'s1',clientName:userAgent,userAgent,createdAt:100,lastActivityAt:101,current:true}];
  hydrateLegacyData(data,value);
  assert.equal(data.browserSessions[0].device,'Chrome on macOS');
  assert.equal(data.browserSessions[0].browser,null);
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
