// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* The account pages: Profile, Users, and a project's Settings with its
   member list. */

import { UIMotion } from '../../src/app/motion.js';
import { field, selectHtml } from './controls.js';
import { I, UIAction, avatarHtml, esc, formatInstant, setHTML } from './format.js';
import { App, D, knowledge, me, project, recovery, state, userById, userHandle, visibleProjects } from './model.js';
import { closePop, rememberOpener, restoreOpener } from './overlays.js';

const currentBrowserSession = () => D.session ? (D.browserSessions || []).find(item => item.id === D.session.id && item.userId === D.session.userId && item.revokedAt == null) : null;
function renderProfileAccess() {
  const current = currentBrowserSession(), userId = me().id;
  const sessions = (D.browserSessions || []).filter(item => item.userId === userId && recovery.sessionActive(item)).sort((a,b) => Number(b.id === current?.id) - Number(a.id === current?.id) || b.lastActiveAt - a.lastActiveAt);
  const grants = (D.appGrants || []).filter(item => item.userId === userId && item.revokedAt == null && (!item.expiresAt || item.expiresAt > Date.now())).sort((a,b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  const fact = (label,value) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
  const date = value => value ? formatInstant(value) : 'Unavailable';
  const permissions = { read:'Read', manage_roadmap:'Manage Roadmap', manage_board:'Manage Board' };
  const sessionRows = sessions.map(item => `<div class="access-session-row" data-session-id="${esc(item.id)}">
    <div class="access-session-main"><div class="access-session-title">${esc(item.device || 'Unknown device')}${item.id === current?.id ? '<span class="current-session">Current</span>' : ''}</div>
    ${item.browser ? `<div class="access-session-sub">${esc(item.browser)}</div>` : ''}
    <dl class="access-session-facts">${fact('IP address',item.ip || 'Unavailable')}${fact('Last active',item.id === current?.id ? 'Now' : item.lastActiveAt ? date(item.lastActiveAt) : 'Never')}</dl></div>
    ${item.id !== current?.id ? `<button class="btn quiet danger" type="button" aria-label="Revoke ${esc(item.device)} session" ${UIAction('revokeSession', item.id)}>Revoke</button>` : ''}</div>`).join('');
  const appRows = grants.map(item => `<div class="access-session-row" data-grant-id="${esc(item.id)}"><div class="access-session-main">
    <div class="access-session-title">${esc(item.clientName)}<span class="access-client-type">${esc(item.protocol)}</span></div>
    <div class="app-access-scopes">${(item.access || []).map(grant => `<div><span class="access-project">${esc(visibleProjects().find(p=>p.id===grant.projectId)?.name || 'Unavailable project')}</span><span>${esc(grant.permissions.map(permission=>permissions[permission] || permission).join(' · '))}</span></div>`).join('')}</div>
    <dl class="access-session-facts">${fact('Last used',item.lastUsedAt ? date(item.lastUsedAt) : 'Never')}${fact('Connected',date(item.authorizedAt))}${fact('Expires',item.expiresAt ? date(item.expiresAt) : 'No expiry')}</dl>
    </div><button type="button" class="btn quiet danger" aria-label="Revoke ${esc(item.clientName)} access" ${UIAction('revokeAppAccess', item.id)}>Revoke</button></div>`).join('');
  return `<section class="section"><div class="access-section-heading"><h2 tabindex="-1">Sessions</h2><button type="button" class="btn quiet danger" ${UIAction('revokeOtherSessions')} ${sessions.some(item=>item.id!==current?.id) ? '' : 'disabled'}>Sign out other sessions</button></div><div class="access-session-list">${sessionRows || '<div class="access-empty">No active sessions</div>'}</div></section>
    <section class="section"><h2 tabindex="-1">Connected apps</h2><div class="access-session-list">${appRows || '<div class="access-empty">No connected apps</div>'}</div></section>`;
}
function refreshProfileAccess(status = {}) {
  const host = document.querySelector('.profile-access');
  if (!host) return;
  const hadFocus = host.contains(document.activeElement);
  const before=host.getBoundingClientRect().height;
  setHTML(host,renderProfileAccess() + (status.loading ? '<p class="access-note" role="status">Loading access…</p>' : status.error ? `<p class="access-note" role="alert">${esc(status.error)} <button type="button" class="btn quiet" ${UIAction('retryProfileAccess')}>Retry</button></p>` : ''));
  UIMotion.fade(host);UIMotion.height(host,before);
  if (hadFocus) (host.querySelector('button:not(:disabled)') || host.querySelector('h2'))?.focus({preventScroll:true});
}

/** The Profile page: avatar, name, password, sessions and connected apps. */
export function renderProfile() {
  const u = me();
  return `<div class="settings">
    <div class="section">
      <div class="avatar-row">
        ${avatarHtml(u.id, 56)}
        <div class="avatar-actions">
          <input type="file" id="avIn" accept="image/*" hidden ${UIAction.on('change', 'setAvatar', UIAction.element)}>
          <button class="btn" ${UIAction('chooseAvatar')}>${u.avatar ? 'Change avatar' : 'Upload avatar'}</button>
          ${u.avatar ? `<button class="btn" ${UIAction('removeAvatar')}>Remove</button>` : ''}
        </div>
      </div>
      ${field('Username', `<input class="ctl mono" value="${esc(userHandle(u))}" disabled>`)}
      ${field('Full name', `<input class="ctl" name="name" value="${esc(u.name)}" maxlength="80" data-autosave ${UIAction.on('blur', 'updMe', UIAction.value)} data-key="Enter" ${UIAction.on('keydown', 'leaveField', UIAction.event, UIAction.element)}>`)}
    </div>
    <div class="section">
      <h2>Password</h2>
      <form novalidate ${UIAction.on('submit', 'changePassword', UIAction.event)}>
        ${field('Current password', `<input class="ctl" type="password" name="cur" autocomplete="current-password">`)}
        <div class="field-row">
          ${field('New password', `<input class="ctl" type="password" name="pw" autocomplete="new-password">`)}
          ${field('Confirm', `<input class="ctl" type="password" name="pw2" autocomplete="new-password">`)}
        </div>
        <div class="modal-actions start"><button class="btn primary" type="submit">Change password</button></div>
      </form>
    </div>
    <div class="profile-access">${renderProfileAccess()}</div>
  </div>`;
}

let memberWindow = {projectId:null, query:'', limit:100};
/** A project's Settings page: its name and prefix, who can access it, Knowledge, and deleting it. */
export function renderSettings() {
  const p = project();
  if(memberWindow.projectId!==p.id)memberWindow={projectId:p.id,query:'',limit:100};
  const members = (p.members || []).map((record) => ({ record, user: userById(record.userId) })).filter((x) => x.user);
  const memberIds = new Set((p.members || []).map((member) => member.userId));
  const candidates = D.users.filter((u) => u.active && !memberIds.has(u.id));
  const query=memberWindow.query.toLowerCase();
  const matching=members.filter(({user})=>!query||`${user.name} ${userHandle(user)}`.toLowerCase().includes(query));
  return `<div class="settings settings-wide">
    <div class="section">
      <h2>Project</h2>
      <div class="project-fields">
        <div class="field-row">
          ${field('Name', `<input class="ctl" name="name" value="${esc(p.name)}" maxlength="60" data-autosave ${UIAction.on('blur', 'updateProjectField', UIAction.element)} data-key="Enter" ${UIAction.on('keydown', 'leaveProjectField', UIAction.event, UIAction.element)}>`)}
          <div class="prefix-field">${field('Task prefix', `<input class="ctl mono" name="key" value="${esc(p.key)}" maxlength="4" data-autosave ${UIAction.on('blur', 'updateProjectField', UIAction.element)} data-key="Enter" ${UIAction.on('keydown', 'leaveProjectField', UIAction.event, UIAction.element)}>`)}</div>
        </div>
      </div>
    </div>
    <div class="section">
      <h2>Project access <span class="mono subtle">${members.length}</span></h2>
      <input id="member-search" class="ctl" type="search" aria-label="Search project members" placeholder="Search members" value="${esc(memberWindow.query)}" ${UIAction.on('input', 'searchMembers', UIAction.value)}>
      <div class="member-access-list" aria-busy="${esc(!!D.adminUsers?.loading)}">
        ${matching.slice(0,memberWindow.limit).map(({ user: u, record: m }) => `
          <div class="member-access-row ${u.active ? '' : 'off'}">
            <div class="member-person">${avatarHtml(u.id, 24)}<span><b data-tip="${esc(u.name)}" data-tip-overflow>${esc(u.name)}</b><small class="mono">${esc(userHandle(u))}</small></span>${u.active ? '' : '<span class="tag-off">deactivated</span>'}</div>
            <div class="member-grants">
              ${u.admin ? '<span class="admin-access">Full access</span>' : `
                <label class="permission-check"><input type="checkbox" data-autosave aria-label="${esc(u.name)}: manage Roadmap" ${(m.permissions || []).includes('manage_roadmap') ? 'checked' : ''} ${UIAction.on('change', 'setMemberPermission', u.id, 'manage_roadmap', UIAction.checked, UIAction.element)}><span><b>Roadmap</b></span></label>
                <label class="permission-check"><input type="checkbox" data-autosave aria-label="${esc(u.name)}: manage Board" ${(m.permissions || []).includes('manage_board') ? 'checked' : ''} ${UIAction.on('change', 'setMemberPermission', u.id, 'manage_board', UIAction.checked, UIAction.element)}><span><b>Board</b></span></label>`}
            </div>
            <button class="row-x icon-button" type="button" title="Remove from project" aria-label="Remove ${esc(u.name)} from project" ${UIAction('removeMember', u.id)}>${I.close}</button>
          </div>`).join('') || `<div class="empty-note inline">${query?'No matching members':'No members yet'}</div>`}
      </div>
      ${matching.length>memberWindow.limit?`<button type="button" class="btn quiet" ${UIAction('showMoreMembers')}>Load more members</button>`:''}
      <div class="add-member">${D.adminUsers?.loading&&!D.adminUsers?.loaded ? '<span class="access-note" role="status">Loading users…</span>' : candidates.length
        ? selectHtml('addMember', { label:'Add member', value: '', placeholder: 'Add member…', search: true, options: candidates.map((u) => ({ v: u.id, l: `${u.name} · ${userHandle(u)}` })), pick: (v) => App.addMember(v) })
        : D.adminUsers?.nextCursor ? '' : '<div class="mono subtle">No users to add</div>'}</div>
      ${D.adminUsers?.nextCursor ? `<button type="button" class="btn quiet" data-more-users ${UIAction('loadMoreUsers')} ${D.adminUsers.loading?'disabled':''}>Load more users</button>` : ''}
      ${D.adminUsers?.error ? `<p class="access-note" role="alert">${esc(D.adminUsers.error)} <button type="button" class="btn quiet" ${UIAction('retryUsers')}>Retry</button></p>` : ''}
    </div>
    ${knowledge.settingsHtml(p.id)}
    <div class="section danger-zone">
      <h2>Danger zone</h2>
      <button class="btn danger" ${UIAction('deleteProject')}>Delete project</button>
    </div>
  </div>`;
}

function usersCountLabel() {
  if(!D.adminUsers?.loaded)return D.adminUsers?.loading?'…':'';
  // While more pages wait on the server, the loaded count is only a lower bound.
  return `${D.adminUsers.ids.length}${D.adminUsers.nextCursor?'+':''}`;
}
/** The Users page. */
export function renderUsers() {
  const awaiting = D.adminUsers?.loading && !D.adminUsers.loaded;
  const listed=awaiting?[]:D.adminUsers?.loaded?D.adminUsers.ids.map(userById).filter(Boolean):D.users.slice(0,state.usersLimit);
  const hasMore=D.adminUsers?.loaded?!!D.adminUsers.nextCursor:D.users.length>state.usersLimit;
  return `<div class="settings">
    <div class="section">
      ${awaiting ? '<p class="access-note" role="status">Loading users…</p>' : D.adminUsers?.error ? `<p class="access-note" role="alert">${esc(D.adminUsers.error)} <button type="button" class="btn quiet" ${UIAction('retryUsers')}>Retry</button></p>` : ''}
      ${listed.map((u) => `
        <button type="button" class="user-row clickable ${u.active ? '' : 'off'}" data-user-id="${esc(u.id)}" ${UIAction('openModal', 'user', u.id)}>${avatarHtml(u.id, 22)}
          <span class="uname">${esc(u.name)}</span><span class="mono subtle">${esc(userHandle(u))}</span>
          ${u.active ? '' : '<span class="tag-off">deactivated</span>'}
          ${u.mustChange ? '<span class="tag-off warn">temporary password</span>' : ''}</button>`).join('')}${!awaiting && hasMore ? `<button class="btn quiet" ${UIAction('loadMoreUsers')}>Load more users</button>` : ''}
    </div>
  </div>`;
}

/** The top bar of Profile, Users and Settings. */
export function accountTopbarHtml() {
  if (state.view === 'profile') return `<h1>Profile</h1><span class="meta">${esc(userHandle(me()))}</span>`;
  if (state.view === 'users') return `<h1>Users</h1><span class="meta users-count">${usersCountLabel()}</span><div class="right"><button class="btn primary" ${UIAction('openModal', 'user')}>${I.plus} New user</button></div>`;
  return `<h1>Settings</h1><span class="meta" data-tip="${esc(project().name)}" data-tip-overflow>${esc(project().name)}</span>`;
}

Object.assign(App, {
  refreshProfileAccess,
  refreshUsers({loadingOnly=false}={}) {
    if (loadingOnly) {
      document.querySelector(state.view==='settings'?'.member-access-list':'.content .settings')?.setAttribute('aria-busy', String(!!D.adminUsers?.loading));
      document.querySelectorAll('[data-more-users]').forEach(button=>button.disabled=!!D.adminUsers?.loading);
      return;
    }
    if (state.view === 'settings') {
      const settings = document.querySelector('.settings-wide');
      const section = settings?.querySelectorAll(':scope > .section')[1];
      if (!section) return;
      const focus = section.contains(document.activeElement) ? rememberOpener(document.activeElement) : null;
      closePop(true);
      const template = document.createElement('template'); setHTML(template,renderSettings());
      section.replaceWith(template.content.querySelectorAll('.section')[1]);
      if (focus) restoreOpener(focus);
      return;
    }
    if (state.view !== 'users') return;
    const content = document.querySelector('.content'), count = document.querySelector('.users-count');
    if (!content) return;
    const scroll = content.scrollTop, focus = document.activeElement, userId = focus?.matches?.('.user-row') ? focus.dataset.userId : null;
    setHTML(content,renderUsers()); content.scrollTop = scroll;
    if (count) count.textContent = usersCountLabel();
    if (userId) [...content.querySelectorAll('.user-row')].find(el => el.dataset.userId === userId)?.focus({preventScroll:true});
  },
  acceptMoreUsers() { if(state.view==='settings'){App.refreshUsers();return;}state.usersLimit+=50;App.refresh(); },
  chooseAvatar() { document.getElementById('avIn')?.click(); },
  /** Show the project members whose name or username has `query`. */
  searchMembers(query) { memberWindow.query=query;memberWindow.limit=100;App.refreshUsers(); },
  showMoreMembers() { memberWindow.limit+=100;App.refreshUsers(); },
});
