// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* The body of each dialog that the views open. */

import { blockReasonHtml } from './collaboration.js';
import { dateHtml, dateValue, field, selectHtml } from './controls.js';
import { UIAction, esc, iso, today } from './format.js';
import { descriptionEditorHtml, taskModalHtml } from './forms.js';
import {
  D, activeAdmins, epicById, knowledge, state, taskById, trackById, tracks, userById, userHandle,
} from './model.js';
import { poolViewHtml } from './pool.js';

export function renderModal() {
  const m = state.modal;
  if (!m) return '';
  let body = '';
  if (['block','unblock','completeBlocked'].includes(m.type)) {
    const task=taskById(m.id),blocking=m.type==='block',complete=m.type==='completeBlocked';
    if(!task)return '';
    body=`<h2>${blocking ? task.block ? 'Edit block reason' : 'Block task' : complete ? 'Unblock and complete task?' : 'Unblock task'}</h2>
      ${!blocking ? `<p class="sub">${esc(task.block?.reason || '')}</p>` : ''}
      <form novalidate data-block-action ${UIAction.on('submit', 'saveBlock', UIAction.event, task.id, m.type)}>
        ${field(blocking?'Reason':'Resolution',blocking ? blockReasonHtml(task) : `<textarea class="ctl" name="reason" maxlength="500" placeholder="How was this resolved?" ${UIAction.on('keydown', 'commentKey', UIAction.event)}></textarea>`,!blocking)}
        <div class="modal-actions"><button type="button" class="btn quiet" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary">${blocking?'Save':complete?'Unblock and complete':'Unblock'}</button></div>
      </form>`;
  } else if (m.type === 'epic') {
    const e = m.id ? epicById(m.id) : null;
    body = `<h2>${e ? 'Edit epic' : 'New epic'}</h2>
    <form novalidate ${UIAction.on('submit', 'saveEpic', UIAction.event, m.id || '')}>
      ${field('Title', `<input class="ctl" name="title" placeholder="Payment integration" value="${esc(e ? e.title : '')}" maxlength="120" required autofocus>`)}
      ${field('Track', selectHtml('mTrack', { name: 'trackId', value: e ? e.trackId : (m.trackId || ''), placeholder: 'Choose a track', options: tracks().map((t) => ({ v: t.id, l: t.name })) }))}
      <div class="field-row">
        ${field('Start', dateHtml('mStart', { name: 'start', value: e ? e.start : iso(today), max: () => dateValue('mEnd'), maxError: 'Start date cannot be after the end date.' }))}
        ${field('End', dateHtml('mEnd', { name: 'end', value: (e && e.end) || '', clearable: true, min: () => dateValue('mStart'), minError: 'End date cannot be before the start date.', placeholder: 'No end date' }), true)}
      </div>
      ${field('Description', descriptionEditorHtml(e?.desc,2000), true)}
      <div class="modal-actions"><button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">${e ? 'Save' : 'Create epic'}</button></div>
    </form>`;
  } else if (m.type === 'milestone') {
    const ms = m.id ? D.milestones.find((x) => x.id === m.id) : null;
    body = `<h2>${ms ? 'Edit milestone' : 'New milestone'}</h2>
    <form novalidate ${UIAction.on('submit', 'saveMilestone', UIAction.event, m.id || '')}>
      ${field('Name', `<input class="ctl" name="name" placeholder="Public launch" value="${esc(ms ? ms.name : '')}" maxlength="60" required autofocus>`)}
      ${field('Date', dateHtml('mDate', { name: 'date', value: ms ? ms.date : iso(today) }))}
      ${field('Goal', descriptionEditorHtml(ms?.desc,500), true)}
      <div class="modal-actions">${ms ? `<button class="btn danger lead" type="button" ${UIAction('deleteMilestone', ms.id)}>Delete</button>` : ''}<button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">${ms ? 'Save' : 'Create milestone'}</button></div>
    </form>`;
  } else if (m.type === 'track') {
    const t = m.id ? trackById(m.id) : null;
    body = `<h2>${t ? 'Rename track' : 'New track'}</h2>
    <form novalidate ${UIAction.on('submit', 'saveTrack', UIAction.event, m.id || '')}>
      ${field('Name', `<input class="ctl" name="name" placeholder="Backend & API" value="${esc(t ? t.name : '')}" maxlength="60" required autofocus>`)}
      <div class="modal-actions"><button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">${t ? 'Save' : 'Create track'}</button></div>
    </form>`;
  } else if (m.type === 'task') {
    body = taskModalHtml(m);
  } else if (m.type === 'project') {
    body = `<h2>New project</h2>
    <form novalidate ${UIAction.on('submit', 'saveProjectNew', UIAction.event)}>
      ${field('Name', `<input class="ctl" name="name" maxlength="60" required autofocus>`)}
      ${field('Task prefix', `<input class="ctl mono" name="key" placeholder="APP" maxlength="4">`)}
      <div class="modal-actions"><button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">Create project</button></div>
    </form>`;
  } else if (m.type === 'user') {
    const u = m.id ? userById(m.id) : null;
    const lastAdmin = u && u.admin && u.active && activeAdmins().length === 1;
    body = `<h2>${u ? 'Edit user' : 'New user'}</h2>
    <form novalidate ${UIAction.on('submit', 'saveUser', UIAction.event, m.id || '')}>
      ${field('Username', `<input class="ctl mono" name="username" value="${esc(u ? userHandle(u) : '')}" ${u ? 'disabled' : 'autofocus'} maxlength="32">`)}
      ${field('Full name', `<input class="ctl" name="name" value="${esc(u ? u.name : '')}" maxlength="80" ${u ? 'autofocus' : ''}>`)}
      <label class="check user-admin"><input type="checkbox" name="admin" ${u && u.admin ? 'checked' : ''} ${lastAdmin ? 'disabled' : ''}> Admin${lastAdmin ? ' <span class="mono subtle">· last active admin</span>' : ''}</label>
      ${u ? `<label class="check user-active"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} ${lastAdmin ? 'disabled' : ''}> Active</label>` : ''}
      <div class="modal-actions">
        ${u ? `<button class="btn lead" type="button" ${UIAction('resetPassword', u.id)}>Reset password</button>` : ''}
        <button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button>
        <button class="btn primary" type="submit">${u ? 'Save' : 'Create user'}</button>
      </div>
    </form>`;
  } else if (m.type === 'temppw') {
    const user=userById(m.id),account=user?.username||user?.name||'Account';
    body = `<h2>Temporary password</h2>
    <div class="temporary-password-meta"><strong>${esc(account)}</strong><span>Shown once</span></div>
    <div class="pw-box"><span class="mono" id="tmpPw">${esc(m.pw)}</span><button class="btn" type="button" aria-label="Copy temporary password" ${UIAction('copyTemporaryPassword')}>Copy</button></div>
    <div class="modal-actions"><button class="btn primary" ${UIAction('closeOverlays')}>Done</button></div>`;
  } else if (m.type === 'pool') {
    body = poolViewHtml();
  } else if (m.type === 'knowledge') {
    body = knowledge.modalHtml();
  } else if (m.type === 'confirm') {
    body = `<h2>${esc(m.title)}</h2><div class="sub">${esc(m.text)}</div>
    <div class="modal-actions"><button class="btn quiet" ${UIAction('closeOverlays')}>Cancel</button></div>`;
  }
  body = body.replace('<h2', '<h2 id="modal-title"');
  // The dialog's wrapper covers the backdrop, so a click beside the dialog does nothing.
  return `<div class="scrim"></div><div class="modal-wrap"><div class="modal${m.type === 'pool' ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">${body}</div></div>`;
}
