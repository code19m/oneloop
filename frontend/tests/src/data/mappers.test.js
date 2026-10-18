import assert from 'node:assert/strict';
import test from 'node:test';
import {mapActivity} from '../../../src/data/activity-mapper.js';
import {mapInboxItem} from '../../../src/data/inbox-mapper.js';
import {mentionFromWire,mentionsToWire} from '../../../src/data/wire.js';

test('activity events read as the line the timeline shows', () => {
  const users = [{id:'u2',name:'Bob'}];
  for (const [event, text] of [
    [{eventType:'task.blocked'}, 'blocked the task'],
    [{eventType:'task.blocked',after:{reason:'Waiting for approval'}}, 'blocked the task: Waiting for approval'],
    [{eventType:'task.block.reason.updated',after:{reason:'Waiting for documents'}}, 'edited the block reason: Waiting for documents'],
    [{eventType:'task.unblocked',after:{resolution:'Approved'}}, 'unblocked the task: Approved'],
    [{eventType:'task.assignee.added',before:null,after:'u2'}, 'assigned Bob'],
    [{eventType:'task.assignee.removed',before:'u2',after:null}, 'unassigned Bob'],
    [{eventType:'attachment.cleaned',metadata:{name:'old.txt'}}, 'Temporary file removed during storage cleanup: old.txt'],
    // Restores read like the deletions they undo.
    [{eventType:'task.restored'}, 'restored the task'],
    [{eventType:'comment.restored'}, 'restored a comment'],
    [{eventType:'attachment.restored',metadata:{name:'plan.pdf'}}, 'restored attachment: plan.pdf'],
    [{eventType:'epic.restored'}, 'restored the epic'],
  ]) assert.equal(mapActivity(event, users).text, text, event.eventType);
});

test('a change of a task\'s track or epic names where the task went, and a gone epic goes without its name', () => {
  const roadmap = {tracks:[{id:'ios',name:'iOS'}], epics:[{id:'pay',title:'Payments v2'},{id:'web',title:'Web launch'}]};
  for (const [fieldKey, before, after, text] of [
    ['trackId', 'web-track', 'ios', 'moved the task to iOS'],
    ['trackId', 'ios', 'deleted-track', 'moved the task to another track'],
    ['epicId', null, 'pay', 'added the task to Payments v2'],
    ['epicId', 'pay', null, 'removed the task from Payments v2'],
    ['epicId', 'deleted-epic', null, 'removed the task from its epic'],
    ['epicId', 'pay', 'web', 'moved the task to Web launch'],
  ]) assert.equal(mapActivity({eventType:'task.updated',fieldKey,before,after}, [], roadmap).text, text, `${fieldKey} ${before} ${after}`);
});

test('an activity event keeps who acted, when and which block it was about; new comments add no row', () => {
  const event = mapActivity({id:'e1',eventType:'task.blocked',actorUserId:'u1',actorMcpGrantId:'g1',actorAppName:'Planning Assistant',createdAt:5,metadata:{blockId:'b1'}}, []);
  assert.equal(event.blockId, 'b1');
  assert.equal(event.ts, 5000);
  assert.equal(event.actorAppName, 'Planning Assistant');
  assert.equal(event.actorMcpGrantId, 'g1');
  // The comment itself shows in the timeline.
  assert.equal(mapActivity({eventType:'comment.created'}, []), null);
  assert.equal(mapActivity({eventType:'comment.replied'}, []), null);
});

test('an Inbox item keeps the server IDs and names the actor only by their user ID', () => {
  const item = mapInboxItem({id:'n1',eventType:'discussion.mention',actorName:'Bob',actorUserId:'u2',projectId:'p1',taskId:'opaque-task',taskKey:'ONE-101',taskTitle:'Review',destinationAvailable:true,createdAt:12,readAt:null,archivedAt:null});
  assert.equal(item.taskId, 'opaque-task');
  assert.equal(item.taskKey, 'ONE-101');
  assert.equal(item.createdAt, 12_000);
  // Two people may share a name, so the avatar never comes from the name.
  assert.equal(mapInboxItem({id:'one',actorName:'Same name',actorUserId:'alice'}).actorId, 'alice');
  assert.equal(mapInboxItem({id:'two',actorName:'Same name',actorUserId:'bob'}).actorId, 'bob');
  assert.equal(mapInboxItem({id:'legacy',actorName:'Same name'}).actorId, null);
  assert.equal(mapInboxItem({id:'unavailable',actorName:null,actorUserId:null}).actorId, null);
});

test('block Inbox items tell direct from broadcast mentions and keep older rows readable', () => {
  for (const [eventType, reason] of [
    ['task.block.mentioned','block-mention'],['task.block.everyone','block-everyone'],
    ['task.blocked','blocked'],['task.block.reason.updated','block-mention'],
  ]) assert.equal(mapInboxItem({id:'block-item',eventType,blockId:'episode',destinationAvailable:true}).reason, reason, eventType);
});

test('mentions cross the wire as UTF-16 offsets, with the at sign only in the wire label', () => {
  const text = 'Hi 👋 @bob';
  const wire = [{kind:'user',userId:'u2',startOffset:6,endOffset:10,label:'@bob'}];
  assert.deepEqual(mentionsToWire(text, [{id:'u2',label:'bob',start:6,end:10}]), wire);
  assert.deepEqual(wire.map(mentionFromWire), [{id:'u2',label:'bob',start:6,end:10}]);
  assert.deepEqual(mentionsToWire('@everyone', [{id:'everyone',start:0,end:9}]), [{kind:'everyone',startOffset:0,endOffset:9,label:'@everyone'}]);
  assert.deepEqual(mentionFromWire({kind:'everyone',label:'@everyone',startOffset:0,endOffset:9}), {id:'everyone',label:'everyone',start:0,end:9});
});
