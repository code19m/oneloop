// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* Form parts that several pages and dialogs share: descriptions that grow
   with their text and show their Markdown, and the New task form. */

import { UIMotion } from '../../src/app/motion.js';
import { markdownInto } from '../../src/features/files/file-views.js';
import { dateHtml, field, multiHtml, selectHtml, setSelectValue } from './controls.js';
import { I, UIAction, d, esc, setHTML } from './format.js';
import {
  App, canRoadmap, epicById, epics, projectMembers, runtime, state, tracks, userById, userHandle, visibleProjects,
} from './model.js';

// ---------- descriptions ----------
const expandedDescriptions = new Set();
let descriptionObserver,descriptionResizeFrame=0;
// What each description reader showed, by the reader, its text and the
// projects whose task keys it links, kept from one drawing of the page to the
// next: the page shows it again at once, and its diagrams and images stay.
let shownMarkdown=new Map();
const mountedReaders=new WeakSet();

/** Show the Markdown of each description reader, `[data-markdown]`, which holds its text until the renderer is there. */
function mountReaders(){
  const prefixes=new Set(visibleProjects().flatMap(project=>[project.key,...project.earlierPrefixes])),scope=[...prefixes].sort().join(),kept=shownMarkdown;
  // A line break in the text is a line break, as in descriptions written before they showed as Markdown.
  // Task keys of the projects the person can see become links, with any prefix a project had; others stay text.
  const context={breaks:true,taskLink:key=>prefixes.has(key.slice(0,key.indexOf('-')))?'#/task/'+encodeURIComponent(key):null};
  shownMarkdown=new Map();
  for(const reader of document.querySelectorAll('.description-content[data-markdown]')){
    const text=reader.getAttribute('data-markdown'),key=`${reader.id}\n${scope}\n${text}`;
    if(!mountedReaders.has(reader)){
      mountedReaders.add(reader);
      const article=kept.get(key);
      if(article)reader.replaceChildren(article);
      else markdownInto(reader,text,context,()=>{shownMarkdown.set(key,reader.firstElementChild);sizeDescription();});
    }
    const article=reader.querySelector(':scope > .markdown-body');if(article)shownMarkdown.set(key,article);
  }
}

export function sizeDescription(animated = false) {
  document.querySelectorAll('.expandable-description').forEach(section=>{
    const input=section.querySelector('.description-content, textarea'),toggle=section.querySelector('.description-toggle');
    const before=input.getBoundingClientRect().height,scrollTop=input.scrollTop;
    UIMotion.cancel(input);
    const expanded=expandedDescriptions.has(section.dataset.descriptionKey);
    input.style.overflowY='hidden';input.style.height='0px';
    // The height holds the text and the box's own border.
    const fullHeight=Math.max(input.tagName==='TEXTAREA'?96:0,input.scrollHeight+input.offsetHeight-input.clientHeight);
    const expandedLimit=Math.max(240,Math.round(innerHeight*.8));
    input.style.height=Math.min(fullHeight,expanded?expandedLimit:240)+'px';
    input.style.overflowY=expanded?'auto':'hidden';input.scrollTop=expanded?scrollTop:0;
    toggle.hidden=fullHeight<=240;section.classList.toggle('is-collapsed',fullHeight>240&&!expanded);
    toggle.textContent=expanded?'Show less':'Show more';toggle.setAttribute('aria-expanded',String(expanded));
    if(input.tagName!=='TEXTAREA'){if(fullHeight>240&&(!expanded||fullHeight>expandedLimit))input.setAttribute('tabindex','0');else input.removeAttribute('tabindex');}
    if(animated)UIMotion.height(input,before);
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
  return `<section class="peek-description expandable-description" data-description-key="${esc(key)}"><h3>Description</h3><div class="description-preview"><div class="description-content" id="${esc(key)}" role="group" aria-label="Epic description" data-markdown="${esc(value)}">${esc(value)}</div></div><button type="button" class="description-toggle" aria-controls="${esc(key)}" aria-expanded="false" ${UIAction('toggleDescription', UIAction.element)} hidden>Show more</button></section>`;
}

export function sizeTaskTitle() {
  const input = document.querySelector('.tp-title');
  if (!input) return;
  input.style.height = '0px';
  input.style.height = (input.scrollHeight + 1) + 'px';
}

export function mountDescription() {
  cancelAnimationFrame(descriptionResizeFrame);descriptionResizeFrame=0;
  mountReaders();sizeTaskTitle();descriptionObserver?.disconnect();sizeDescription();sizeDescriptionEditors();
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
/**
 * What an Epic select offers a task on `trackId`: No epic, then the open
 * epics on that track, and `current`, the task's own epic, even when it is
 * done, in start order. Without a track, every open epic, named with its track.
 */
export function epicOptions(trackId, current = null) {
  const open = epics().filter((e) => e.state !== 'done' || e.id === current).sort((a, b) => d(a.start) - d(b.start));
  const choices = trackId ? open.filter((e) => e.trackId === trackId).map((e) => ({ v: e.id, l: e.title }))
    : tracks().flatMap((t) => open.filter((e) => e.trackId === t.id).map((e) => ({ v: e.id, l: `${e.title} · ${t.name}` })));
  return [{ v: '', l: 'No epic' }, ...choices];
}

/**
 * The track a new task starts on: the one chosen in the form, else its
 * epic's, else the project's only track, else the Board's one chosen track,
 * else the track of the last task created in this project in this tab; else
 * none, and the person chooses.
 */
function startTrack(m) {
  const all = tracks(), known = (id) => all.some((t) => t.id === id) ? id : null;
  return known(m.trackId) || known(epicById(m.epicId)?.trackId) || (all.length === 1 ? all[0].id : null)
    || (state.boardTracks.length === 1 ? known(state.boardTracks[0]) : null) || known(runtime().lastTaskTrack(state.projectId)) || '';
}
/** Another track keeps the chosen epic only when the epic is on it. */
function chooseTaskTrack(m, trackId) {
  m.trackId = trackId;
  if (epicById(m.epicId)?.trackId !== trackId) m.epicId = '';
  setSelectValue('mEpic', m.epicId, epicOptions(trackId));
}
/** An epic puts the task on its track. */
function chooseTaskEpic(m, epicId) {
  m.epicId = epicId;
  const trackId = epicById(epicId)?.trackId;
  if (!trackId || trackId === m.trackId) return;
  m.trackId = trackId;
  setSelectValue('mTaskTrack', trackId);
  setSelectValue('mEpic', epicId, epicOptions(trackId));
}

function taskAssigneesHtml(m){
  m.assignees ||= [];
  const sync=()=>{const host=document.querySelector('.task-form-assignee-values');if(host)setHTML(host,m.assignees.map(id=>`<input type="hidden" name="assignees" value="${esc(id)}">`).join(''));};
  const select=multiHtml('mTaskAssignees',{label:'Assignees',search:true,icon:()=>I.person,options:projectMembers().map(u=>({v:u.id,l:u.name,sub:userHandle(u)})),values:()=>m.assignees,
    toggle:id=>{const index=m.assignees.indexOf(id);if(index<0)m.assignees.push(id);else m.assignees.splice(index,1);sync();},clear:()=>{m.assignees=[];sync();},summary:()=>m.assignees.length?m.assignees.map(id=>userById(id)?.name||id).join(', '):'Unassigned'});
  return `${select}<div class="task-form-assignee-values">${m.assignees.map(id=>`<input type="hidden" name="assignees" value="${esc(id)}">`).join('')}</div>`;
}

export function taskModalHtml(m) {
  if (!tracks().length) return `<h2>New task</h2><div class="sub">${canRoadmap() ? 'Every task goes on a track. Create one first.' : 'Every task goes on a track, and this project has none yet. Ask someone who can change the Roadmap to create one.'}</div><div class="modal-actions"><button class="btn quiet" ${UIAction('closeOverlays')}>Cancel</button>${canRoadmap() ? `<button class="btn primary" ${UIAction('openModal', 'track')}>Create track</button>` : ''}</div>`;
  m.trackId = startTrack(m);
  const epic = epicById(m.epicId);
  m.epicId = epic && epic.state !== 'done' && epic.trackId === m.trackId ? epic.id : '';
  return `<h2>New task</h2>
    <form novalidate data-save-shortcut ${UIAction.on('submit', 'saveTask', UIAction.event)}>
      ${field('Title', `<input class="ctl" name="title" placeholder="Fix payment validation" value="${esc(m.title || '')}" maxlength="140" required autofocus>`)}
      <div class="field-row">
        ${field('Track', selectHtml('mTaskTrack', { name: 'trackId', value: m.trackId, placeholder: 'Choose a track', icon: I.track, options: tracks().map((t) => ({ v: t.id, l: t.name })), pick: (v) => chooseTaskTrack(m, v) }))}
        ${field('Epic', selectHtml('mEpic', { name: 'epicId', value: m.epicId, icon: I.roadmap, search: true, options: epicOptions(m.trackId), pick: (v) => chooseTaskEpic(m, v) }), true)}
      </div>
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
