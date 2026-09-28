import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiError} from '../../../src/data/api-client.js';
import {
  actionErrorFeedback,
  commandInteractionKey,
  commandIsUnchanged,
  formFieldName,
  retryDelayMs,
  validDate,
} from '../../../src/app/action-feedback.js';

test('unchanged update commands are recognized without confusing null with omission',()=>{
  const task={internalId:'task-1',epicId:'epic-1',title:'Title',desc:'Description',deadline:null,assignees:['u1','u2'],state:'progress',order:4};
  assert.equal(commandIsUnchanged('task.update',{taskId:'task-1',title:'Title'},task),true);
  assert.equal(commandIsUnchanged('task.update',{taskId:'task-1',deadline:null},task),true);
  assert.equal(commandIsUnchanged('task.update',{taskId:'task-1',deadline:'2026-09-22'},task),false);
  assert.equal(commandIsUnchanged('task.update',{taskId:'task-1',assigneeIds:['u2','u1']},task),true);
  assert.equal(commandIsUnchanged('task.move',{taskId:'task-1',status:'in_progress'},task),true);
  assert.equal(commandIsUnchanged('task.move',{taskId:'task-1',status:'in_review'},task),false);
  assert.equal(commandIsUnchanged('task.move',{taskId:'task-1',status:'in_progress',beforeTaskId:'task-2'},task),false);
});

test('interaction identities serialize values for one field while keeping fields separate',()=>{
  const task={internalId:'task-1'};
  const title=commandInteractionKey('task.update',{taskId:'task-1',title:'One'},task);
  const sameTitle=commandInteractionKey('task.update',{title:'One',taskId:'task-1'},task);
  const nextTitle=commandInteractionKey('task.update',{taskId:'task-1',title:'Two'},task);
  const assignees=commandInteractionKey('task.update',{taskId:'task-1',assigneeIds:['u2']},task);
  assert.equal(title,sameTitle);
  assert.equal(title,nextTitle);
  assert.notEqual(title,assignees);
  assert.equal(
    commandInteractionKey('task.update',{taskId:'task-1',epicId:'e1'},task),
    commandInteractionKey('task.update',{taskId:'task-1',epicId:'e2'},task),
  );
});

test('server validation becomes concise field feedback with structured and legacy errors',()=>{
  const structured=new ApiError('invalid title: must contain 1–140 characters',{code:'validation_failed',details:{field:'title',message:'must contain 1–140 characters'}});
  assert.deepEqual(actionErrorFeedback(structured),{silent:false,field:'title',message:'Use 1–140 characters for the title.'});
  const legacy=new ApiError('invalid endDate: cannot be before startDate',{code:'validation_failed'});
  assert.deepEqual(actionErrorFeedback(legacy),{silent:false,field:'endDate',message:'End date cannot be before the start date.'});
  assert.equal(formFieldName('taskPrefix'),'key');
});

test('known no-change and unfinished-member errors receive intentional treatment',()=>{
  assert.equal(actionErrorFeedback(new ApiError('invalid payload: no task fields changed',{code:'validation_failed'})).silent,true);
  assert.equal(
    actionErrorFeedback(new ApiError("reassign the member's unfinished tasks before removal",{code:'precondition_failed'})).message,
    'This member still has unfinished tasks. Reassign them before removing the member.',
  );
});

test('credential and prefix failures point to the field that can be corrected',()=>{
  assert.deepEqual(actionErrorFeedback(new ApiError('authentication is required',{status:401,code:'invalid_credentials'})),
    {silent:false,field:'password',message:'Incorrect username or password.'});
  assert.deepEqual(actionErrorFeedback(new ApiError('Incorrect current password.',{status:400,code:'incorrect_password',details:{field:'currentPassword'}})),
    {silent:false,field:'currentPassword',message:'Incorrect current password.'});
  assert.deepEqual(actionErrorFeedback(new ApiError('task prefix is reserved by another project or its history',{status:409,code:'conflict'})),
    {silent:false,field:'taskPrefix',message:'This task prefix is already in use. Choose another.'});
  assert.equal(formFieldName('currentPassword'),'cur');
});

test('access and unexpected errors use safe copy while keeping a server reference',()=>{
  assert.equal(actionErrorFeedback(new ApiError('you do not have permission to perform this action',{status:403,code:'forbidden'})).message,
    'You do not have permission to make this change.');
  assert.equal(actionErrorFeedback(new ApiError('task was not found',{status:404,code:'not_found'})).message,
    'This item is no longer available. Refresh to continue.');
  assert.equal(actionErrorFeedback(new ApiError('authentication is required',{status:401,code:'unauthorized'})).message,
    'Your session has ended. Sign in again.');
  const unexpected=new ApiError('internal error: disk path /secret (reference: 01234567-abcd)',{status:500,code:'internal_error'});
  assert.equal(actionErrorFeedback(unexpected).message,'The request could not be completed. Reference: 01234567-abcd.');
  assert.ok(!actionErrorFeedback(new ApiError('internal error: /secret',{status:500})).message.includes('/secret'));
});

test('Retry-After seconds and HTTP dates produce an actionable wait',()=>{
  const now=Date.parse('2026-09-24T10:00:00Z');
  assert.equal(retryDelayMs(new ApiError('busy',{retryAfter:'73'}),now),73_000);
  assert.equal(retryDelayMs(new ApiError('busy',{retryAfter:new Date(now+120_000).toUTCString()}),now),120_000);
  assert.equal(retryDelayMs(new ApiError('busy',{retryAfter:'invalid'}),now),0);
  assert.equal(retryDelayMs(new ApiError('busy',{retryAfter:'-1'}),now),0);
  assert.equal(actionErrorFeedback(new ApiError('too many attempts; try again later',{status:429,code:'rate_limited',retryAfter:'73'})).message,
    'Too many attempts. Try again in 1 minute 13 seconds.');
  assert.equal(actionErrorFeedback(new ApiError('<html>proxy failed</html>',{status:503,retryAfter:'invalid'})).message,
    'The service is temporarily unavailable. Try again in a moment.');
});

test('date validation rejects partial and impossible calendar dates',()=>{
  assert.equal(validDate('2026-09-22'),true);
  assert.equal(validDate('2026-02-29'),false);
  assert.equal(validDate('2026-9-22'),false);
  assert.equal(validDate(''),false);
});

test('product constraints retain actionable reasons and intentional cancellation stays quiet',()=>{
  assert.match(actionErrorFeedback({code:'precondition_failed',message:'the last project cannot be deleted'}).message,/last project cannot be deleted/);
  assert.match(actionErrorFeedback({code:'precondition_failed',message:'@everyone can be used once per project per minute'}).message,/once per project per minute/);
  assert.match(actionErrorFeedback({status:503,code:'unavailable',message:'attachment storage capacity is exhausted'}).message,/Free up space/);
  for(const code of ['aborted','reauth_cancelled','stale_session'])assert.equal(actionErrorFeedback({code}).silent,true);
});


test('duplicate usernames and protected administrator constraints are corrective, not revision conflicts',()=>{
  assert.deepEqual(actionErrorFeedback(new ApiError('username is already in use',{status:409,code:'conflict'})),{silent:false,field:'username',message:'This username is already in use. Choose another.'});
  assert.match(actionErrorFeedback(new ApiError('the last active administrator cannot be deactivated or demoted',{status:409,code:'conflict'})).message,/Keep at least one active administrator/);
  assert.match(actionErrorFeedback(new ApiError('user was changed by another request',{status:409,code:'conflict'})).message,/This item changed/);
});

test('specific server codes work independently of server wording', () => {
  const cases = [
    ['prefix_reserved', 'taskPrefix', 'already in use'],
    ['username_taken', 'username', 'already in use'],
    ['last_admin', null, 'at least one active administrator'],
    ['already_member', null, 'already a project member'],
    ['member_has_open_tasks', null, 'unfinished tasks'],
    ['storage_full', null, 'not enough storage'],
    ['recent_auth_required', null, 'Confirm your password'],
    ['broadcast_cooldown', null, 'one minute'],
    ['idempotency_key_reused', null, 'already used'],
  ];
  for (const [code, field, text] of cases) {
    const result = actionErrorFeedback({code, message:'Server copy may change'});
    assert.equal(result.field, field);
    assert.ok(result.message.includes(text), code);
  }
});

test('task insertion indices are not compared with gapped ordering keys',()=>{
  const task={state:'planning',order:1024};
  assert.equal(commandIsUnchanged('task.move',{status:'planning',position:1024},task),false);
  assert.equal(commandIsUnchanged('task.move',{status:'planning'},task),true);
  assert.equal(actionErrorFeedback({code:'validation_failed',message:'invalid position: task is already at that position'}).silent,true);
});
