// @ts-check

import {secondsToMilliseconds} from './time.js';
import {statusLabel} from './wire.js';

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

/**
 * What a change of a task's track or epic says, with the names the projection
 * has. An epic that is gone, such as a deleted one, goes without its name.
 * @param {any} event @param {{tracks?:any[],epics?:any[]}} roadmap
 */
function placeText(event, roadmap) {
  if (event.fieldKey === 'trackId') return `moved the task to ${roadmap.tracks?.find((track) => track.id === event.after)?.name ?? 'another track'}`;
  const title = (id) => roadmap.epics?.find((epic) => epic.id === id)?.title;
  if (event.after == null) return `removed the task from ${title(event.before) ?? 'its epic'}`;
  return `${event.before == null ? 'added the task to' : 'moved the task to'} ${title(event.after) ?? 'an epic'}`;
}

/**
 * Project a server activity row into the stable shape used by legacy feeds.
 * @param {any} event @param {any[]} [users] @param {{tracks?:any[],epics?:any[]}} [roadmap] the projection's tracks and epics, which name a task's place.
 */
export function mapActivity(event, users = [], roadmap = {}) {
  if (['comment.created','comment.replied'].includes(event.eventType)) return null;
  const userName = (id) => users.find((user) => user.id === id)?.name ?? id ?? 'a former member';
  let text;
  switch (event.eventType) {
    case 'comment.edited': text = 'edited a comment'; break;
    case 'comment.deleted': text = 'removed a comment'; break;
    case 'comment.restored': text = 'restored a comment'; break;
    case 'task.created': text = 'created the task'; break;
    case 'task.deleted': text = 'deleted the task'; break;
    case 'task.restored': text = 'restored the task'; break;
    case 'task.moved': text = event.fieldKey === 'status' ? `moved the task to ${statusLabel(event.after)}` : 'reordered the task'; break;
    case 'task.assignee.added': text = `assigned ${userName(event.after)}`; break;
    case 'task.assignee.removed': text = `unassigned ${userName(event.before)}`; break;
    case 'task.blocked': text = `blocked the task${event.after?.reason ? ': '+event.after.reason : ''}`; break;
    case 'task.block.reason.updated': text = `edited the block reason${event.after?.reason ? ': '+event.after.reason : ''}`; break;
    case 'task.unblocked': text = `unblocked the task${event.after?.resolution ? ': '+event.after.resolution : ''}`; break;
    case 'task.unblocked_and_completed': text = `unblocked and completed the task${event.after?.resolution ? ': '+event.after.resolution : ''}`; break;
    case 'task.updated': {
      const names={title:'title',description:'description',deadline:'deadline'};
      text=['trackId','epicId'].includes(event.fieldKey) ? placeText(event, roadmap) : `updated the ${names[event.fieldKey] ?? event.fieldKey ?? 'task'}`;
      break;
    }
    case 'epic.created': text = 'created the epic'; break;
    case 'epic.restored': text = 'restored the epic'; break;
    case 'epic.completed': text = 'marked the epic as done'; break;
    case 'epic.reopened': text = 'reopened the epic'; break;
    case 'epic.updated': {
      const names={title:'title',description:'description',trackId:'track',startDate:'start date',endDate:'end date',state:'state'};
      text=`updated the ${names[event.fieldKey] ?? event.fieldKey ?? 'epic'}`;
      break;
    }
    case 'attachment.created': text = `attached ${event.metadata?.name ?? 'a file'}`; break;
    case 'attachment.deleted': text = `deleted attachment: ${event.metadata?.name ?? 'file'}`; break;
    case 'attachment.restored': text = `restored attachment: ${event.metadata?.name ?? 'file'}`; break;
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
