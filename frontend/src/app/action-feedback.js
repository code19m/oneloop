// @ts-check

const LEGACY_TO_WIRE_STATUS = Object.freeze({ planning:'planning', progress:'in_progress', review:'in_review', done:'done' });

/** @param {unknown[]} left @param {unknown[]} right */
function sameSet(left, right) {
  if (left.length !== right.length) return false;
  const values = new Set(left.map(String));
  return values.size === new Set(right.map(String)).size && right.every((value) => values.has(String(value)));
}

/** @param {unknown} left @param {unknown} right */
function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Detect update commands that cannot change persisted state. The backend remains
 * authoritative; this only keeps blur/save interactions quiet and avoids churn.
 * @param {string} operation
 * @param {Record<string,any>} payload
 * @param {Record<string,any>|null|undefined} entity
 */
export function commandIsUnchanged(operation, payload, entity) {
  if (!entity) return false;
  const has = (key) => Object.hasOwn(payload, key);
  switch (operation) {
    case 'project.update':
      return (!has('name') || payload.name === entity.name)
        && (!has('taskPrefix') || payload.taskPrefix === (entity.taskPrefix ?? entity.key));
    case 'membership.update': {
      const permissions = new Set(entity.permissions ?? []);
      return payload.manageRoadmap === permissions.has('manage_roadmap')
        && payload.manageBoard === permissions.has('manage_board');
    }
    case 'track.update':
      return (!has('name') || payload.name === entity.name)
        && (!has('description') || payload.description === (entity.desc ?? entity.description ?? ''));
    case 'track.reorder':
      return Number(payload.position) === Number(entity.order ?? entity.position);
    case 'epic.update':
      return (!has('trackId') || payload.trackId === entity.trackId)
        && (!has('title') || payload.title === entity.title)
        && (!has('description') || payload.description === (entity.desc ?? entity.description ?? ''))
        && (!has('startDate') || payload.startDate === (entity.start ?? entity.startDate))
        && (!has('endDate') || (payload.endDate ?? null) === (entity.end ?? entity.endDate ?? null));
    case 'milestone.update':
      return (!has('title') || payload.title === (entity.name ?? entity.title))
        && (!has('description') || payload.description === (entity.desc ?? entity.description ?? ''))
        && (!has('milestoneDate') || payload.milestoneDate === (entity.date ?? entity.milestoneDate));
    case 'task.update':
      return (!has('epicId') || payload.epicId === entity.epicId)
        && (!has('title') || payload.title === entity.title)
        && (!has('description') || payload.description === (entity.desc ?? entity.description ?? ''))
        && (!has('deadline') || (payload.deadline ?? null) === (entity.deadline ?? null))
        && (!has('assigneeIds') || sameSet(payload.assigneeIds ?? [], entity.assignees ?? entity.assigneeIds ?? []));
    case 'task.move': {
      if (has('beforeTaskId') || has('afterTaskId')) return false;
      const sameStatus = !has('status') || payload.status === (LEGACY_TO_WIRE_STATUS[entity.state] ?? entity.status ?? entity.state);
      // Stored positions may have gaps; a command position is an insertion index.
      return sameStatus && !has('position');
    }
    case 'task.block.update':
      return (!has('reason') || payload.reason === entity.reason)
        && (!has('mentions') || sameJson(payload.mentions, entity.mentions ?? []));
    case 'pool.update':
      return (!has('title') || payload.title === entity.title)
        && (!has('description') || payload.description === (entity.desc ?? entity.description ?? ''));
    default:
      return false;
  }
}

const OPERATION_IDENTITY_FIELDS = Object.freeze({
  'epic.update':['epicId'], 'membership.update':['projectId','userId'], 'membership.remove':['projectId','userId'],
  'milestone.update':['milestoneId'], 'pool.update':['poolItemId'], 'project.update':['projectId'],
  'task.block.update':['blockId'], 'task.move':['taskId'], 'task.update':['taskId'],
  'track.reorder':['trackId'], 'track.update':['trackId'],
});

/**
 * Keep independent autosave fields separate while every value written through
 * one field shares an interaction. The gateway can then serialize concurrent
 * values and decide whether an uncertain retry still represents the same intent.
 */
export function commandInteractionKey(operation, payload, entity) {
  const entityId = entity?.internalId ?? entity?.id ?? 'new';
  const identityFields=new Set(OPERATION_IDENTITY_FIELDS[operation]??['id']);
  const fields = Object.keys(payload).filter((key) => !identityFields.has(key)).sort();
  return `${operation}:${entityId}:${fields.join(',') || 'action'}`;
}

const FIELD_NAMES = Object.freeze({
  assigneeIds:'assignees', currentPassword:'cur', description:'desc', displayName:'name', endDate:'end',
  milestoneDate:'date', startDate:'start', taskPrefix:'key',
});

/** @param {string} field */
export function formFieldName(field) {
  return FIELD_NAMES[field] ?? field;
}

/** @param {string} field */
function fieldLabel(field) {
  return ({
    assigneeIds:'assignees', deadline:'deadline', description:'description', displayName:'name',
    endDate:'end date', epicId:'epic', milestoneDate:'date', name:'name', reason:'reason',
    startDate:'start date', taskPrefix:'task prefix', title:'title', trackId:'track', username:'username',
  })[field] ?? field.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

/** @param {string} field @param {string} message */
function friendlyValidation(field, message) {
  const label = fieldLabel(field);
  const requiredRange = message.match(/^must contain (\d+)[–-](\d+) characters$/);
  if (requiredRange) return `Use ${requiredRange[1]}–${requiredRange[2]} characters for the ${label}.`;
  const maximum = message.match(/^must contain at most (\d+) characters$/);
  if (maximum) return `Keep the ${label} within ${maximum[1]} characters.`;
  if (/valid date in YYYY-MM-DD/i.test(message)) return `Enter a valid ${label} in YYYY-MM-DD format.`;
  if (/cannot be before startDate/i.test(message)) return 'End date cannot be before the start date.';
  if (/unknown task status/i.test(message)) return 'Choose a valid task status.';
  if (/anchor is not in the destination column/i.test(message)) return 'That card position is no longer available. Try the move again.';
  return `Check the ${label} and try again.`;
}

/** Retry-After accepts whole seconds or an HTTP date. Invalid values do not block input. */
/** @param {unknown} error @param {number} [now] */
export function retryDelayMs(error, now = Date.now()) {
  const value = /** @type {any} */ (error)?.retryAfter;
  if (typeof value !== 'string') return 0;
  const header = value.trim();
  if (/^\d+$/.test(header)) {
    const seconds = Number(header);
    return Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : 0;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

/** The notice for a rate limit or an unavailable service, for the time still to wait. */
/** @param {unknown} error @param {number} wait */
export function retryMessage(error, wait) {
  const value = /** @type {any} */ (error);
  const start = value?.code === 'rate_limited' || value?.status === 429
    ? 'Too many attempts.' : 'The service is temporarily unavailable.';
  return `${start} Try again ${wait > 0 ? `in ${waitDescription(wait)}` : 'in a moment'}.`;
}

/** @param {number} milliseconds */
function waitDescription(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
    return `${minutes} minute${minutes === 1 ? '' : 's'}${remainder ? ` ${remainder} second${remainder === 1 ? '' : 's'}` : ''}`;
  }
  const hours = Math.ceil(seconds / 3600);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** @param {any} value */
function safeReference(value) {
  const structured = value?.reference ?? value?.details?.reference;
  const embedded = String(value?.message ?? '').match(/\(reference:\s*([A-Za-z0-9-]{8,64})\)/i)?.[1];
  const reference = typeof structured === 'string' ? structured : embedded;
  return /^[A-Za-z0-9-]{8,64}$/.test(reference ?? '') ? reference : null;
}

/** @param {unknown} error */
export function actionErrorFeedback(error) {
  const value = /** @type {any} */ (error);
  const raw = String(value?.message ?? 'The change could not be saved.');
  const code = value?.code;
  const status = value?.status;
  if (value?.code === 'validation_failed' && /no .+ fields changed|task is already at that position/i.test(raw)) {
    return { silent:true, field:null, message:'' };
  }
  if (code === 'member_has_open_tasks' || (code === 'precondition_failed' && /unfinished tasks before removal/i.test(raw))) {
    return { silent:false, field:null, message:'This member still has unfinished tasks. Reassign them before removing the member.' };
  }
  if (code === 'validation_failed') {
    const details = value.details && typeof value.details === 'object' ? value.details : null;
    const parsed = raw.match(/^invalid ([^:]+):\s*(.+)$/i);
    const field = typeof details?.field === 'string' ? details.field : parsed?.[1] ?? null;
    const message = typeof details?.message === 'string' ? details.message : parsed?.[2] ?? raw;
    return { silent:false, field, message:field ? friendlyValidation(field, message) : 'Check the form and try again.' };
  }
  if (code === 'invalid_credentials') return {silent:false,field:'password',message:'Incorrect username or password.'};
  if (code === 'incorrect_password') {
    const field = ['currentPassword','password'].includes(value?.details?.field) ? value.details.field : 'currentPassword';
    return {silent:false,field,message:'Incorrect current password.'};
  }
  if (code === 'prefix_reserved' || ((code === 'conflict' || status === 409) && /task prefix is reserved/i.test(raw))) {
    return {silent:false,field:'taskPrefix',message:'This task prefix is already in use. Choose another.'};
  }
  if (code === 'username_taken' || ((code === 'conflict' || status === 409) && /username is already in use/i.test(raw))) return {silent:false,field:'username',message:'This username is already in use. Choose another.'};
  if (code === 'last_admin' || ((code === 'conflict' || status === 409) && /last active administrator cannot be deactivated or demoted/i.test(raw))) return {silent:false,field:null,message:'Keep at least one active administrator. Add another administrator before removing this access.'};
  if (code === 'broadcast_cooldown') return {silent:false,field:null,message:'Wait one minute before mentioning everyone again.'};
  if (code === 'recent_auth_required') return {silent:false,field:null,message:'Confirm your password to continue.'};
  if (code === 'idempotency_key_reused') return {silent:false,field:null,message:'This request was already used for another change. Refresh and try again.'};
  if (code === 'invalid_origin') return {silent:false,field:null,message:'Open oneloop at its configured address and try again.'};
  if (code === 'forbidden' || status === 403) return {silent:false,field:null,message:'You do not have permission to make this change.'};
  if (code === 'not_found' || status === 404) return {silent:false,field:null,message:'This item is no longer available. Refresh to continue.'};
  if (code === 'unauthorized' || status === 401) return {silent:false,field:null,message:'Your session has ended. Sign in again.'};
  if(code==='storage_full'||(code==='unavailable'&&/storage safety floor|storage capacity is exhausted/i.test(raw)))return {silent:false,field:null,message:'There is not enough storage for this file. Free up space or contact an administrator.'};
  if (code === 'rate_limited' || status === 429 || code === 'unavailable' || status === 503) {
    return {silent:false,field:null,message:retryMessage(value, retryDelayMs(value))};
  }
  if(code==='already_member'||(code==='conflict'&&/already a project member/i.test(raw)))return {silent:false,field:null,message:'This person is already a project member.'};
  if (code === 'conflict' || status === 409) return {silent:false,field:null,message:'This item changed. Review the latest version and try again.'};
  if (code === 'precondition_failed') {
    // These are safe, explicit product constraints from the server, not internal diagnostics.
    const message=raw.charAt(0).toUpperCase()+raw.slice(1).replace(/\.$/,'')+'.';
    return {silent:false,field:null,message};
  }
  if(status===412)return {silent:false,field:null,message:'This action cannot be completed yet. Review the item and try again.'};
  if(code==='aborted'||code==='reauth_cancelled'||code==='stale_session')return {silent:true,field:null,message:''};
  if (code === 'timeout') return {silent:false,field:null,message:'The request took too long. Check the latest state before trying again.'};
  if (code === 'network_error') return {silent:false,field:null,message:'Connection lost. Check your connection and try again.'};
  if (code === 'validation_error') {
    const message = /at least 5 characters/i.test(raw) ? 'Use at least 5 characters.'
      : /passwords do not match/i.test(raw) ? 'Passwords do not match.'
      : 'Check the form and try again.';
    return {silent:false,field:null,message};
  }
  const reference = safeReference(value);
  return {silent:false,field:null,message:`The request could not be completed.${reference ? ` Reference: ${reference}.` : ''}`};
}

/** @param {unknown} error */
export function isServerNoChange(error) {
  return actionErrorFeedback(error).silent;
}

/** @param {unknown} value */
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year,month,day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
