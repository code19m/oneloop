// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* The Pool dialog: personal and team items, their descriptions, and creating
   a task from an item. */

import { patchBoardRow } from './board.js';
import { optionalMark } from './controls.js';
import { I, UIAction, esc, setHTML } from './format.js';
import { mountDescription, taskModalHtml } from './forms.js';
import { App, D, canBoard, me, poolItems, report, runtime, state } from './model.js';
import { closePop, stampOverlays } from './overlays.js';

function poolRowHtml(p) {
  const writable=p.scope==='mine'?p.ownerId===me()?.id:canBoard();
  return `<div class="pool-row${canBoard()?' promotable':''}" data-pool-item="${esc(p.id)}"><div class="pool-item-main"><div class="pool-item-copy">${canBoard()?`<button type="button" class="txt pool-promote" aria-label="Create task from ${esc(p.title)}" data-tip="${esc(p.title)}" data-tip-overflow ${UIAction('promotePool',p.id)}>${esc(p.title)}</button>`:`<span class="txt">${esc(p.title)}</span>`}${p.desc?`<span class="pool-description-preview">${esc(p.desc)}</span>`:''}</div><span class="act">${writable||p.desc?`<button type="button" class="btn icon pool-note-toggle" aria-label="${writable?p.desc?'Edit description':'Add description':'View description'} for ${esc(p.title)}" title="${writable?p.desc?'Edit description':'Add description':'View description'}" aria-expanded="false" ${UIAction('editPoolDescription',UIAction.event,p.id)}>${I.note}</button>`:''}${canBoard()?`<button type="button" class="btn icon pool-promote-action" aria-label="Create task from ${esc(p.title)}" title="Create task" ${UIAction('promotePool',p.id)}>${I.arrow}</button>`:''}${writable?`<button type="button" class="btn icon pool-delete" aria-label="Delete ${esc(p.title)}" title="Delete item" ${UIAction('delPool',UIAction.event,p.id)}>${I.close}</button>`:''}</span></div></div>`;
}

function resetPoolCapture(){const capture=document.querySelector('.pool-capture');if(!capture)return;capture.classList.remove('is-expanded');const notes=capture.querySelector('#poolNewDesc');notes.value='';const content=capture.querySelector('.pool-capture-notes');content.inert=true;content.setAttribute('aria-hidden','true');const toggle=capture.querySelector('.pool-capture-toggle');toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Add description');toggle.title='Add description';setHTML(toggle,I.note);}

function poolReadNotice(empty=false) {
  const page=D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`];
  if(page?.error)return `<div class="pool-read-status access-note" role="alert">Could not ${page.loaded?'refresh':'load'} items. <button class="btn quiet" ${UIAction('retryPool')}>Retry</button></div>`;
  if(!empty)return '';
  const pending=page?.loaded===false;
  return `<div class="empty-note"${pending?' role="status"':''}>${pending?'Loading items…':'No items'}</div>`;
}

function poolLoadMoreHtml() {
  return D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`]?.nextCursor?`<button class="btn quiet pool-load-more" ${UIAction('loadMorePool')}>Load more</button>`:'';
}

function updatePool({ completeItemId } = {}) {
  App.updateDocumentTitle();
  const view = document.querySelector('.pool-view');
  if (!view) return;
  const list = view.querySelector('.pool-list');
  const listScroll = list.scrollTop;
  const tabChanged = list.dataset.poolScope && list.dataset.poolScope !== state.poolTab;
  const beforeRows = UIMotion.rows(list, '[data-pool-item]', 'data-pool-item');
  const items = poolItems(state.poolTab);
  const ids = new Set(items.map((item) => item.id));
  list.querySelectorAll('[data-pool-item]').forEach((row) => { if (!ids.has(row.dataset.poolItem)) { if (!tabChanged) UIMotion.exit(row); row.remove(); } });
  list.querySelector('.empty-note')?.remove();
  list.querySelector('.pool-read-status')?.remove();
  let cursor = list.firstElementChild;
  items.forEach((item) => {
    let row = list.querySelector(`[data-pool-item="${esc(item.id)}"]`);
    if (row) {
      const editor=row.querySelector('.pool-description-editor');
      const editedHere = !!editor?.contains(document.activeElement);
      const template = document.createElement('template'); setHTML(template,poolRowHtml(item));
      const fresh = template.content.firstElementChild;
      const actions=element=>[...element.querySelectorAll('.act > button')].map(button=>button.className).join('|');
      const sameActions=row.className===fresh.className&&actions(row)===actions(fresh);
      row.className=fresh.className;
      if(sameActions)patchBoardRow(row.querySelector('.pool-item-main'),fresh.querySelector('.pool-item-main'));
      else row.querySelector('.pool-item-main')?.replaceWith(fresh.querySelector('.pool-item-main'));
      if(item.id===completeItemId){editor?.remove();if(editedHere)row.querySelector('.pool-note-toggle')?.focus({preventScroll:true});}
      else if(editor){
        row.querySelector('.pool-note-toggle')?.setAttribute('aria-expanded','true');
        const reader=editor.querySelector('.pool-note-read');if(reader){reader.textContent=item.desc||'';reader.setAttribute('aria-label',`Description for ${item.title}`);}
      }
    }
    if (!row) { const template = document.createElement('template'); setHTML(template,poolRowHtml(item)); row = template.content.firstElementChild; }
    if (row !== cursor) list.insertBefore(row, cursor);
    cursor = row.nextElementSibling;
  });
  if (!items.length) setHTML(list,poolReadNotice(true));
  else if(D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`]?.error){const note=document.createElement('template');setHTML(note,poolReadNotice());list.append(note.content);}
  list.querySelector('.pool-load-more')?.remove();
  const more=document.createElement('template');setHTML(more,poolLoadMoreHtml());list.append(more.content);
  view.querySelectorAll('[data-pool-tab]').forEach((button) => {
    const selected = button.dataset.poolTab === state.poolTab;
    button.classList.toggle('on', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.querySelector('span').textContent = D.poolPageInfo?.[`${state.projectId}:${button.dataset.poolTab}`]?.total ?? poolItems(button.dataset.poolTab).length;
  });
  const input = view.querySelector('#poolAdd');
  input.hidden = state.poolTab === 'project' && !canBoard();
  view.querySelector('.pool-capture').hidden=input.hidden;
  if(tabChanged){input.value='';resetPoolCapture();view.querySelectorAll('.pool-description-editor').forEach(el=>el.remove());view.querySelectorAll('.pool-note-toggle').forEach(el=>el.setAttribute('aria-expanded','false'));}
  const mineTotal=D.poolPageInfo?.[`${state.projectId}:mine`]?.total,teamTotal=D.poolPageInfo?.[`${state.projectId}:project`]?.total;
  document.querySelectorAll('[data-pool-count]').forEach((el) => { el.textContent = Number.isFinite(mineTotal)&&Number.isFinite(teamTotal)?mineTotal+teamTotal:poolItems().length; });
  list.dataset.poolScope = state.poolTab;
  if (!tabChanged) list.scrollTop = listScroll;
  if (tabChanged) UIMotion.fade(list);
  else UIMotion.reflow(list, '[data-pool-item]', 'data-pool-item', beforeRows);
}

/** The Pool dialog: its tabs, the capture field and the item list. */
export function poolViewHtml() {
  const mine = poolItems('mine'), proj = poolItems('project');
  const pl = state.poolTab === 'mine' ? mine : proj;
  const canWritePool = state.poolTab === 'mine' || canBoard();
  const rows = pl.length?pl.map(poolRowHtml).join('')+poolReadNotice():poolReadNotice(true);
  return `<div class="pool-view"><div class="pool-head"><h2>Pool</h2>
    <div class="seg">
      <button type="button" class="${state.poolTab === 'mine' ? 'on' : ''}" data-pool-tab="mine" aria-pressed="${state.poolTab === 'mine'}" ${UIAction('setPoolTab', 'mine')}>My <span class="mono tab-count">${D.poolPageInfo?.[`${state.projectId}:mine`]?.total ?? mine.length}</span></button>
      <button type="button" class="${state.poolTab === 'project' ? 'on' : ''}" data-pool-tab="project" aria-pressed="${state.poolTab === 'project'}" ${UIAction('setPoolTab', 'project')}>Team <span class="mono tab-count">${D.poolPageInfo?.[`${state.projectId}:project`]?.total ?? proj.length}</span></button>
    </div>
    <button type="button" class="btn icon" aria-label="Close pool" title="Close pool" ${UIAction('closeOverlays')}>${I.close}</button>
  </div>
  <div class="pool-capture" ${canWritePool?'':'hidden'}><div class="pool-capture-title"><input id="poolAdd" class="ctl" placeholder="Add an item" aria-label="Add pool item" maxlength="140" ${canWritePool?'':'hidden'} ${UIAction.on('keydown', 'poolKey', UIAction.event)}><button type="button" class="btn icon pool-capture-toggle" aria-label="Add description" title="Add description" aria-expanded="false" aria-controls="pool-capture-notes" ${UIAction('togglePoolDescription')}>${I.note}</button></div><div class="pool-capture-notes" id="pool-capture-notes" aria-hidden="true" inert><div><label for="poolNewDesc">Description ${optionalMark}</label><textarea id="poolNewDesc" class="ctl" maxlength="2000" placeholder="A little context for later…" ${UIAction.on('keydown', 'poolDescriptionKey', UIAction.event)}></textarea><div class="pool-description-actions"><button type="button" class="btn primary" ${UIAction('addPoolItem')}>Add item</button></div></div></div></div>
  <div class="pool-list" data-pool-scope="${esc(state.poolTab)}">${rows}${poolLoadMoreHtml()}</div></div>`;
}

Object.assign(App, {
  refreshPool: updatePool,

  togglePoolDescription(){const capture=document.querySelector('.pool-capture');if(!capture||capture.hidden)return;const open=!capture.classList.contains('is-expanded');if(!open){resetPoolCapture();document.getElementById('poolAdd').focus();return;}capture.classList.add('is-expanded');const content=capture.querySelector('.pool-capture-notes');content.inert=false;content.setAttribute('aria-hidden','false');const toggle=capture.querySelector('.pool-capture-toggle');toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-label','Remove description');toggle.title='Remove description';setHTML(toggle,I.close);document.getElementById('poolNewDesc').focus();},
  addPoolItem(){const input=document.getElementById('poolAdd');if(input&&!input.hidden)App.poolKey({key:'Enter',target:input,preventDefault(){}});},
  poolDescriptionKey(ev,id){
    if(ev.defaultPrevented||ev.isComposing||ev.keyCode===229)return;
    if(ev.key==='Enter'&&ev.repeat){ev.preventDefault();return;}
    if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();if(id)App.cancelPoolDescription(id);else {resetPoolCapture();document.getElementById('poolAdd').focus();}return;}
    if(ev.key==='Enter'&&!ev.shiftKey&&!ev.altKey){ev.preventDefault();if(id){const form=ev.currentTarget.closest('form');if(form)App.savePoolDescription({target:form,preventDefault(){}},id);}else App.addPoolItem();}
  },
  editPoolDescription(ev,id){ev.stopPropagation();const item=poolItems(state.poolTab).find(p=>p.id===id),row=ev.currentTarget.closest('[data-pool-item]');if(!item||!row)return;const existing=row.querySelector('.pool-description-editor');if(existing){App.cancelPoolDescription(id);return;}document.querySelectorAll('.pool-description-editor').forEach(el=>App.cancelPoolDescription(el.closest('[data-pool-item]').dataset.poolItem,false));const writable=item.scope==='mine'?item.ownerId===me()?.id:canBoard(),editor=document.createElement('div');editor.className='pool-description-editor';const before=row.getBoundingClientRect().height;setHTML(editor,writable?`<form novalidate ${UIAction.on('submit','savePoolDescription',UIAction.event,id)}><label for="pool-desc-${esc(id)}">Description ${optionalMark}</label><textarea class="ctl" id="pool-desc-${esc(id)}" name="desc" maxlength="2000" ${UIAction.on('keydown','poolDescriptionKey',UIAction.event,id)} placeholder="A little context for later…">${esc(item.desc||'')}</textarea><div class="pool-description-actions"><button type="button" class="btn quiet" ${UIAction('cancelPoolDescription',id)}>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`:`<div class="pool-note-read" tabindex="-1" role="group" aria-label="Description for ${esc(item.title)}">${esc(item.desc||'')}</div>`);row.append(editor);const reader=editor.querySelector('.pool-note-read');if(reader&&reader.scrollHeight>reader.clientHeight)reader.setAttribute('tabindex','0');ev.currentTarget.setAttribute('aria-expanded','true');UIMotion.height(row,before);editor.querySelector('textarea,.pool-note-read')?.focus({preventScroll:true});},
  cancelPoolDescription(id,focus=true){const row=document.querySelector(`[data-pool-item="${esc(id)}"]`);if(!row)return;const before=row.getBoundingClientRect().height;row.querySelector('.pool-description-editor')?.remove();const toggle=row.querySelector('.pool-note-toggle');toggle?.setAttribute('aria-expanded','false');UIMotion.height(row,before);if(focus)toggle?.focus({preventScroll:true});},
  promotePool(id) {
    if (!App.require('manage_board')) return;
    const item = poolItems(state.poolTab).find((x) => x.id === id);
    const view = document.querySelector('.pool-view');
    if (!item || !view) return;
    (App._poolScroll ||= {})[state.poolTab] = view.querySelector('.pool-list').scrollTop;
    document.querySelectorAll('.pool-description-editor').forEach(el=>App.cancelPoolDescription(el.closest('[data-pool-item]').dataset.poolItem,false));resetPoolCapture();document.getElementById('poolAdd').value='';
    state.modal = { type: 'task', poolId: id, title: item.title, desc:item.desc||'' };
    stampOverlays();
    view.hidden = true;
    const editor = document.createElement('div');
    editor.className = 'pool-editor';
    setHTML(editor,taskModalHtml(state.modal));
    view.parentElement.appendChild(editor);
    mountDescription();
    UIMotion.fade(editor);
    editor.querySelector('[name="title"]').focus();
  },
  returnToPool() {
    closePop(true);
    document.querySelector('.pool-editor')?.remove();
    const view = document.querySelector('.pool-view');
    if (!view) return;
    state.modal = { type: 'pool' };
    stampOverlays();
    view.hidden = false;
    updatePool();
    view.querySelector('.pool-list').scrollTop = App._poolScroll?.[state.poolTab] || 0;
    UIMotion.fade(view);
    view.querySelector('#poolAdd')?.focus();
  },
  setPoolTab(k) {
    if (!['mine', 'project'].includes(k) || k === state.poolTab) return;
    const list = document.querySelector('.pool-list');
    (App._poolScroll ||= {})[state.poolTab] = list.scrollTop;
    state.poolTab = k;
    updatePool();
    list.scrollTop = App._poolScroll[k] || 0;
    runtime().selectPool(k).catch(report);
  },
  loadMorePool(){runtime().loadMorePool(state.poolTab).catch(report);},
  retryPool(){runtime().selectPool(state.poolTab).catch(report);},
});
