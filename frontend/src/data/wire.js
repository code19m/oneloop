// @ts-check

/**
 * The server's names for task statuses, Pool scopes and mentions, mapped to
 * the names the client keeps from its first version, and back.
 */

const LEGACY_STATUS = Object.freeze({ planning: 'planning', in_progress: 'progress', in_review: 'review', done: 'done' });
const WIRE_STATUS = Object.freeze({ planning: 'planning', progress: 'in_progress', review: 'in_review', done: 'done' });
const LEGACY_SCOPE = Object.freeze({ personal: 'mine', team: 'project' });

/** @param {string} status */
export const toLegacyStatus = (status) => LEGACY_STATUS[/** @type {keyof typeof LEGACY_STATUS} */ (status)] ?? status;
/** @param {string} status */
export const toWireStatus = (status) => WIRE_STATUS[/** @type {keyof typeof WIRE_STATUS} */ (status)] ?? status;
/** What a status reads as, by the server's name or the client's. @param {string} status */
export const statusLabel = (status) => ({ planning: 'Planning', in_progress: 'In Progress', in_review: 'In Review', done: 'Done' })[toWireStatus(status)] ?? status;
/** @param {string} scope */
export const toLegacyScope = (scope) => LEGACY_SCOPE[/** @type {keyof typeof LEGACY_SCOPE} */ (scope)] ?? scope;
/** The server's scope of a Pool tab: `project` is the team's Pool, anything else the person's own. @param {string} scope */
export const toWireScope = (scope) => scope === 'project' ? 'team' : 'personal';

/**
 * Values the server keys by its status names, such as task counts or Board
 * columns, keyed by the client's.
 * @template T
 * @param {{planning:T,inProgress:T,inReview:T,done:T,blocked?:T}} values
 */
export const byStatus = (values) => ({ planning: values.planning, progress: values.inProgress, review: values.inReview, done: values.done, blocked: values.blocked });

/**
 * A mention as the client keeps it: who, its label without the leading at
 * sign, and where it sits in the text, in UTF-16 units.
 * @param {{kind?:string,userId?:string,label?:string,startOffset:number,endOffset:number}} mention
 */
export const mentionFromWire = (mention) => ({
  id: mention.kind === 'everyone' ? 'everyone' : mention.userId,
  label: String(mention.label ?? '').replace(/^@/, ''),
  start: mention.startOffset,
  end: mention.endOffset,
});

/**
 * The mentions of `text` as the server takes them.
 * @param {string} text @param {{id:string,start:number,end:number}[]} [mentions]
 */
export function mentionsToWire(text, mentions = []) {
  return mentions.map((mention) => ({
    kind: mention.id === 'everyone' ? 'everyone' : 'user',
    ...(mention.id === 'everyone' ? {} : { userId: mention.id }),
    startOffset: mention.start,
    endOffset: mention.end,
    label: text.slice(mention.start, mention.end),
  }));
}
