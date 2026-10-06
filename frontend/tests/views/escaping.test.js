import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {installViewActions} from '../../src/app/view-actions.js';
import {installViewBridge} from '../../src/app/view-bridge.js';

const {JSDOM,bootApp,settle}=createRequire(import.meta.url)('../support/dom.cjs');

const source=readFileSync(new URL('../../views/motion.js',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('/** Escape'),source.indexOf('window.UIHTML=')),context);
const {UIEscape,UIAction}=context;

test('HTML and action escaping keep hostile values whole without adding attributes or actions',()=>{
  assert.equal(UIEscape(`'"<&>`),'&#39;&quot;&lt;&amp;&gt;');
  const value="opaque'\\\n\r\"<>& data-action=\"logout\" ']",calls=[];
  const dom=new JSDOM(`<button id="b" ${UIAction('openTask',value,UIAction.event)} ${UIAction.on('keydown','epicKey',value)}>Open</button>`);
  const button=dom.window.document.getElementById('b');
  assert.deepEqual(button.getAttributeNames(),['id','data-action','data-args','data-action-keydown','data-args-keydown']);
  assert.deepEqual(JSON.parse(button.dataset.args),[value,{$:'event'}]);
  dom.window.App={openTask:(id,event)=>calls.push([id,event.type]),logout:()=>calls.push('logout')};
  installViewActions(dom.window.document);button.click();
  assert.deepEqual(calls,[[value,'click']]);
});

test('shared templates encode URLs and data attributes',()=>{
  for(const name of ['app','collaboration','uploads']){
    const source=readFileSync(new URL(`../../views/${name}.js`,import.meta.url),'utf8');
    for(const [attribute] of source.matchAll(/\b(?:src|href|data-[\w-]+)="[^"\n]*"/g)){
      for(const [,expression] of attribute.matchAll(/\$\{([^{}]+)\}/g))assert.match(expression,/^(?:UIEscape|esc|escape|html)\(/,`${name}: unescaped attribute ${expression}`);
    }
  }
});

test('user text with markup stays text on every page, dialog, drawer, menu and tooltip',async()=>{
  const evil=text=>`${text}<i class="planted" onclick="App.logout()" data-action="logout">x</i><img class="planted" src="data:,">`;
  const t=bootApp({route:'roadmap',media:()=>true,prepare(D){
    for(const user of D.users)user.name=evil(user.name);
    for(const project of D.projects)project.name=evil(project.name);
    for(const track of D.tracks)track.name=evil(track.name);
    for(const epic of D.epics)Object.assign(epic,{title:evil(epic.title),desc:evil(epic.desc||'')});
    for(const milestone of D.milestones)Object.assign(milestone,{name:evil(milestone.name),desc:evil(milestone.desc||'')});
    for(const item of D.pool)Object.assign(item,{title:evil(item.title),desc:evil(item.desc||'')});
    for(const task of D.tasks){
      Object.assign(task,{title:evil(task.title),desc:evil(task.desc||'')});
      for(const comment of task.comments||[])comment.text=evil(comment.text);
      for(const file of task.attachments||[])file.name=evil(file.name);
    }
    Object.assign(D.tasks.find(task=>task.id==='BIR-064'),{block:{id:'block-1',reason:evil('Waiting'),by:'robin',at:Date.now(),mentions:[]}});
    for(const session of D.browserSessions)Object.assign(session,{device:evil(session.device),browser:evil(session.browser||'Browser'),ip:evil('192.0.2.1')});
    for(const grant of D.appGrants)grant.clientName=evil(grant.clientName);
    // An open task makes removing Robin show Member has open work.
    Object.assign(D.tasks.find(task=>task.id==='BIR-072'),{projectId:'p1'});
  }});
  // The production actions, which add their own dialogs.
  installViewBridge({app:t.A,data:t.D,api:{},reads:{cancel(){},async epic(){return {stale:false};}},gateway:{},auth:{},recovery:{},reloadBootstrap:async()=>({})});
  const planted=[];
  const visit=(label,show)=>{show();for(const element of t.d.querySelectorAll('.planted'))planted.push(`${label}: ${element.outerHTML}`);};
  const cancel=()=>t.d.querySelector('[data-confirm-cancel]')?.click();
  const epic=t.D.epics.find(item=>item.state!=='done'),milestone=t.D.milestones[0];
  visit('roadmap',()=>{});
  visit('epic tooltip',()=>t.A.epicHover({currentTarget:t.d.querySelector(`[data-epic="${epic.id}"]`)},epic.id,true));
  visit('milestone tooltip',()=>t.A.milestoneHover({currentTarget:t.d.querySelector(`[data-milestone="${milestone.id}"]`)},milestone.id,true));
  visit('epic drawer',()=>t.A.openPeek(epic.id));
  visit('epic dialog',()=>t.A.openModal('epic',epic.id));
  visit('milestone dialog',()=>{t.A.closeOverlays();t.A.openModal('milestone',milestone.id);});
  visit('track dialog',()=>{t.A.closeOverlays();t.A.openModal('track',t.D.tracks[0].id);});
  visit('delete milestone',()=>{t.A.closeOverlays();t.A.deleteMilestone(milestone.id);});
  visit('delete epic',()=>{cancel();t.A.deleteEpic(epic.id);});
  visit('delete track',()=>{cancel();t.A.deleteTrack(t.D.tracks[0].id);});
  visit('project menu',()=>{cancel();t.A.projectMenu({currentTarget:t.d.querySelector('.switcher-btn')});});
  visit('board',()=>{t.A.closeOverlays();t.A.nav('board');});
  visit('pool',()=>t.A.openModal('pool'));
  visit('delete Pool item',()=>t.A.delPool(null,t.D.pool.find(item=>item.scope==='project').id));
  visit('task page',()=>{cancel();t.A.closeOverlays();t.A.openTask('BIR-064');});
  visit('block dialog',()=>t.A.openModal('block','BIR-064'));
  visit('unblock dialog',()=>{t.A.closeOverlays();t.A.openModal('unblock','BIR-064');});
  visit('task dialog',()=>{t.A.closeOverlays();t.A.nav('board');t.A.openModal('task');});
  visit('settings',()=>{t.A.closeOverlays();t.A.nav('settings');});
  visit('member has open work',()=>t.A.removeMember('robin'));
  visit('remove permission',()=>{t.A.closeOverlays();t.A.setMemberPermission('robin','manage_board',false);});
  visit('delete project',()=>{cancel();t.A.deleteProject();});
  visit('users',()=>{cancel();t.A.nav('users');});
  visit('user dialog',()=>t.A.openModal('user','robin'));
  visit('profile',()=>{t.A.closeOverlays();t.A.nav('profile');});
  visit('inbox',()=>t.A.nav('inbox'));
  await settle();
  visit('settled',()=>{});
  assert.deepEqual(planted,[]);
  assert.match(t.d.body.textContent,/<i class="planted"/,'the hostile text is still shown as text');
});
