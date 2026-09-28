// @ts-check

import {secondsToMilliseconds} from './time.js';

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const statusName = (value) => ({planning:'Planning',in_progress:'In Progress',in_review:'In Review',done:'Done'})[value] ?? value;

/** Project a server activity row into the stable shape used by legacy feeds. */
export function mapActivity(event, users = []) {
  if (['comment.created','comment.replied'].includes(event.eventType)) return null;
  const userName = (id) => users.find((user) => user.id === id)?.name ?? id ?? 'a former member';
  let text;
  switch (event.eventType) {
    case 'comment.edited': text = 'edited a comment'; break;
    case 'comment.deleted': text = 'removed a comment'; break;
    case 'task.created': text = 'created the task'; break;
    case 'task.deleted': text = 'deleted the task'; break;
    case 'task.moved': text = event.fieldKey === 'status' ? `moved the task to ${statusName(event.after)}` : 'reordered the task'; break;
    case 'task.assignee.added': text = `assigned ${userName(event.after)}`; break;
    case 'task.assignee.removed': text = `unassigned ${userName(event.before)}`; break;
    case 'task.blocked': text = `blocked the task${event.after?.reason ? ': '+event.after.reason : ''}`; break;
    case 'task.block.reason.updated': text = `edited the block reason${event.after?.reason ? ': '+event.after.reason : ''}`; break;
    case 'task.unblocked': text = `unblocked the task${event.after?.resolution ? ': '+event.after.resolution : ''}`; break;
    case 'task.unblocked_and_completed': text = `unblocked and completed the task${event.after?.resolution ? ': '+event.after.resolution : ''}`; break;
    case 'task.updated': {
      const names={title:'title',description:'description',deadline:'deadline',epicId:'epic'};
      text=`updated the ${names[event.fieldKey] ?? event.fieldKey ?? 'task'}`;
      break;
    }
    case 'epic.created': text = 'created the epic'; break;
    case 'epic.completed': text = 'marked the epic as done'; break;
    case 'epic.reopened': text = 'reopened the epic'; break;
    case 'epic.updated': {
      const names={title:'title',description:'description',trackId:'track',startDate:'start date',endDate:'end date',state:'state'};
      text=`updated the ${names[event.fieldKey] ?? event.fieldKey ?? 'epic'}`;
      break;
    }
    case 'attachment.created': text = `attached ${event.metadata?.name ?? 'a file'}`; break;
    case 'attachment.deleted': text = `deleted attachment: ${event.metadata?.name ?? 'file'}`; break;
    case 'attachment.retention.updated': text = `made ${event.metadata?.name ?? 'an attachment'} ${event.after ? 'temporary' : 'permanent'}`; break;
    case 'attachment.cleaned': text = `Temporary file removed during storage cleanup: ${event.metadata?.name ?? 'file'}`; break;
    default: text = String(event.eventType ?? 'updated the task').replaceAll('.', ' ').replaceAll('_', ' '); break;
  }
  return {
    id: event.id,
    who: event.actorUserId ?? 'system',
    actorName: event.actorName ?? null,
    actorMcpGrantId: event.actorMcpGrantId ?? null,
    actorAppName: event.actorAppName ?? null,
    ts: secondsToMilliseconds(event.createdAt),
    text,
    field: event.fieldKey ?? null,
    before: clone(event.before),
    after: clone(event.after),
    blockId: event.metadata?.blockId ?? null,
  };
}
