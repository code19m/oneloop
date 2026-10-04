// @ts-check

import {secondsToMilliseconds} from './time.js';

const inboxReason = (eventType) => ({
  'discussion.mention':'mention', 'discussion.everyone':'everyone', 'discussion.reply':'reply',
  'task.assigned':'assigned', 'task.blocked':'blocked', 'task.block.mentioned':'block-mention', 'task.block.everyone':'block-everyone', 'task.block.reason.updated':'block-mention',
  'task.unblocked':'unblocked', 'task.unblocked_and_completed':'unblocked',
})[eventType] ?? eventType;

/** @param {any} item */
export function mapInboxItem(item) {
  return {
    id: item.id,
    eventId: item.id,
    recipientId: null,
    actorId: item.actorUserId ?? null,
    actorName: item.actorName ?? null,
    projectId: item.projectId ?? null,
    projectName: item.projectName ?? null,
    taskId: item.taskId ?? null,
    taskKey: item.taskKey ?? null,
    taskTitle: item.taskTitle ?? null,
    commentId: item.commentId ?? null,
    rootId: null,
    blockId: item.blockId ?? null,
    reason: inboxReason(item.eventType),
    eventType: item.eventType,
    excerpt: item.excerpt ?? null,
    destinationAvailable: !!item.destinationAvailable,
    createdAt: secondsToMilliseconds(item.createdAt),
    readAt: item.readAt == null ? null : secondsToMilliseconds(item.readAt),
    archivedAt: item.archivedAt == null ? null : secondsToMilliseconds(item.archivedAt),
  };
}
