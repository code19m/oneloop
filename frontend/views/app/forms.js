// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* Form parts that several pages and dialogs share: description fields that
   grow with their text, and the New task form. */

import { dateHtml, field, multiHtml, selectHtml } from './controls.js';
import { animateHeight, uiAnimations } from './effects.js';
import { I, UIAction, d, esc, setHTML } from './format.js';
import { App, canRoadmap, epics, projectMembers, userById, userHandle } from './model.js';

// ---------- descriptions ----------
const expandedDescriptions = new Set();
let descriptionObserver,descriptionResizeFrame=0;

export function sizeDescription(animated = false) {
  document.querySelectorAll('.expandable-description').forEach(section=>{
    const input=section.querySelector('.description-content, textarea'),toggle=section.querySelector('.description-toggle');
    const before=input.getBoundingClientRect().height,scrollTop=input.scrollTop;
    uiAnimations.get(input)?.cancel();
    const expanded=expandedDescriptions.has(section.dataset.descriptionKey);
    input.style.overflowY='hidden';input.style.height='0px';
    const fullHeight=Math.max(input.tagName==='TEXTAREA'?96:0,input.scrollHeight+(input.tagName==='TEXTAREA'?2:0));
    const expandedLimit=Math.max(240,Math.round(innerHeight*.8));
    input.style.height=Math.min(fullHeight,expanded?expandedLimit:240)+'px';
    input.style.overflowY=expanded?'auto':'hidden';input.scrollTop=expanded?scrollTop:0;
    toggle.hidden=fullHeight<=240;section.classList.toggle('is-collapsed',fullHeight>240&&!expanded);
    toggle.textContent=expanded?'Show less':'Show more';toggle.setAttribute('aria-expanded',String(expanded));
    if(input.tagName!=='TEXTAREA'){if(fullHeight>240&&(!expanded||fullHeight>expandedLimit))input.setAttribute('tabindex','0');else input.removeAttribute('tabindex');}
    if(animated)animateHeight(input,before);
  });
}

export function sizeDescriptionEditors() {
  document.querySelectorAll('[data-description-editor]').forEach(input=>{
    const scrollTop=input.scrollTop;input.style.overflowY='hidden';input.style.height='0px';
    input.style.height=Math.min(Math.max(96,input.scrollHeight+2),Math.max(96,Math.min(320,Math.round(innerHeight*.4))))+'px';
    input.style.overflowY='auto';input.scrollTop=scrollTop;
  });
}

export function descriptionEditorHtml(value,limit,placeholder) {
  return `<textarea class="ctl description-editor" name="desc" data-description-editor maxlength="${limit}" ${placeholder?`placeholder="${esc(placeholder)}"`:''} ${UIAction.on('input', 'sizeDescriptionEditors')}>${esc(value||'')}</textarea>`;
}

export function descriptionReadHtml(value,key) {
  return `<section class="peek-description expandable-description" data-description-key="${esc(key)}"><h3>Description</h3><div class="description-preview"><div class="description-content" id="${esc(key)}" role="group" aria-label="Epic description">${esc(value)}</div></div><button type="button" class="description-toggle" aria-controls="${esc(key)}" aria-expanded="false" ${UIAction('toggleDescription', UIAction.element)} hidden>Show more</button></section>`;
}

export function sizeTaskTitle() {
  const input = document.querySelector('.tp-title');
  if (!input) return;
  input.style.height = '0px';
  input.style.height = (input.scrollHeight + 1) + 'px';
}

export function mountDescription() {
  cancelAnimationFrame(descriptionResizeFrame);descriptionResizeFrame=0;
  sizeTaskTitle();descriptionObserver?.disconnect();sizeDescription();sizeDescriptionEditors();
  if(typeof ResizeObserver!=='undefined'){
    const widths=new WeakMap();
    descriptionObserver=new ResizeObserver(entries=>{
      let changed=false;for(const {target} of entries){if(widths.get(target)!==target.clientWidth){widths.set(target,target.clientWidth);changed=true;}}
      if(changed){cancelAnimationFrame(descriptionResizeFrame);descriptionResizeFrame=requestAnimationFrame(()=>{descriptionResizeFrame=0;sizeDescription();sizeDescriptionEditors();sizeTaskTitle();});}
    });
    document.querySelectorAll('.expandable-description,[data-description-editor]').forEach(el=>{widths.set(el,el.clientWidth);descriptionObserver.observe(el);});
  }
}

// ---------- New task form ----------
const taskDestinationEpics = () => epics().filter(epic => epic.state !== 'done');

function taskAssigneesHtml(m){
  m.assignees ||= [];
  const sync=()=>{const host=document.querySelector('.task-form-assignee-values');if(host)setHTML(host,m.assignees.map(id=>`<input type="hidden" name="assignees" value="${esc(id)}">`).join(''));};
  const select=multiHtml('mTaskAssignees',{label:'Assignees',search:true,icon:()=>I.person,options:projectMembers().map(u=>({v:u.id,l:u.name,sub:userHandle(u)})),values:()=>m.assignees,
    toggle:id=>{const index=m.assignees.indexOf(id);if(index<0)m.assignees.push(id);else m.assignees.splice(index,1);sync();},clear:()=>{m.assignees=[];sync();},summary:()=>m.assignees.length?m.assignees.map(id=>userById(id)?.name||id).join(', '):'Unassigned'});
  return `${select}<div class="task-form-assignee-values">${m.assignees.map(id=>`<input type="hidden" name="assignees" value="${esc(id)}">`).join('')}</div>`;
}

export function taskModalHtml(m) {
  if(!taskDestinationEpics().length) return `<h2>New task</h2><div class="sub">No open epics are available.</div><div class="modal-actions"><button class="btn quiet" ${UIAction('closeOverlays')}>Cancel</button>${canRoadmap()?`<button class="btn primary" ${UIAction('openModal', 'epic')}>Create epic</button>`:''}</div>`;
  return `<h2>New task</h2>
    <form novalidate ${UIAction.on('submit', 'saveTask', UIAction.event)}>
      ${field('Title', `<input class="ctl" name="title" placeholder="Fix payment validation" value="${esc(m.title || '')}" maxlength="140" required autofocus>`)}
      ${field('Epic', selectHtml('mEpic', { name: 'epicId', value: taskDestinationEpics().some((e) => e.id === m.epicId) ? m.epicId : '', placeholder: 'Choose an epic', options: taskDestinationEpics().slice().sort((a, b) => d(a.start) - d(b.start)).map((e) => ({ v: e.id, l: e.title })) }))}
      <div class="field-row">
        ${field('Assignees',taskAssigneesHtml(m),true)}
        ${field('Deadline',dateHtml('mTaskDeadline',{label:'Deadline',name:'deadline',value:'',clearable:true,placeholder:'Set deadline'}),true)}
      </div>
      ${field('Description', descriptionEditorHtml(m.desc||'',4000,'Scope and acceptance criteria'), true)}
      <div class="modal-actions"><button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">Create task</button></div>
    </form>`;
}

Object.assign(App, {
  sizeDescription,
  sizeDescriptionEditors,
  sizeTaskTitle,
  expandDescription() {
    const section = document.querySelector('.task-description');
    if (section) expandedDescriptions.add(section.dataset.descriptionKey);
    sizeDescription(true);
  },
  toggleDescription(button) {
    const section = button?.closest('.expandable-description') || document.querySelector('.task-description');
    if (!section) return;
    const id = section.dataset.descriptionKey;
    if (expandedDescriptions.has(id)) expandedDescriptions.delete(id);
    else expandedDescriptions.add(id);
    sizeDescription(true);
  },
});
