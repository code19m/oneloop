/* Shared comments and private inbox behavior. */
(() => {
 const D=window.DATA,esc=UIEscape;
 const params=new URLSearchParams(location.search),scenario=params.get('scenario')||'',STORE='oneloop.collaboration.v1'+(scenario?'.'+scenario:'');
 const production=!!window.OneloopTransport;
 const id=prefix=>prefix+'-'+(crypto.randomUUID?.()||Date.now()+'-'+Math.random().toString(36).slice(2));
 const setHTML=UIHTML;
 let app,hooks,productionApi=null,mention=null,pendingTarget=null,storageWarning=false,inboxSampleVersion=0;
 let commentEditor=null,blockEditor=null,editorScope=null,commentMode={mode:'comment',target:null},broadcasts={},expanded=new Set(),expandedCommentBodies=new Set(),commentResizeObserver=null,commentResizeFrame=0,filter={projects:[],archived:false,unread:false,limit:50};
 let inboxMeta={unreadCount:null,filteredCount:null,nextCursor:null,loaded:false,loading:false,error:false},taskPages=new Map(),renderedUserId=null;
 /** @type {{taskId:string,data:string,meta:string}|null} */
 let feedSnapshot=null;
 /** @type {string|null} */
 let mountedTaskId=null;
 const chronological=(a,b)=>Number(a.ts)-Number(b.ts)||String(a.id??'').localeCompare(String(b.id??''));
 /** @typedef {{id:string,name?:string,username?:string,active?:boolean,admin?:boolean,avatar?:string}} Person */
 /** @type {Person[]|null} */
 let usersSource=null;
 /** @type {number|undefined|null} */
 let usersVersion=null;
 let usersCount=-1;
 /** @type {Map<string,Person>} */
 let usersById=new Map();
 /** @param {string} id */
 function userById(id){
  if(usersSource!==D.users||usersVersion!==D.peopleVersion||usersCount!==D.users.length){usersSource=D.users;usersVersion=D.peopleVersion;usersCount=D.users.length;usersById=new Map(D.users.map((/** @type {Person} */ user)=>[user.id,user]));}
  return usersById.get(id);
 }
 const me=()=>userById(D.session?.userId);
 const projectOf=t=>D.projects.find(p=>p.id===(t?.projectId||D.tracks.find(r=>r.id===D.epics.find(e=>e.id===t?.epicId)?.trackId)?.projectId));
 const members=p=>(p?.members||[]).map(m=>userById(typeof m==='string'?m:m.userId)).filter(u=>u?.active);
 const canComment=t=>{const actor=me(),project=projectOf(t);return !!(actor?.active&&project&&(actor.admin||project.members?.some((/** @type {string|{userId:string}} */ member)=>(typeof member==='string'?member:member.userId)===actor.id)));};
 if(!production)try { for(const key of Object.keys(localStorage)) if(key.startsWith('oneloop.collaboration.v1')) { const saved=JSON.parse(localStorage.getItem(key));if(saved&&Object.hasOwn(saved,'drafts')){delete saved.drafts;localStorage.setItem(key,JSON.stringify(saved));} } } catch {}
 D.notifications ||= [];
 function normalize(){for(const t of D.tasks){for(const f of t.attachments||[])delete f.commentId;for(const [i,c] of (t.comments||[]).entries()){c.id ||= 'comment-'+t.id+'-'+i;c.mentions ||= [];delete c.attachments;if(!production)c.notifiedRecipients ||= [];}}}
 normalize();
 if(!production)try{const saved=JSON.parse(localStorage.getItem(STORE)||'null');if(saved?.version===1){inboxSampleVersion=saved.inboxSampleVersion||0;D.notifications=Array.isArray(saved.notifications)?saved.notifications.filter(n=>n&&typeof n.id==='string'&&typeof n.recipientId==='string'&&Number.isFinite(n.createdAt)):[];broadcasts=saved.broadcasts||{};for(const t of D.tasks)if(Array.isArray(saved.comments?.[t.id]))t.comments=saved.comments[t.id];normalize();}}catch{}
 function persist(){
  if(production)return true;
  normalize();
  const now=Date.now();D.notifications=D.notifications.filter(n=>!n.archivedAt||now-n.archivedAt<90*864e5);
  try{localStorage.setItem(STORE,JSON.stringify({version:1,inboxSampleVersion,notifications:D.notifications,comments:Object.fromEntries(D.tasks.map(t=>[t.id,t.comments||[]])),broadcasts}));return true;}catch{if(app&&!storageWarning){storageWarning=true;app.toast('Changes are available in this tab, but local persistence is full.','error');}return false;}
 }
 // Only the currently open editors hold input state; nothing is cached for reopening.
 const context=()=>commentMode;
 const keyFor=(t,c=context())=>JSON.stringify([me()?.id,t.id,c.mode,c.target]);
 function editor(t){const key=keyFor(t);if(commentEditor?.key!==key)commentEditor={key,text:'',mentions:[],editorId:id('editor'),interactionId:id('interaction'),revision:null};return commentEditor;}
 const legacyMentions=tokens=>(tokens||[]).map(token=>Object.hasOwn(token,'start')?token:{id:token.kind==='everyone'?'everyone':token.userId,label:String(token.label||'').replace(/^@/,''),start:token.startOffset,end:token.endOffset});
 const hasInvalidMention=(mentions,eligible,saved)=>{const retained=new Set(legacyMentions(saved).map(m=>m.id));return mentions.some(m=>m.id!=='everyone'&&!eligible.has(m.id)&&!retained.has(m.id));};
 const wireMentions=(text,tokens)=>(tokens||[]).map(token=>({kind:token.id==='everyone'?'everyone':'user',...(token.id==='everyone'?{}:{userId:token.id}),startOffset:token.start,endOffset:token.end,label:text.slice(token.start,token.end)}));
 function blockInputState(t){const key=JSON.stringify([me()?.id,t.id,t.block?.id||'new']);if(blockEditor?.key!==key)blockEditor={key,text:t.block?.reason||'',mentions:structured(legacyMentions(t.block?.mentions))};return blockEditor;}
 function beforeRender(next){
  capture();
  if(production&&renderedUserId!==next.userId){taskPages.clear();feedSnapshot=null;inboxMeta={unreadCount:Number.isFinite(D.inboxUnreadCount)?D.inboxUnreadCount:null,filteredCount:null,nextCursor:null,loaded:false,loading:false,error:false};renderedUserId=next.userId;}
  // A kept comment that is still waiting goes when its writer signs out or someone else signs in.
  if(resumedComment&&resumedComment.userId!==next.userId)resumedComment=null;
  const scope=next.userId&&next.view==='task'?JSON.stringify([next.userId,next.projectId,next.taskId]):null;
  if(scope!==editorScope){feedSnapshot=null;commentResizeObserver?.disconnect();commentResizeObserver=null;cancelAnimationFrame(commentResizeFrame);commentResizeFrame=0;expandedCommentBodies.clear();}
  if(scope!==editorScope||!scope){commentEditor=null;commentMode={mode:'comment',target:null};}
  editorScope=scope;mountedTaskId=scope?next.taskId:null;
  const block=document.getElementById('block-reason');
  if(!next.userId||next.modal?.type!=='block'||block?.dataset.blockTask!==next.modal.id||block?.dataset.blockOwner!==next.userId)blockEditor=null;
  productionApi?.beforeRender?.(next);
 }
 function blockReasonHtml(t){const d=blockInputState(t);return `<textarea class="ctl" id="block-reason" name="reason" data-block-task="${UIEscape(t.id)}" data-block-owner="${UIEscape(me()?.id)}" maxlength="500" placeholder="What is preventing progress? @ to mention" ${UIAction.on('input','blockReasonInput',UIAction.event,t.id)} ${UIAction.on('keydown','commentKey',UIAction.event)}>${esc(d.text)}</textarea><small class="block-mention-hint"></small><div class="block-mention-feedback" role="alert"></div>`;}
 function blockHint(t){const el=document.querySelector('.block-mention-hint');if(el)el.textContent=blockInputState(t).mentions.some(m=>m.id==='everyone')?`Notify ${members(projectOf(t)).filter(u=>u.id!==me()?.id).length} project members`:'';}
 function blockFeedback(message){const el=document.querySelector('.block-mention-feedback');if(el)el.textContent=message;}
 function prepareBlock(t,raw,reason){const d=updateText(t,raw,'block'),eligible=new Set(members(projectOf(t)).map(u=>u.id));
  const selected=validTokens(raw,d.mentions).map(m=>{const start=hooks.clean(raw.slice(0,m.start)+'X',Number.MAX_SAFE_INTEGER).length-1;return {...m,start,end:start+m.label.length+1};});
  const mentions=validTokens(reason,selected);if(hasInvalidMention(mentions,eligible,t.block?.mentions)){blockFeedback('A mentioned person is no longer an active project member. Remove that mention before saving.');return null;}
  const broadcast=mentions.some(m=>m.id==='everyone')&&!t.block?.broadcastSent;
  if(broadcast&&Date.now()-(broadcasts[me().id+':'+projectOf(t).id]||0)<60000){blockFeedback('Please wait a minute before mentioning everyone again.');return null;}
  return {mentions:production?wireMentions(reason,mentions):mentions,broadcast};
 }
 function blockSaved(t,created,prepared){const b=t.block,eligible=new Set(members(projectOf(t)).map(u=>u.id)),recipients=new Map();b.notifiedRecipients ||= [];
  if(prepared.broadcast){for(const uid of eligible)recipients.set(uid,'block-everyone');b.broadcastSent=true;broadcasts[me().id+':'+projectOf(t).id]=Date.now();}
  for(const m of b.mentions||[])if(m.id!=='everyone')recipients.set(m.id,'block-mention');
  for(const [uid,reason] of recipients)if(uid!==me().id&&D.users.some(u=>u.id===uid&&u.active)&&!b.notifiedRecipients.includes(uid)){notify('block:'+b.id,t,[uid],reason,null,null,b.id);b.notifiedRecipients.push(uid);}
  blockEditor=null;const input=document.getElementById('block-reason');if(input)input.dataset.blockSaved='true';closeMentions();persist();
 }
 function blockText(b){return renderText({text:b.reason,mentions:legacyMentions(b.mentions)});}

 function validTokens(text,tokens){let end=-1;return (tokens||[]).filter(m=>Number.isInteger(m.start)&&Number.isInteger(m.end)&&m.start>=0&&m.end<=text.length&&m.start<m.end&&typeof m.label==='string'&&typeof m.id==='string').sort((a,b)=>a.start-b.start).filter(m=>{const before=text.slice(0,m.start),line=before.split('\n').at(-1);if(m.start<end||text.slice(m.start,m.end)!=='@'+m.label||before.split('```').length%2===0||line.split('`').length%2===0||/^\s*>/.test(line))return false;end=m.end;return true;});}
 function updateText(t,text,kind='comment'){const d=kind==='block'?blockInputState(t):editor(t),old=d.text;if(kind==='comment'&&old!==text)d.interactionId=id('interaction');let prefix=0,suffix=0;while(prefix<old.length&&prefix<text.length&&old[prefix]===text[prefix])prefix++;while(suffix<old.length-prefix&&suffix<text.length-prefix&&old[old.length-1-suffix]===text[text.length-1-suffix])suffix++;const delta=text.length-old.length;
  d.mentions=(d.mentions||[]).flatMap(m=>m.end<=prefix?[m]:m.start>=old.length-suffix?[{...m,start:m.start+delta,end:m.end+delta}]:[]);d.text=text;d.mentions=validTokens(text,d.mentions);return d;
 }
 function renderText(c){let out='',pos=0;for(const m of validTokens(c.text,c.mentions)){out+=esc(c.text.slice(pos,m.start));out+=`<span class="comment-mention">${esc(c.text.slice(m.start,m.end))}</span>`;pos=m.end;}return out+esc(c.text.slice(pos));}
 function commentBodyKey(c){return `comment-body-${c.id}`;}
 function commentBodyHtml(task,c){
  if(c.deleted)return `<div class="cmt-body"><span class="comment-removed">Comment removed</span></div>`;
  const key=commentBodyKey(c),expandedBody=expandedCommentBodies.has(key),bodyId=`${key}-content`;
  return `<section class="comment-reading${expandedBody?'':' is-collapsed'}" data-comment-body-key="${esc(key)}"><div class="description-preview"><div class="cmt-body comment-body-content" id="${esc(bodyId)}" role="group" aria-labelledby="comment-author-${esc(c.id)} comment-time-${esc(c.id)}">${renderText(c)}</div></div><button type="button" class="description-toggle" aria-controls="${esc(bodyId)}" aria-expanded="${expandedBody}" ${UIAction('toggleCommentText',task.id,c.id)} hidden>${expandedBody?'Show less':'Show more'}</button></section>`;
 }
 // Batch layout writes, measurements and final writes across the entire feed.
 function sizeCommentBodies(){
  const bodies=[...document.querySelectorAll('.comment-reading')].map(section=>({section,body:section.querySelector('.comment-body-content'),toggle:section.querySelector('.description-toggle')})).filter(item=>item.body&&item.toggle);
  for(const item of bodies){item.expanded=expandedCommentBodies.has(item.section.dataset.commentBodyKey);item.scrollTop=item.body.scrollTop;item.body.style.overflowY='hidden';item.body.style.height='0px';}
  const heights=bodies.map(({body})=>body.scrollHeight),limit=Math.max(240,Math.round(innerHeight*.8));
  bodies.forEach(({section,body,toggle,expanded,scrollTop},index)=>{
   const fullHeight=heights[index],isLong=fullHeight>240;
   body.style.height=Math.min(fullHeight,expanded?limit:240)+'px';body.style.overflowY=expanded?'auto':'hidden';body.scrollTop=expanded?scrollTop:0;
   if(isLong&&(!expanded||fullHeight>limit))body.setAttribute('tabindex','0');else body.removeAttribute('tabindex');
   toggle.hidden=!isLong;section.classList.toggle('is-collapsed',isLong&&!expanded);toggle.textContent=expanded?'Show less':'Show more';toggle.setAttribute('aria-expanded',String(expanded));
  });
 }
 function mountCommentBodies(){
  cancelAnimationFrame(commentResizeFrame);commentResizeFrame=0;sizeCommentBodies();commentResizeObserver?.disconnect();
  if(typeof ResizeObserver==='undefined')return;
  const widths=new WeakMap();commentResizeObserver=new ResizeObserver(entries=>{let changed=false;for(const {target} of entries){if(widths.get(target)!==target.clientWidth){widths.set(target,target.clientWidth);changed=true;}}if(changed){cancelAnimationFrame(commentResizeFrame);commentResizeFrame=requestAnimationFrame(()=>{commentResizeFrame=0;sizeCommentBodies();});}});
  document.querySelectorAll('.comment-reading').forEach(section=>{widths.set(section,section.clientWidth);commentResizeObserver.observe(section);});
 }
 function notify(eventId,task,recipients,reason,commentId=null,rootId=null,blockId=null){const project=projectOf(task),actor=me();if(!project||!actor)return;for(const userId of new Set(recipients)){if(userId===actor.id||!D.users.some(u=>u.id===userId&&u.active&&(u.admin||members(project).some(m=>m.id===u.id))))continue;if(D.notifications.some(n=>n.eventId===eventId&&n.recipientId===userId))continue;D.notifications.push({id:id('notice'),eventId,recipientId:userId,actorId:actor.id,projectId:project.id,taskId:task.id,commentId,rootId,blockId,reason,createdAt:Date.now(),readAt:null,archivedAt:null});}persist();badge();}
 function taskEvent(task,reason,recipients=task.assignees||[]){notify(id('event'),task,recipients,reason);}
 function sameMarkup(old,next,outer=false){
  if(!old||!next)return false;
  const current=outer?old.outerHTML:old.innerHTML,expected=outer?next.outerHTML:next.innerHTML;
  if(current===expected)return true;
  const oldClone=old.cloneNode(true),nextClone=next.cloneNode(true);
  for(const clone of [oldClone,nextClone])[clone,...clone.querySelectorAll('*')].forEach(node=>[...node.attributes].forEach(attr=>{if(attr.name.startsWith('on')||/^data-(?:action|args)\b/.test(attr.name))node.removeAttribute(attr.name);}));
  return (outer?oldClone.outerHTML:oldClone.innerHTML)===(outer?nextClone.outerHTML:nextClone.innerHTML);
 }
 /** @param {{append?:boolean,items?:any[]}} meta */
 function refreshInbox(meta={}){
  const page=/** @type {HTMLElement|null} */(document.querySelector('.inbox-page')),list=/** @type {HTMLElement|null} */(page?.querySelector('.inbox-list'));if(!list){hooks.refresh();return;}
  if(meta.append&&meta.items){appendInbox(page,list,meta.items);return;}
  const scroll=page.closest('.content'),scrollTop=scroll?.scrollTop||0,beforeHeight=list.getBoundingClientRect().height,before=UIMotion.rows(list,'[data-inbox-key]','data-inbox-key'),oldRows=new Map([...list.querySelectorAll('[data-notification-id]')].map((/** @type {HTMLElement} */ el)=>[el.dataset.notificationId,el]));
  const oldKeys=new Map([...list.querySelectorAll('[data-inbox-key]')].map(el=>[el.dataset.inboxKey,el]));list.querySelector('.inbox-exit-layer')?.remove();
  const focused=document.activeElement,focusRow=focused?.closest('[data-notification-id]'),focusIndex=[...oldRows.keys()].indexOf(focusRow?.dataset.notificationId),focusAction=focusRow?[...focusRow.querySelectorAll('.inbox-row-actions button')].indexOf(focused):-1,focusOpen=focused?.classList?.contains('inbox-open'),focusBulk=focused?.closest('.inbox-bulk')?[...page.querySelectorAll('.inbox-bulk button')].indexOf(focused):-1,focusMore=focused?.classList?.contains('inbox-load-more');
  const template=document.createElement('template');setHTML(template,inboxHtml({oldRows}));const next=template.content.querySelector('.inbox-page'),nextList=next.querySelector('.inbox-list'),wanted=new Set([...nextList.querySelectorAll('[data-notification-id]')].map(el=>el.dataset.notificationId));
  const exiting=document.createElement('div');exiting.className='inbox-exit-layer';exiting.inert=true;exiting.setAttribute('aria-hidden','true');const listRect=list.getBoundingClientRect(),viewport=scroll?.getBoundingClientRect();
  if(!UIMotion.reduced())oldRows.forEach((el,id)=>{const rect=before.get('row-'+id);if(wanted.has(id)||!rect?.height||viewport&&(rect.bottom<viewport.top||rect.top>viewport.bottom))return;const ghost=el.cloneNode(true);[ghost,...ghost.querySelectorAll('*')].forEach(node=>[...node.attributes].forEach(attr=>{if(attr.name==='id'||attr.name==='name'||attr.name.startsWith('on')||attr.name.startsWith('data-'))node.removeAttribute(attr.name);}));Object.assign(ghost.style,{position:'absolute',top:rect.top-listRect.top+'px',left:rect.left-listRect.left+'px',width:rect.width+'px',height:rect.height+'px',margin:'0'});exiting.append(ghost);});
  const children=[...nextList.children].map((/** @type {HTMLElement} */ el)=>{const old=oldKeys.get(el.dataset.inboxKey);if(!old)return el;if(el.dataset.sig&&old.dataset.sig===el.dataset.sig)return old;old.className=el.className;if(el.dataset.sig||!sameMarkup(old,el))setHTML(old,el.innerHTML);if(el.dataset.sig)old.dataset.sig=el.dataset.sig;return old;});let cursor=list.firstElementChild;for(const child of children){if(child===cursor)cursor=cursor.nextElementSibling;else list.insertBefore(child,cursor);}while(cursor){const next=cursor.nextElementSibling;cursor.remove();cursor=next;}if(exiting.children.length){exiting.style.height=beforeHeight+'px';list.append(exiting);const animation=UIMotion.animate(exiting,[{opacity:1},{opacity:0}],140);if(animation)animation.finished.then(()=>exiting.remove(),()=>exiting.remove());else exiting.remove();}
  const controls=page.querySelector('.inbox-controls'),newControls=next.querySelector('.inbox-controls');
  for(const selector of ['.seg button','.inbox-unread-filter']){const old=[...controls.querySelectorAll(selector)];newControls.querySelectorAll(selector).forEach((el,i)=>{old[i].className=el.className;old[i].setAttribute('aria-pressed',el.getAttribute('aria-pressed'));old[i].dataset.action=el.dataset.action;old[i].dataset.args=el.dataset.args;});}
  const project=controls.querySelector('[data-filter-key="inboxProjects"]'),newProject=newControls.querySelector('[data-filter-key="inboxProjects"]');setHTML(project,newProject.innerHTML);project.dataset.tip=newProject.dataset.tip;project.className=newProject.className;
  const bulk=page.querySelector('.inbox-bulk'),nextBulk=next.querySelector('.inbox-bulk');if(!sameMarkup(bulk,nextBulk))setHTML(bulk,nextBulk.innerHTML);
  const oldMore=/** @type {HTMLButtonElement|null} */(page.querySelector('.inbox-load-more')),more=next.querySelector('.inbox-load-more');if(!sameMarkup(oldMore,more,true)){oldMore?.remove();if(more)page.append(more);}
  const oldNotice=page.querySelector('.inbox-refresh-notice'),newNotice=next.querySelector('.inbox-refresh-notice');if(!(oldNotice&&newNotice&&oldNotice.outerHTML===newNotice.outerHTML)){oldNotice?.remove();if(newNotice)list.before(newNotice);}
  UIMotion.height(list,beforeHeight);if(scroll)scroll.scrollTop=scrollTop;UIMotion.reflow(list,'[data-inbox-key]','data-inbox-key',before);if(!oldKeys.has('empty'))UIMotion.fade(list.querySelector('.inbox-empty'));badge();
  if(focusRow&&focusAction>=0){const row=oldRows.get(focusRow.dataset.notificationId);(row?.isConnected?row.querySelectorAll('.inbox-row-actions button')[focusAction]:[...list.querySelectorAll('[data-notification-id]')][Math.min(focusIndex,wanted.size-1)]?.querySelectorAll('.inbox-row-actions button')[focusAction]||controls.querySelector('.inbox-unread-filter'))?.focus({preventScroll:true});}
  else if(focusOpen){const row=oldRows.get(focusRow?.dataset.notificationId);(row?.isConnected?row:[...list.querySelectorAll('[data-notification-id]')][Math.min(focusIndex,wanted.size-1)])?.querySelector('.inbox-open')?.focus({preventScroll:true});}
  else if(focusBulk>=0){const target=bulk.querySelectorAll('button')[focusBulk];(target&&!target.disabled?target:bulk.querySelector('button:not(:disabled)')||controls.querySelector('.inbox-unread-filter'))?.focus({preventScroll:true});}
  else if(focusMore)page.querySelector('.inbox-load-more')?.focus({preventScroll:true});
 }

 /** @param {boolean} busy */
 function inboxBusy(busy){const button=/** @type {HTMLButtonElement|null} */(document.querySelector('button.inbox-load-more'));if(button){button.disabled=busy;button.setAttribute('aria-busy',String(busy));}}
 /** @param {HTMLElement} page @param {HTMLElement} list @param {any[]} items */
 function appendInbox(page,list,items){
  const lastGroup=list.querySelector('.inbox-group-heading:last-of-type')?.textContent||'';
  const template=document.createElement('template');setHTML(template,inboxHtml({items,lastGroup}));
  const next=template.content.querySelector('.inbox-page'),nextList=next.querySelector('.inbox-list');
  list.querySelector('.inbox-empty')?.remove();
  for(const child of [...nextList.children]){
    if(child.classList.contains('inbox-empty')&&list.querySelector('.inbox-row'))continue;
    const id=child.getAttribute('data-notification-id');
    const existing=id?document.getElementById('inbox-row-'+id):null;
    if(existing){if(existing.dataset.sig!==child.getAttribute('data-sig'))existing.replaceWith(child);}
    else list.append(child);
  }
  const bulk=page.querySelector('.inbox-bulk');setHTML(bulk,next.querySelector('.inbox-bulk').innerHTML);
  const oldMore=/** @type {HTMLButtonElement|null} */(page.querySelector('.inbox-load-more')),more=next.querySelector('.inbox-load-more');
  if(oldMore&&more){oldMore.disabled=false;oldMore.setAttribute('aria-busy','false');}
  else {oldMore?.remove();if(more)page.append(more);}
  page.querySelector('.inbox-refresh-notice')?.remove();badge();
 }
 function inboxWritable(){if(window.Recovery?.enforceSession()){hooks.refresh();return false;}return !window.Recovery||Recovery.ensureOnline();}
 // The exact time shows as a tooltip on hover, focus and tap.
 function exactTimeAttributes(/** @type {number} */ value){const exact=esc(hooks.instant(value));return `aria-label="${exact}" data-tip="${esc(hooks.instant(value))}"`;}
 const own=()=>me()?.active?(production?D.notifications:D.notifications.filter(n=>n.recipientId===me().id)):[];
 const unread=()=>production&&inboxMeta.unreadCount!==null?inboxMeta.unreadCount:own().filter(n=>!n.readAt&&!n.archivedAt).length;
 function badge(){const count=unread();document.querySelectorAll('[data-inbox-dot]').forEach(el=>el.hidden=!count);document.querySelectorAll('.inbox-nav').forEach(el=>{el.setAttribute('aria-label','Inbox'+(count?', '+count+' unread':''));el.title='Inbox'+(count?' · '+count+' unread':'');});}
 function inboxNav(view){const count=unread();return `<button type="button" class="nav-item inbox-nav inbox-icon ${view==='inbox'?'on':''}" ${view==='inbox'?'aria-current="page"':''} ${UIAction('nav','inbox')} title="Inbox${count?' · '+count+' unread':''}" aria-label="Inbox${count?', '+count+' unread':''}"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 3h12l2 8v4H1v-4L3 3Z" stroke-linejoin="round"/><path d="M1 11h4l1.5 2h5L13 11h4"/></svg><span class="inbox-dot" data-inbox-dot ${count?'':'hidden'}></span></button>`;}
 function matching(){return own().filter(n=>!!n.archivedAt===filter.archived&&(!filter.projects.length||filter.projects.includes(n.projectId))&&(!filter.unread||!n.readAt)).sort((a,b)=>b.createdAt-a.createdAt);}
 const reasons={'block-mention':'mentioned you in a block reason','block-everyone':'mentioned everyone in a block reason',mention:'mentioned you',everyone:'mentioned everyone',reply:'replied to your comment',assigned:'assigned you a task',blocked:'blocked a task',unblocked:'unblocked a task'};
 const inboxIcon=path=>`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
 const inboxIcons={read:inboxIcon('<path d="m3 9 9-6 9 6v11H3V9Zm0 0 9 6 9-6M3 20l6-7m12 7-6-7"/>'),unread:inboxIcon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),archive:inboxIcon('<rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v14h14V7M9 11h6"/>'),restore:inboxIcon('<path d="M4 10a8 8 0 1 1 2 8M4 4v6h6"/>'),inbox:inboxIcon('<path d="M5 4h14l3 10v6H2v-6L5 4Z"/><path d="M2 14h6l2 3h4l2-3h6"/>')};
 /** @param {{items?:any[]|null,lastGroup?:string,oldRows?:Map<string,HTMLElement>|null}} options */
 function inboxHtml({items=null,lastGroup='',oldRows=null}={}){
  const projects=hooks.projects();filter.projects=filter.projects.filter(id=>projects.some(p=>p.id===id));
  const list=matching(),visible=items??(production?(inboxMeta.loaded?list:[]):list.slice(0,filter.limit)),unreadCount=production&&!inboxMeta.loaded?0:list.filter(n=>!n.readAt).length,total=production&&!inboxMeta.loaded?0:production&&inboxMeta.filteredCount!==null?inboxMeta.filteredCount:list.length;
  const today=hooks.dateKey(),yesterday=hooks.previousDate(today);
  const inboxEmpty=production&&!inboxMeta.loaded?(inboxMeta.error?`<div class="page-empty inbox-empty" data-inbox-key="empty" role="alert"><h2>Could not load notifications</h2><button class="btn quiet" ${UIAction('retryInbox')}>Retry</button></div>`:'<div class="page-empty inbox-empty" data-inbox-key="empty" role="status"><div class="skeleton skeleton-heading"></div><div class="skeleton skeleton-card"></div><span class="sr-only">Loading notifications</span></div>'):'';
  const refreshNotice=production&&inboxMeta.loaded&&inboxMeta.error?`<div class="access-note inbox-refresh-notice" role="alert">Could not refresh notifications. <button class="btn quiet" ${UIAction('retryInbox')}>Retry</button></div>`:'';
  const rows=visible.map(n=>{
    const project=projects.find(p=>p.id===n.projectId),task=project?hooks.task(n.taskId):null,comment=task?.comments?.find(c=>c.id===n.commentId),available=production?!!n.destinationAvailable:!!(task&&project),block=[task?.block,...(task?.blockHistory||[])].find(b=>b?.id===n.blockId),actor=userById(n.actorId);
    const excerpt=!available?'This item is no longer available':production?(n.excerpt||''):n.blockId?(block?.reason||'Block details unavailable'):n.commentId?(comment&&!comment.deleted?comment.text:'Comment removed'):'';
    const group=hooks.dateKey(n.createdAt)===today?'Today':hooks.dateKey(n.createdAt)===yesterday?'Yesterday':'Earlier';const heading=group!==lastGroup?`<h2 class="inbox-group-heading" data-inbox-key="group-${UIEscape(group)}">${group}</h2>`:'';lastGroup=group;
    const age=hooks.ago(n.createdAt),sig=JSON.stringify([n,available,excerpt,project?.name,task?.title,task?.id,actor?.name,actor?.avatar,age]);
    if(oldRows?.get(n.id)?.dataset.sig===sig)return `${heading}<article data-inbox-key="row-${esc(n.id)}" data-notification-id="${esc(n.id)}" data-sig="${esc(sig)}"></article>`;
    return `${heading}<article id="inbox-row-${esc(n.id)}" data-sig="${esc(sig)}" data-inbox-key="row-${esc(n.id)}" data-notification-id="${esc(n.id)}" class="inbox-row ${n.readAt?'read':'unread'}"><button class="inbox-open" ${UIAction('openNotification',n.id)}><span class="inbox-person">${hooks.avatar(n.actorId,32)}${!n.readAt?'<span class="inbox-unread-dot"><span class="sr-only">Unread</span></span>':''}</span><span class="inbox-copy"><span class="inbox-event"><strong>${esc(n.actorName||actor?.name||'Former user')}</strong> ${reasons[n.reason]||'updated a task'}</span><span class="inbox-task-title">${esc(n.taskTitle||task?.title||'Task unavailable')}</span>${excerpt?`<span class="inbox-excerpt">${esc(excerpt)}</span>`:''}</span></button><div class="inbox-row-footer"><span class="inbox-context"><span>${esc(n.projectName||project?.name||'Unavailable project')}</span><span class="inbox-task-key">${esc(available?(n.taskKey||task?.id||n.taskId):'Unavailable')}</span><time class="inbox-time" datetime="${new Date(n.createdAt).toISOString()}" ${exactTimeAttributes(n.createdAt)}>${age}</time></span><div class="inbox-row-actions"><button class="btn quiet" aria-label="Mark notification ${n.readAt?'unread':'read'}" title="Mark ${n.readAt?'unread':'read'}" ${UIAction('setNotificationRead',n.id,!!n.readAt)}>${n.readAt?inboxIcons.unread:inboxIcons.read}<span>Mark ${n.readAt?'unread':'read'}</span></button><button class="btn quiet" aria-label="${n.archivedAt?'Restore':'Archive'} notification" title="${n.archivedAt?'Restore':'Archive'}" ${UIAction('archiveNotification',n.id)}>${n.archivedAt?inboxIcons.restore:inboxIcons.archive}<span>${n.archivedAt?'Restore':'Archive'}</span></button></div></div></article>`;
  }).join('');
  return `<div class="workspace-page inbox-page"><div class="inbox-controls"><div class="seg" role="group" aria-label="Notification view"><button class="${!filter.archived?'on':''}" aria-pressed="${!filter.archived}" ${UIAction('inboxFilter','archived',false)}>Inbox</button><button class="${filter.archived?'on':''}" aria-pressed="${filter.archived}" ${UIAction('inboxFilter','archived',true)}>Archived</button></div><div class="inbox-filter-group">${hooks.multi('inboxProjects',{label:'Filter inbox by project',width:200,options:projects.map(p=>({v:p.id,l:p.name})),search:projects.length>6,values:()=>filter.projects,toggle:value=>{const index=filter.projects.indexOf(value);index<0?filter.projects.push(value):filter.projects.splice(index,1);filter.limit=50;if(production)productionApi?.loadInbox?.(filter);else refreshInbox();},clear:()=>{filter.projects.length=0;filter.limit=50;if(production)productionApi?.loadInbox?.(filter);else refreshInbox();},summary:()=>filter.projects.length===0?'All projects':filter.projects.length===1?projects.find(p=>p.id===filter.projects[0])?.name||'All projects':`${filter.projects.length} projects`})}<button class="btn inbox-unread-filter" aria-pressed="${filter.unread}" ${UIAction('inboxFilter','unread',!filter.unread)}>${inboxIcons.unread}Unread</button></div></div><div class="inbox-bulk"><span>${total} ${total===1?'notification':'notifications'}</span><div><button class="btn" ${!unreadCount?'disabled':''} ${UIAction('inboxBulk','read')}>${inboxIcons.read}Mark ${filter.projects.length||filter.unread?'filtered':'all'} as read</button>${!filter.archived?`<button class="btn" ${!total?'disabled':''} ${UIAction('inboxBulk','archive')}>${inboxIcons.archive}Archive ${filter.projects.length||filter.unread?'filtered':'all'}</button>`:''}</div></div>${refreshNotice}<div class="inbox-list">${rows||inboxEmpty||`<div class="page-empty inbox-empty" data-inbox-key="empty"><span class="inbox-empty-icon">${inboxIcons.inbox}</span><h2>${filter.unread?'No unread notifications':filter.archived?'No archived notifications':'You’re all caught up'}</h2><p>${filter.projects.length?'Nothing here for the selected projects.':filter.archived?'Archived notifications will appear here.':'Mentions, replies and task updates will appear here.'}</p></div>`}</div>${production?inboxMeta.nextCursor?`<button class="btn quiet inbox-load-more" ${UIAction('moreInbox')}>Load more</button>`:'':list.length>filter.limit?`<button class="btn quiet inbox-load-more" ${UIAction('moreInbox')}>Load more</button>`:''}</div>`;
 }

 const commentIcons={reply:inboxIcon('<path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7v2"/>'),edit:inboxIcon('<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z"/>'),remove:inboxIcon('<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>'),more:inboxIcon('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),chevron:inboxIcon('<path d="m9 5 7 7-7 7"/>')};
 function commentRow(task,c,isReply=false,allowed=canComment(task)){
  const author=userById(c.who),editable=allowed&&(c.who===me()?.id||me()?.admin),target=task.comments.find(r=>r.id===c.replyToId),editing=editable&&!c.deleted&&commentMode.mode==='edit'&&commentMode.target===c.id,replying=commentMode.mode==='reply'&&commentMode.target===c.id;
  return `<article class="tl-cmt ${isReply?'comment-reply':''}${replying?' is-reply-target':''}" data-comment="${UIEscape(c.id)}" tabindex="-1"><div class="cmt-head">${hooks.avatar(c.who,isReply?20:24)}<b id="comment-author-${esc(c.id)}">${esc(author?.name||c.authorName||c.who)}</b><time id="comment-time-${esc(c.id)}" class="act-time" datetime="${new Date(c.ts).toISOString()}" ${exactTimeAttributes(c.ts)}>${hooks.ago(c.ts)}${c.editedAt?' · edited':''}</time>${editable&&!c.deleted&&!editing?`<button type="button" class="btn icon comment-menu-button" aria-label="Actions for comment by ${esc(author?.name||c.authorName||c.who)}" aria-expanded="false" aria-controls="action-menu" title="Comment actions" ${UIAction('commentMenu',UIAction.event,task.id,c.id)}>${commentIcons.more}</button>`:''}</div>${target&&c.replyToId!==c.parentId?`<button type="button" class="reply-reference" ${UIAction('jumpToComment',task.id,target.id)} title="View the original comment">${commentIcons.reply}<span><strong>${esc(userById(target.who)?.name||target.authorName||'Former user')}</strong> ${esc(target.deleted?'Comment removed':target.text)}</span></button>`:''}${editing?composerHtml(task,true):`${commentBodyHtml(task,c)}${allowed&&!c.deleted?`<div class="comment-actions"><button type="button" class="btn quiet reply-action" aria-pressed="${replying}" ${UIAction('replyComment',task.id,c.id)}>${commentIcons.reply}<span>Reply</span></button></div>`:''}`}</article>`;
 }
 function replySummary(task,root,replies,open){
  const people=[...new Set(replies.filter(c=>!c.deleted).map(c=>c.who))].slice(0,3);
  const total=Number.isInteger(root?.replyCount)?root.replyCount:replies.length;
  const label=total>replies.length?`${replies.length} of ${total} replies`:`${total} ${total===1?'reply':'replies'}`;
  return `<span class="reply-chevron" aria-hidden="true">${commentIcons.chevron}</span><span class="reply-participants" aria-hidden="true">${people.map(who=>hooks.avatar(who,18)).join('')}</span><span>${open?'Hide ':''}${label}</span><span class="reply-latest">${hooks.ago(replies.at(-1).ts)}</span>`;
 }
 function feedHtml(task,limit=50){normalize();const allowed=canComment(task),roots=(task.comments||[]).filter(c=>!c.parentId),items=[...Activity.visible(task.activity).map(a=>({...a,kind:'activity'})),...roots.map(c=>({...c,kind:'comment'}))].sort(chronological),hasMore=production?taskPages.get(task.id)?.hasMore:items.length>limit;
  // A feed key keeps this button across timeline refreshes, so a click that spans a live update still lands.
  return (hasMore?`<button class="btn quiet" data-feed-key="load-older" ${UIAction('loadOlderActivity',task.id)}>Load older activity</button>`:'')+(production?items:items.slice(-limit)).map(item=>{
   if(item.kind==='activity')return `<div class="tl-act${/^(attached |deleted attachment: |restored attachment: |made .+ (temporary|permanent)$|Temporary file removed during storage cleanup: )/.test(item.text)?' attachment-activity':''}" ${item.blockId?`data-block-id="${esc(item.blockId)}" tabindex="-1"`:''} data-feed-key="activity-${esc(item.id||item.ts+':'+item.who+':'+item.text)}">${hooks.avatar(item.who,16)}<span data-tip="${esc(item.text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,''))}" data-tip-overflow><b>${esc(userById(item.who)?.name||item.actorName||(item.who==='system'?'System':item.who))}</b> ${esc(item.text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,''))}</span>${item.actorAppName?`<span class="act-time activity-source">via ${esc(item.actorAppName)}</span>`:''}<time class="act-time" datetime="${new Date(item.ts).toISOString()}" ${exactTimeAttributes(item.ts)}>· ${hooks.ago(item.ts)}</time></div>`;
   const replies=task.comments.filter(c=>c.parentId===item.id).sort(chronological),target=task.comments.find(c=>c.id===commentMode.target),replying=commentMode.mode==='reply'&&(target?.parentId||target?.id)===item.id,editingReply=allowed&&!target?.deleted&&(target?.who===me()?.id||me()?.admin)&&commentMode.mode==='edit'&&target?.parentId===item.id,open=expanded.has(item.id);
   return `<div class="comment-conversation" data-feed-key="comment-${esc(item.id)}">${commentRow(task,item,false,allowed)}${replies.length?`<button type="button" class="btn quiet reply-toggle" data-reply-root="${esc(item.id)}" aria-expanded="${open}" aria-controls="replies-${esc(item.id)}" ${editingReply?'disabled title="Save or cancel your edit before hiding replies"':''} ${UIAction('toggleReplies',task.id,item.id)}>${replySummary(task,item,replies,open)}</button><div class="comment-thread-wrap${open?' is-expanded':''}" id="replies-${esc(item.id)}" data-thread-root="${esc(item.id)}" aria-hidden="${!open}" ${open?'':'inert'}><div><div class="comment-thread">${replies.map(c=>commentRow(task,c,true,allowed)).join('')}</div></div></div>`:''}${replying?`<div class="thread-composer">${composerHtml(task,true)}</div>`:''}</div>`;
  }).join('');
 }
 function composerHtml(task,inline=false){
  if(!canComment(task)||!inline&&commentMode.mode!=='comment')return '';
  const c=context(task),d=editor(task),target=task.comments?.find(x=>x.id===c.target),name=userById(target?.who)?.name||target?.authorName||'Former user';
  return `<div class="cmt-new collaboration-composer${inline?' inline-composer':''}" data-comment-task="${UIEscape(task.id)}" data-comment-owner="${UIEscape(me()?.id)}">${c.mode!=='comment'?`<div class="reply-context"><div class="reply-context-main"><strong>${c.mode==='edit'?commentIcons.edit+'Editing comment':commentIcons.reply+'Replying to '+esc(name)}</strong>${c.mode==='reply'?`<span class="reply-context-quote">${esc(target?.deleted?'Comment removed':target?.text||'')}</span>`:''}</div><button type="button" class="btn quiet" ${UIAction('cancelCommentMode',task.id)}>Cancel</button></div>`:''}<label class="sr-only" for="cmtIn">${c.mode==='edit'?'Edit comment':c.mode==='reply'?'Write a reply':'Write a comment'}</label><textarea id="cmtIn" class="ctl" maxlength="2000" placeholder="${c.mode==='reply'?'Write a reply — @ to mention':'Write a comment — @ to mention'}" ${UIAction.on('input','commentInput',UIAction.event,task.id)} ${UIAction.on('keydown','commentKey',UIAction.event)}>${esc(d.text)}</textarea><div class="comment-feedback" role="status"></div><div class="comment-composer-actions"><button type="button" class="btn primary" ${UIAction('addComment',task.id)}>${c.mode==='edit'?'Save changes':c.mode==='reply'?'Send reply':'Comment'}</button></div><div class="comment-notify-hint"></div></div>`;
 }

 function feedback(message){const el=document.querySelector('.comment-feedback');if(el)el.textContent=message;}
 function refreshComments(task,composer=false){hooks.refreshComments(task.id,composer);mount();}
 function taskFeedState(id){return production?(taskPages.get(id)||{loaded:false,loading:true,error:false}):{loaded:true,loading:false,error:false};}
 // Retain one serialization for the mounted task; metadata does not duplicate the feed.
 function feedSnapshotFor(task,meta=taskFeedState(task.id)){
  return {taskId:task.id,data:JSON.stringify([task.comments,task.activity,commentMode.mode,commentMode.target,[...expanded]]),meta:JSON.stringify([meta.loaded,meta.loading,meta.error,meta.hasMore])};
 }
 function scrollWithinTask(el,center=false){
  const panel=el?.closest('.task-page');if(!panel)return;
  const item=el.getBoundingClientRect(),viewport=panel.getBoundingClientRect();
  const offset=center?(panel.clientHeight-item.height)/2:item.top<viewport.top?0:item.bottom>viewport.bottom?panel.clientHeight-item.height:null;
  if(offset===null)return;
  const top=Math.max(0,Math.min(panel.scrollHeight-panel.clientHeight,panel.scrollTop+item.top-viewport.top-offset));
  panel.scrollTo?.({top,behavior:UIMotion.reduced()?'auto':'smooth'});
 }
 function setMode(taskId,mode,target){const t=hooks.task(taskId);if(!t||!canComment(t))return;if(commentMode.mode===mode&&commentMode.target===target){const input=document.getElementById('cmtIn');input?.focus({preventScroll:true});scrollWithinTask(input?.closest('.collaboration-composer')||input);return;}capture();const c=t.comments.find(c=>c.id===target);if(target&&(!c||c.deleted))return;if(mode==='edit'&&(c.who!==me().id&&!me().admin))return;commentMode={mode,target};commentEditor=null;if(mode==='edit')Object.assign(editor(t),{text:c.text,mentions:structured(c.mentions),revision:c.revision});if(mode==='reply')expanded.add(c.parentId||c.id);else if(c?.parentId)expanded.add(c.parentId);refreshComments(t,true);const input=document.getElementById('cmtIn');input?.focus({preventScroll:true});scrollWithinTask(input?.closest('.collaboration-composer')||input);}
 const structured=v=>JSON.parse(JSON.stringify(v||[]));
 function closeMentions(silent=false){const panel=document.querySelector('.mention-picker');if(panel&&!silent)hooks?.exit?.(panel);panel?.remove();const input=mention?.input;input?.removeAttribute('aria-controls');input?.removeAttribute('aria-activedescendant');mention=null;}
 function pickMention(index){if(!mention)return;const {taskId,start,end,options,input,kind}=mention,option=options[index],task=hooks.task(taskId);if(!option||!task||!input?.isConnected)return;const value=input.value.slice(0,start)+'@'+option.label+' '+input.value.slice(end);if(value.length>input.maxLength){(kind==='block'?blockFeedback:feedback)(`The ${kind==='block'?'reason':'comment'} is too long to add this mention.`);closeMentions();return;}const d=updateText(task,value,kind);d.mentions.push({start,end:start+option.label.length+1,id:option.id,label:option.label});input.value=value;const caret=start+option.label.length+2;closeMentions();input.focus();input.setSelectionRange(caret,caret);persist();if(kind==='block')blockHint(task);else notifyHint(task);}
 function paintMentions(){const panel=document.querySelector('.mention-picker');if(!panel||!mention)return;setHTML(panel,mention.options.map((o,i)=>`<button type="button" role="option" aria-selected="${i===mention.index}" id="mention-choice-${UIEscape(i)}" data-mention-index="${UIEscape(i)}"><strong>${esc(o.label==='everyone'?'@everyone':o.name)}</strong><small>${o.id==='everyone'?'All active project members':'@'+esc(o.label)}</small></button>`).join(''));panel.querySelectorAll('button').forEach((b,i)=>{b.onpointerdown=e=>e.preventDefault();b.onclick=()=>pickMention(i);});mention.input?.setAttribute('aria-activedescendant','mention-choice-'+mention.index);}
 function suggest(input,task,kind='comment'){const before=input.value.slice(0,input.selectionStart),line=before.split('\n').at(-1),match=before.match(/(?:^|\s)@([a-z0-9._-]*)$/i);if(!match||before.split('```').length%2===0||line.split('`').length%2===0||/^\s*>/.test(line)){closeMentions();return;}const q=match[1].toLowerCase(),options=[{id:'everyone',label:'everyone',name:'Everyone'},...members(projectOf(task)).map(u=>({id:u.id,label:u.username||u.id,name:u.name}))].filter(o=>o.label.toLowerCase().includes(q)||o.name.toLowerCase().includes(q)).sort((a,b)=>Number(b.label.toLowerCase().startsWith(q))-Number(a.label.toLowerCase().startsWith(q)));if(!options.length){closeMentions();return;}
  const replacing=!!document.querySelector('.mention-picker');closeMentions(true);mention={input,kind,taskId:task.id,start:input.selectionStart-q.length-1,end:input.selectionStart,options,index:0};const el=document.createElement('div');el.className='mention-picker';el.id='mention-picker';el.setAttribute('role','listbox');el.setAttribute('aria-label','Mention project members');document.body.append(el);input.setAttribute('aria-controls',el.id);paintMentions();const r=input.getBoundingClientRect();el.style.width=Math.min(320,innerWidth-16)+'px';el.style.left=Math.max(8,Math.min(r.left,innerWidth-el.offsetWidth-8))+'px';el.style.top=Math.max(8,r.bottom+el.offsetHeight+8<innerHeight?r.bottom+6:r.top-el.offsetHeight-6)+'px';if(!replacing)UIMotion.enter(el);
 }
 function notifyHint(task){const el=document.querySelector('.comment-notify-hint');if(!el)return;const d=editor(task);el.textContent=d.mentions.some(m=>m.id==='everyone')?`Notify ${members(projectOf(task)).filter(u=>u.id!==me()?.id).length} project members`:'';}
 function capture(){const input=document.getElementById('cmtIn'),task=hooks?.task(input?.closest('[data-comment-task]')?.dataset.commentTask);if(input&&task&&input.closest('[data-comment-task]').dataset.commentOwner===me()?.id&&canComment(task))updateText(task,input.value);const block=document.getElementById('block-reason'),blockedTask=hooks?.task(block?.dataset.blockTask);if(block&&!block.dataset.blockSaved&&blockedTask&&block.dataset.blockOwner===me()?.id&&hooks.canBoard(blockedTask))updateText(blockedTask,block.value,'block');}
 function currentCommentInput(submitted){
  capture();
  const input=document.getElementById('cmtIn');
  return commentEditor?.editorId===submitted.editorId&&commentEditor?.interactionId===submitted.interactionId&&input?.closest('[data-comment-task]')?.dataset.commentTask===submitted.task.id?input:null;
 }
 function savedComment(task,c,mode,changed,submitted=null){
  capture();
  // The person writes something else by now: their next edit, a new comment
  // or a reply elsewhere. It stays as it is; the main box is outside the
  // list, so the list can show this comment at once.
  const elsewhere=submitted&&(mode==='edit'?commentEditor?.interactionId!==submitted.interactionId:!!commentEditor?.text||commentMode.mode!==mode||(commentMode.target??null)!==(submitted.targetId??null));
  if(elsewhere){if(mode!=='edit'&&commentMode.mode==='comment')refreshComments(task);if(changed)app.toast(mode==='edit'?'Comment updated':mode==='reply'?'Reply added':'Comment added');return;}
  if(c.parentId)expanded.add(c.parentId);commentEditor=null;commentMode={mode:'comment',target:null};closeMentions();refreshComments(task,true);if(changed)app.toast(mode==='edit'?'Comment updated':mode==='reply'?'Reply added':'Comment added');const focus=mode==='comment'?document.getElementById('cmtIn'):[...document.querySelectorAll('[data-comment]')].find(el=>el.dataset.comment===c.id);if(focus&&mode!=='comment'){focus.classList.add('comment-save-focus');focus.addEventListener('blur',()=>focus.classList.remove('comment-save-focus'),{once:true});}focus?.focus({preventScroll:true});scrollWithinTask(mode==='comment'?focus?.closest('.collaboration-composer')||focus:focus);
 }
 function post(taskId){const task=hooks.task(taskId);if(!task||!canComment(task)){feedback('You must be an active project member to comment.');return false;}if(window.Recovery&&!Recovery.ensureOnline())return false;capture();const cxt=context(task),d=editor(task),text=d.text;if(!text.trim()){if(!commentsOnTheirWay(task))feedback('Write a comment first.');return false;}if(text.length>2000){feedback('Comments are limited to 2,000 characters.');return false;}
  const existing=cxt.mode==='edit'?task.comments.find(c=>c.id===cxt.target):null,target=cxt.mode==='reply'?task.comments.find(c=>c.id===cxt.target):null;
  if(cxt.mode==='edit'&&(!existing||existing.deleted||existing.who!==me().id&&!me().admin)||cxt.mode==='reply'&&(!target||target.deleted)){feedback('That comment is no longer available.');return false;}
  const selected=validTokens(text,d.mentions),eligible=new Set(members(projectOf(task)).map(u=>u.id));if(hasInvalidMention(selected,eligible,existing?.mentions)){feedback('A mentioned person is no longer an active project member. Remove that mention before sending.');return false;}
  const fingerprint=(value,tokens)=>sha256(JSON.stringify({text:value,mentions:tokens.map(({start,end,id,label})=>({start,end,id,label}))}));
  const before=existing?fingerprint(existing.text,existing.mentions||[]):null,after=fingerprint(text,selected),changed=!existing||before!==after;
  const hasEveryone=selected.some(m=>m.id==='everyone'),broadcast=changed&&hasEveryone&&!existing?.broadcastSent,rateKey=me().id+':'+projectOf(task).id;
  if(broadcast&&Date.now()-(broadcasts[rateKey]||0)<60000){feedback('Please wait a minute before mentioning everyone again.');return false;}
  if(production&&productionApi){
   // A new comment or reply leaves the box at once: what is typed next is a
   // new one, never joined to this one or sent with it again. It comes back
   // if it can't be sent. An edit stays until it is saved.
   const interaction=d.interactionId,leaves=!existing,pending={userId:me()?.id,taskId:task.id,mode:cxt.mode,target:cxt.target,text,mentions:structured(selected),revision:d.revision,interactionId:interaction,leaves};
   sendingComments.set(interaction,pending);if(leaves)emptyComposer(task);
   Promise.resolve(productionApi.saveComment({task,mode:cxt.mode,targetId:target?.id||null,commentId:existing?.id||null,revision:d.revision,text,mentions:selected,editorId:d.editorId,interactionId:interaction,unsent:(error)=>{if(leaves)returnUnsent(pending,error);}})).catch(()=>{}).finally(()=>sendingComments.delete(interaction));return false;
  }
  const c=existing||{id:id('comment'),who:me().id,ts:Date.now(),parentId:target?(target.parentId||target.id):null,replyToId:target?.id||null,notifiedRecipients:[]};
  c.text=text;c.mentions=selected;if(existing){if(changed){c.editedAt=Date.now();hooks.log?.(task,'edited a comment',{field:'comment-content:'+c.id,before,after});}}else(task.comments ||= []).push(c);
  const recipients=new Map();if(broadcast){for(const uid of eligible)recipients.set(uid,'everyone');broadcasts[rateKey]=Date.now();c.broadcastSent=true;}if(target)recipients.set(target.who,'reply');for(const m of selected)if(changed&&m.id!=='everyone')recipients.set(m.id,'mention');
  for(const [uid,reason] of recipients)if(!(c.notifiedRecipients||[]).includes(uid)){notify(c.id,task,[uid],reason,c.id,c.parentId||c.id);c.notifiedRecipients.push(uid);}
  persist();savedComment(task,c,cxt.mode,changed);return true;
 }
 // A comment being written when the session ended, kept for the same person's next sign-in.
 let resumedComment=null;
 // The texts being sent, by their interaction: typing more starts a new one.
 // A new comment or reply on its way `leaves` the box.
 const sendingComments=new Map();
 // New comments and replies that weren't saved, kept for their writer until
 // the box on their task page is empty. Each keeps its interaction, so
 // sending it again after an unknown result can't add it twice.
 const unsentComments=[];
 /** Whether a new comment from this person on `task` is on its way. */
 const commentsOnTheirWay=task=>[...sendingComments.values()].some(item=>item.leaves&&item.taskId===task.id&&item.userId===me()?.id);
 /** One draft from a comment that wasn't sent and the text typed after it. */
 function joined(first,second){const shift=first.text.length+2;return {text:`${first.text}\n\n${second.text}`,mentions:[...structured(first.mentions),...structured(second.mentions).map(m=>({...m,start:m.start+shift,end:m.end+shift}))]};}
 // Empty the box after its comment was sent, in the same mode, so what is
 // typed next is a new comment.
 function emptyComposer(task){
  commentEditor=null;editor(task);
  const input=document.getElementById('cmtIn');if(input)input.value='';
  closeMentions();feedback('');notifyHint(task);
 }
 /**
  * A new comment or reply wasn't saved. After a refusal nothing was saved,
  * so with its task page open it goes back in the box, ahead of anything
  * typed since. After an unknown result it may be saved already, so it is
  * never joined to other text: like a comment whose page is closed, it
  * waits, with its interaction, until the box on its page is empty.
  */
 function returnUnsent(pending,error){
  sendingComments.delete(pending.interactionId);
  const task=hooks?.task(pending.taskId),host=document.querySelector('[data-comment-task]');
  if(task&&me()?.id===pending.userId&&mountedTaskId===task.id&&canComment(task)&&host?.dataset.commentTask===task.id){
   capture();
   if(commentEditor?.text&&!error?.uncertain){
    const current=commentEditor,merged=joined(pending,current),shift=merged.text.length-current.text.length,input=document.getElementById('cmtIn');
    Object.assign(current,{text:merged.text,mentions:validTokens(merged.text,merged.mentions),interactionId:id('interaction')});
    if(input){const focused=document.activeElement===input,start=input.selectionStart,end=input.selectionEnd;input.value=merged.text;if(focused)input.setSelectionRange(start+shift,end+shift);}
    notifyHint(task);return;
   }
  }
  unsentComments.push(pending);returnComments();
 }
 /** Put the oldest comment that wasn't saved back, alone, once the box on its task page is empty. */
 function returnComments(){
  const userId=me()?.id;if(!userId||!unsentComments.length)return;
  // Anyone else never sees them.
  for(let index=unsentComments.length-1;index>=0;index--)if(unsentComments[index].userId!==userId)unsentComments.splice(index,1);
  const host=document.querySelector('[data-comment-task]'),task=hooks?.task(host?.dataset.commentTask);
  if(!task||mountedTaskId!==task.id||!canComment(task)||host.dataset.commentOwner!==userId)return;
  capture();if(commentEditor?.text)return;
  const index=unsentComments.findIndex(item=>item.taskId===task.id);if(index<0)return;
  const [pending]=unsentComments.splice(index,1),input=document.getElementById('cmtIn');
  const target=pending.target?task.comments?.find(c=>c.id===pending.target):null,keep=pending.mode==='comment'||!!target&&!target.deleted;
  const mode=keep?{mode:pending.mode,target:pending.target}:{mode:'comment',target:null},moved=commentMode.mode!==mode.mode||commentMode.target!==mode.target;
  commentMode=mode;commentEditor=null;
  Object.assign(editor(task),{text:pending.text,mentions:validTokens(pending.text,pending.mentions),interactionId:pending.interactionId});
  if(mode.mode==='reply')expanded.add(target.parentId||target.id);
  if(moved)refreshComments(task,true);else if(input){input.value=pending.text;notifyHint(task);}
 }
 /**
  * The comment text the person typed and hasn't sent; an edit counts once it
  * differs from the saved comment. `sending` says the text is on its way. A
  * new comment that left the box is not here: if it isn't saved, it comes
  * back by itself.
  */
 function commentDraft(){
  capture();
  const host=document.querySelector('[data-comment-task]'),task=hooks?.task(host?.dataset.commentTask);
  if(!task||!commentEditor?.text.trim()||host.dataset.commentOwner!==me()?.id)return null;
  if(commentMode.mode==='edit'&&commentEditor.text===task.comments?.find(c=>c.id===commentMode.target)?.text)return null;
  return {userId:me()?.id,taskId:task.id,mode:commentMode.mode,target:commentMode.target,text:commentEditor.text,mentions:structured(commentEditor.mentions),revision:commentEditor.revision,sending:sendingComments.has(commentEditor.interactionId)};
 }
 // Put a kept comment back once its task page shows; a reply or an edit waits for
 // its comment, and becomes a new comment when that comment is gone. Only the
 // person who wrote it gets it back.
 function resumeComment(){
  if(resumedComment&&resumedComment.userId!==me()?.id)resumedComment=null;
  const draft=resumedComment,task=draft&&hooks?.task(draft.taskId);
  if(!task||hooks.view()!=='task'||mountedTaskId!==task.id||!canComment(task)||!document.querySelector('[data-comment-task]'))return;
  const target=draft.target?task.comments?.find(c=>c.id===draft.target):null;
  if(draft.target&&!target&&!taskFeedState(task.id).loaded)return;
  resumedComment=null;
  const keep=target&&!target.deleted&&(draft.mode==='reply'||target.who===me()?.id||me()?.admin);
  commentMode=keep?{mode:draft.mode,target:draft.target}:{mode:'comment',target:null};commentEditor=null;
  Object.assign(editor(task),{text:draft.text,mentions:validTokens(draft.text,draft.mentions),revision:keep&&draft.mode==='edit'?draft.revision:null});
  if(keep&&draft.mode==='reply')expanded.add(target.parentId||target.id);
  refreshComments(task,true);
  const input=document.getElementById('cmtIn');if(input){input.focus({preventScroll:true});input.setSelectionRange(input.value.length,input.value.length);scrollWithinTask(input.closest('.collaboration-composer')||input);}
 }
 function mount(updateSnapshot=true){badge();mountCommentBodies();if(mention&&!mention.input.isConnected)closeMentions();const blockInput=document.getElementById('block-reason'),blockTask=hooks?.task(blockInput?.dataset.blockTask);if(blockTask)blockHint(blockTask);const host=document.querySelector('[data-comment-task]'),task=hooks?.task(host?.dataset.commentTask);if(task)notifyHint(task);if(updateSnapshot)feedSnapshot=task?feedSnapshotFor(task):null;productionApi?.mount?.({view:hooks?.view?.(),taskId:task?.id});
  if(pendingTarget&&hooks.view()==='task'){const p=pendingTarget;setTimeout(()=>{if(pendingTarget===p)pendingTarget=null;},5000);const el=p.blockId?[...document.querySelectorAll('[data-block-id]')].find(el=>el.dataset.blockId===p.blockId):[...document.querySelectorAll('[data-comment]')].find(el=>el.dataset.comment===p.commentId);if(el){pendingTarget=null;el.classList.add('comment-highlight');scrollWithinTask(el,true);el.focus({preventScroll:true});}}
  if(resumedComment)resumeComment();
  returnComments();
 }
 window.Collab={userById,blockReasonHtml,prepareBlock,blockSaved,blockText,canComment,feedHtml,composerHtml,inboxHtml,inboxNav,unread,taskEvent,mount,beforeRender,taskFeedState,retryTaskPage(id){return productionApi?.loadTaskPage?.(id);},retryInbox(){return productionApi?.loadInbox?.(filter);},
  bind(api,callbacks){app=api;hooks=callbacks;
   if(production&&window.OneloopCollaboration){
    productionApi=window.OneloopCollaboration.bind(app,hooks,{
     filter:()=>({projects:[...filter.projects],archived:filter.archived,unread:filter.unread}),
     feedback,
     unreadCount(value){inboxMeta.unreadCount=Number(value)||0;badge();},
     inboxBusy,
     inboxPage(meta){const {items,...state}=meta;inboxMeta={...inboxMeta,...state};inboxBusy(false);if(hooks.view()==='inbox')refreshInbox({...meta,items});else badge();},
     taskPage(taskId,meta){taskPages.set(taskId,meta);const task=hooks.task(taskId);if(!task)return;if(pendingTarget?.commentId){const target=task.comments?.find(c=>c.id===pendingTarget.commentId);if(target?.parentId)expanded.add(target.parentId);}if(mountedTaskId!==task.id)return;const next=feedSnapshotFor(task,meta),sameData=feedSnapshot?.taskId===task.id&&feedSnapshot.data===next.data;if(sameData&&feedSnapshot.meta===next.meta)return;feedSnapshot=next;if(commentMode.mode==='comment'){if(hooks.refreshActivity)hooks.refreshActivity(task.id,sameData);else refreshComments(task);mount(false);}},
     commentSaved(taskId,comment,result){const task=hooks.task(taskId);if(task)savedComment(task,comment,result.mode,result.changed,result);},
     commentAcknowledged(submitted,comment){if(commentEditor?.editorId===submitted.editorId&&commentEditor.revision===submitted.revision)commentEditor.revision=comment.revision;},
     commentEditor:currentCommentInput,
     acceptCommentLatest(submitted,comment){
      const input=currentCommentInput(submitted);if(!input)return;
      Object.assign(commentEditor,{text:comment.text,mentions:structured(comment.mentions),revision:comment.revision,interactionId:id('interaction')});
      input.value=comment.text;closeMentions();feedback('');notifyHint(submitted.task);
     },
     commentDeleted(taskId,commentId){const task=hooks.task(taskId);if(!task)return;refreshComments(task);const comment=task.comments?.find(c=>c.id===commentId);if(comment)app.offerUndo('Comment deleted',again=>productionApi?.restoreComment?.({task,comment,again}));else app.toast('Comment deleted');},
     commentRestored(taskId){const task=hooks.task(taskId);if(task){refreshComments(task);app.toast('Comment restored');}},
     canonicalTask(){const active=document.activeElement,editing=commentMode.mode!=='comment'||!!commentEditor?.text||!!blockEditor||active?.matches?.('input,textarea,select,[contenteditable="true"]')||document.querySelector('.modal,.pop');if(hooks.refreshBackground)hooks.refreshBackground();else if(!editing)hooks.refresh();},
     target(value){pendingTarget=value;if(value?.rootId)expanded.add(value.rootId);},
    });
    app.loadOlderActivity=(taskId)=>productionApi?.moreTask?.(taskId);
   }
   persist();
   // Leaving oneloop would lose comments kept for an empty box. While no one
   // is signed in, that is any of them, and any comment still on its way when
   // the session ended, which comes back if it isn't saved.
   if(production)window.Recovery?.trackUnsaved?.(()=>{const userId=me()?.id;return unsentComments.some(item=>!userId||item.userId===userId)||!userId&&[...sendingComments.values()].some(item=>item.leaves);});
   Object.assign(app,{
    commentDraft,restoreCommentDraft(draft){resumedComment=draft;mount(false);},
    addComment:post,replyComment:(taskId,target)=>setMode(taskId,'reply',target),editComment:(taskId,target)=>setMode(taskId,'edit',target),
    toggleCommentText(taskId,commentId){const comment=hooks.task(taskId)?.comments?.find(item=>item.id===commentId);if(!comment||comment.deleted)return;const key=commentBodyKey(comment);expandedCommentBodies.has(key)?expandedCommentBodies.delete(key):expandedCommentBodies.add(key);sizeCommentBodies();},
    cancelCommentMode(taskId){const task=hooks.task(taskId),previous=commentMode;commentEditor=null;commentMode={mode:'comment',target:null};refreshComments(task,true);const row=[...document.querySelectorAll('[data-comment]')].find(el=>el.dataset.comment===previous.target),focus=row?.querySelector(previous.mode==='edit'?'.comment-menu-button':'.reply-action')||document.getElementById('cmtIn');focus?.focus({preventScroll:true});},
    toggleReplies(taskId,rootId){if(commentMode.mode==='edit'&&hooks.task(taskId)?.comments.find(c=>c.id===commentMode.target)?.parentId===rootId)return;const open=!expanded.has(rootId);open?expanded.add(rootId):expanded.delete(rootId);const task=hooks.task(taskId),thread=[...document.querySelectorAll('[data-thread-root]')].find(el=>el.dataset.threadRoot===rootId),button=[...document.querySelectorAll('[data-reply-root]')].find(el=>el.dataset.replyRoot===rootId),root=task?.comments.find(c=>c.id===rootId);if(!thread||!button||!root){refreshComments(task);return;}thread.classList.toggle('is-expanded',open);thread.setAttribute('aria-hidden',String(!open));thread.inert=!open;button.setAttribute('aria-expanded',String(open));const replies=task.comments.filter(c=>c.parentId===rootId).sort(chronological);setHTML(button,replySummary(task,root,replies,open));if(open)(globalThis.requestAnimationFrame||setTimeout)(()=>sizeCommentBodies());},
    commentMenu(ev,taskId,commentId){const task=hooks.task(taskId),comment=task?.comments.find(c=>c.id===commentId);if(!comment||comment.deleted||!canComment(task)||comment.who!==me()?.id&&!me()?.admin)return;const r=ev.currentTarget.getBoundingClientRect();app._openMenu([{label:'Edit',icon:commentIcons.edit,fn:()=>{app.closeOverlays();setMode(taskId,'edit',commentId);}},{label:'Delete',icon:commentIcons.remove,danger:true,fn:()=>{app.closeOverlays();app.deleteComment(taskId,commentId);}}],r.right,r.bottom+4,{commentId,trigger:ev.currentTarget});},
    jumpToComment(taskId,commentId){const task=hooks.task(taskId),comment=task?.comments.find(c=>c.id===commentId);if(!comment)return;if(comment.parentId&&!expanded.has(comment.parentId)){expanded.add(comment.parentId);refreshComments(task);}const el=[...document.querySelectorAll('[data-comment]')].find(el=>el.dataset.comment===commentId);if(el){el.classList.add('comment-highlight');el.focus({preventScroll:true});scrollWithinTask(el,true);}},
    deleteComment(taskId,commentId){const task=hooks.task(taskId),c=task?.comments?.find(c=>c.id===commentId);if(!task||!c||c.deleted){app.toast('This comment is no longer available','error');return;}if(!canComment(task)||c.who!==me().id&&!me().admin){app.toast('You no longer have permission to delete this comment','error');return;}hooks.confirm({title:'Delete comment?',text:production?'Replies will remain. You can undo this right after.':'Replies will remain. The comment text and its inbox excerpts will be removed.',action:'Delete comment',confirm:()=>{if(hooks.task(taskId)!==task||c.deleted){app.toast('This comment is no longer available','error');return;}if(!canComment(task)||c.who!==me().id&&!me().admin){app.toast('You no longer have permission to delete this comment','error');return;}if(production&&productionApi){productionApi.deleteComment({task,comment:c});return;}c.deleted=true;c.text='';c.mentions=[];c.deletedAt=Date.now();hooks.log?.(task,'removed a comment');const saved=persist();refreshComments(task);if(saved)app.toast('Comment deleted');}});},
    delComment(taskId,index){const c=hooks.task(taskId)?.comments?.[index];if(c)app.deleteComment(taskId,c.id);},
    blockReasonInput(ev,taskId){const task=hooks.task(taskId);if(!task||!hooks.canBoard(task))return;updateText(task,ev.currentTarget.value,'block');blockFeedback('');suggest(ev.currentTarget,task,'block');blockHint(task);},
    commentInput(ev,taskId){const task=hooks.task(taskId);if(!task)return;updateText(task,ev.currentTarget.value);feedback('');suggest(ev.currentTarget,task);notifyHint(task);},
    commentKey(ev){
      if(ev.defaultPrevented||ev.isComposing||ev.keyCode===229)return;
      if(ev.key==='Enter'&&ev.repeat){ev.preventDefault();return;}
      if(mention&&mention.input===ev.currentTarget){
        if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();closeMentions();}
        else if(['ArrowDown','ArrowUp'].includes(ev.key)){ev.preventDefault();mention.index=(mention.index+(ev.key==='ArrowDown'?1:-1)+mention.options.length)%mention.options.length;paintMentions();}
        else if(ev.key==='Enter'&&ev.shiftKey){closeMentions();}
        else if(['Enter','Tab'].includes(ev.key)){ev.preventDefault();pickMention(mention.index);}
        return;
      }
      const actionForm=ev.currentTarget.closest('form[data-block-action]');
      if(actionForm&&ev.key==='Enter'&&!ev.shiftKey&&!ev.altKey){ev.preventDefault();const submit=actionForm.querySelector('button[type="submit"],button:not([type])');if(!submit?.disabled)actionForm.requestSubmit();return;}
      const composer=ev.currentTarget.closest('.collaboration-composer');
      if(composer&&ev.key==='Escape'&&commentMode.mode!=='comment'){ev.preventDefault();ev.stopPropagation();app.cancelCommentMode(composer.dataset.commentTask);return;}
      if(!composer||ev.key!=='Enter'||ev.shiftKey||ev.altKey)return;
      ev.preventDefault();
      app.addComment(composer.dataset.commentTask);
    },

    inboxFilter(name,value){if(!['projects','archived','unread'].includes(name))return;if(name==='projects'){if(!Array.isArray(value))return;filter.projects=[...new Set(value)].filter(id=>hooks.projects().some(p=>p.id===id));}else {if(filter[name]===value)return;filter[name]=value;}filter.limit=50;if(production&&productionApi){inboxMeta.loaded=false;productionApi.loadInbox(filter);return;}refreshInbox();},
    retryInbox(){return productionApi?.loadInbox?.(filter);},
    moreInbox(){if(production&&productionApi){productionApi.moreInbox(filter);return;}filter.limit+=50;refreshInbox();},
    setNotificationRead(id,unread){if(!inboxWritable())return;const n=own().find(n=>n.id===id);if(!n)return;if(production&&productionApi){productionApi.setRead(id,unread);return;}n.readAt=unread?null:Date.now();persist();refreshInbox();},
    archiveNotification(id){if(!inboxWritable())return;const n=own().find(n=>n.id===id);if(!n)return;if(production&&productionApi){productionApi.setArchived(id,!!n.archivedAt);return;}n.archivedAt=n.archivedAt?null:Date.now();if(n.archivedAt)n.readAt ||= Date.now();persist();refreshInbox();},
    inboxBulk(action){if(!['read','archive'].includes(action)||action==='archive'&&filter.archived||!inboxWritable())return;if(production&&productionApi){productionApi.bulk(action,filter);return;}for(const n of matching()){if(action==='read')n.readAt=Date.now();else if(action==='archive'){n.archivedAt=Date.now();if(n.archivedAt)n.readAt ||= Date.now();}}persist();refreshInbox();},
    openNotification(id){const n=own().find(n=>n.id===id);if(!n)return;if(production&&productionApi){productionApi.openNotification(n);return;}if(window.Recovery?.connection!=='offline'){if(!inboxWritable())return;n.readAt ||= Date.now();persist();badge();}const task=hooks.task(n.taskId);if(!task||!hooks.canRead(n.projectId)||!D.projects.some(p=>p.id===n.projectId)){app.toast('This item is no longer available','info');hooks.refresh();return;}if(n.rootId)expanded.add(n.rootId);pendingTarget={commentId:n.commentId,blockId:n.blockId};if(n.blockId)hooks.revealBlockActivity?.(task.id,n.blockId);app.openTask(task.id);}
   });
  }
 };
 window.addEventListener('hashchange',closeMentions);
 document.addEventListener('pointerdown',e=>{if(mention&&!e.target.closest('.mention-picker')&&e.target!==mention.input)closeMentions();});
 document.addEventListener('scroll',e=>{if(mention&&!e.target.closest?.('.mention-picker'))closeMentions();},true);
 if(!production)window.addEventListener('storage',e=>{if(e.key!==STORE)return;try{const value=JSON.parse(e.newValue);if(Array.isArray(value?.notifications)){D.notifications=value.notifications;badge();if(hooks?.view()==='inbox')hooks.refresh();}}catch{}});
})();
