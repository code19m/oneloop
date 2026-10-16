// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* A task's attachments: the list on its page, uploads, order and retention,
   and opening them in the file dialog. */

import { errorMessage, retryableFailure } from '../../src/app/action-feedback.js';
import { UIMotion } from '../../src/app/motion.js';
import {
  byteSize as size, canPreview, closePreview, displayText, fileExtension as extension, fileIcons as icons, forgetPreview,
  previewFile, shownPreview,
} from '../../src/features/files/preview.js';
import { UIAction, esc, formatInstant, setHTML } from './format.js';
import { App, D, canReadTask, epicById, hasPermission, recovery, runtime, taskById, trackById } from './model.js';
import { askConfirmation } from './overlays.js';

const maxFile=()=>D.limits.maxAttachmentBytes,maxFiles=()=>D.limits.maxAttachmentsPerTask;
const jobs=[],loading=new Map(),refreshPending=new Map(),retentionPending=new Set(),reorderPending=new Set();
// The attachment lists read from the server, or changed here since. Reading
// a task replaces its object but keeps its list, so the list stays read; a
// task that comes back without its list, as after a Board search, reads it again.
let loaded=new WeakSet(),next=0;
// Tasks whose attachments this account has read. Reading them again, after a
// live update or a refresh replaced the task, is passive: it never keeps an
// idle session open.
let attachmentsRead=new Set();
const transport=()=>runtime().transport.api;
/** Whether the person may change `taskId`'s attachments. */
const canEdit=taskId=>hasPermission('manage_board',trackById(epicById(taskById(taskId)?.epicId)?.trackId)?.projectId);
const escape=value=>esc(displayText(value));
const available=task=>(task.attachments||[]).filter(f=>!f.state||f.state==='available');

const serverFile=file=>({id:file.id,name:file.name,size:file.size,type:file.mediaType,previewKind:file.previewKind,checksum:file.checksum,ephemeral:file.isEphemeral,uploadedBy:file.uploadedBy,uploadedAt:file.uploadedAt*1000,lastAccessAt:file.lastAccessedAt*1000,state:file.state,revision:file.revision,url:file.contentUrl||file.downloadUrl,downloadUrl:file.downloadUrl,contentUrl:file.contentUrl,thumbnailUrl:file.thumbnailUrl,sourceUrl:file.sourceUrl,htmlPreviewUrl:file.htmlPreviewUrl});
// A live update replaces task objects, so a reply finds its task again by id.
const sameTask=(taskId,task)=>{const current=taskById(taskId);return current&&(current===task||!!current.internalId&&current.internalId===task.internalId)?current:null;};
/** Give `task` the attachment list `files`, as the server lists it or as changed here. */
function setFiles(task,files){task.attachments=files;loaded.add(files);}
function loadAttachments(taskId,force=false,background=false){
  const api=transport(),task=taskById(taskId);
  if(!task||!force&&loaded.has(task.attachments))return;
  const sessionId=D.session?.id,internalId=task.internalId||taskId;
  background||=attachmentsRead.has(internalId);
  if(loading.has(taskId)){
    if(force)refreshPending.set(taskId,(refreshPending.get(taskId)??true)&&background);
    return loading.get(taskId);
  }
  if(force)loaded.delete(task.attachments);
  // A task detail read can replace its projection while this request is in flight.
  const currentTask=()=>{
    const current=taskById(taskId);
    return current&&D.session?.id===sessionId&&(current.internalId||taskId)===internalId?current:null;
  };
  const request=api.attachments(internalId,{background}).then(result=>{
    const current=currentTask();if(!current)return;
    setFiles(current,(result.items||[]).map(serverFile));attachmentsRead.add(internalId);
    const shown=shownPreview();
    if(shown?.key===taskId){
      const file=current.attachments.find(item=>item.id===shown.fileId);
      if(!file||file.state!=='available')closePreview();else syncRetention(taskId,file);
    }
    refreshAttachments(taskId);
  }).catch(error=>{
    const current=currentTask();if(!current)return;
    if([401,403,404].includes(error?.status)){
      current.attachments=[];
      if(shownPreview()?.key===taskId)closePreview();
      refreshAttachments(taskId);
      // Lost access during a live refresh: the page itself says what happened.
      if(background)return;
    }
    App.toast(errorMessage(error,'Attachments could not be loaded.'),'error');
  }).finally(()=>{
    if(loading.get(taskId)!==request)return;
    loading.delete(taskId);
    const pending=refreshPending.get(taskId);
    if(refreshPending.delete(taskId))loadAttachments(taskId,true,pending);
  });
  loading.set(taskId,request);
}
/**
 * Load the attachments of task `id` each time its page opens (`opened`), and
 * when the task lost its list, and show its uploads, after its page draws.
 */
export function mountAttachments(id,opened=false){
  followChanges();loadAttachments(id,opened);
  const host=document.querySelector('.upload-list');if(!host)return;
  const zone=host.closest('.task-attachments');if(zone)zone.dataset.uploadTask=id;
  const current=jobs.filter(job=>job.taskId===id);
  host.querySelectorAll('[data-upload-id]').forEach(el=>{if(!current.some(j=>j.id===el.dataset.uploadId))el.remove();});
  for(const job of current){let row=host.querySelector(`[data-upload-id="${esc(job.id)}"]`);if(!row){row=document.createElement('div');row.className='upload-row';row.dataset.uploadId=job.id;setHTML(row,'<div class="upload-copy"><span class="upload-name"></span><span class="upload-state"></span><progress max="100"></progress></div><button type="button" class="btn quiet" data-upload-action="cancel">Cancel</button><button type="button" class="btn quiet" data-upload-action="retry">Retry</button><button type="button" class="btn quiet" data-upload-action="remove">Dismiss</button>');host.append(row);UIMotion.enter(row);}
    row.querySelector('.upload-name').textContent=displayText(job.file.name);const status=row.querySelector('.upload-state');status.textContent=job.error||(job.state==='uploading'?`Uploading ${job.progress}%`:job.state==='cancelled'?'Upload cancelled':'Uploaded');status.setAttribute('role',job.state==='error'?'alert':'status');
    const progress=row.querySelector('progress');progress.value=job.progress;progress.hidden=job.state!=='uploading';progress.setAttribute('aria-label',displayText(job.file.name)+' upload');
    row.querySelector('[data-upload-action="cancel"]').hidden=job.state!=='uploading';row.querySelector('[data-upload-action="retry"]').hidden=!['error','cancelled'].includes(job.state)||job.validation;row.querySelector('[data-upload-action="remove"]').hidden=job.state==='uploading';
  }
  host.onclick=event=>{const button=event.target.closest('[data-upload-action]');if(!button)return;const job=jobs.find(j=>j.id===button.closest('[data-upload-id]').dataset.uploadId);if(!job)return;const action=button.dataset.uploadAction;if(action==='cancel'){job.cancelled=true;job.state='cancelled';job.reader?.abort();mountAttachments(id);}else if(action==='retry')start(job);else{jobs.splice(jobs.indexOf(job),1);loadAttachments(id,true);mountAttachments(id);}};
}
function reject(job,message,validation=false){job.state='error';job.error=message;job.validation=validation;mountAttachments(job.taskId);}
function start(job){
  const task=taskById(job.taskId);if(!task||!canEdit(job.taskId)||D.session?.userId!==job.owner){reject(job,'You no longer have permission to attach this file.');return;}
  if(available(task).length+jobs.filter(j=>j!==job&&j.taskId===job.taskId&&j.state==='uploading').length>=maxFiles()){reject(job,`A task can have at most ${maxFiles()} available attachments.`,true);return;}
  if(job.file.size>maxFile()){reject(job,`File exceeds ${maxFile()/1024/1024} MB.`,true);return;}
  if(recovery.connection==='offline'){reject(job,'The server is unreachable. Retry when connected.');return;}
  upload(job,task);
}
async function upload(job,task){
  job.cancelled=false;job.state='uploading';job.progress=0;job.error='';job.validation=false;const controller=new AbortController();job.reader={abort:()=>controller.abort()};mountAttachments(job.taskId);
  try{
    // Leaving the page while a file uploads would lose it.
    const sending=transport().uploadAttachment(task.internalId||job.taskId,{file:job.file,ephemeral:job.ephemeral,idempotencyKey:job.idempotencyKey ||= crypto.randomUUID(),signal:controller.signal,onProgress:percent=>{if(job.state==='uploading'&&!job.cancelled){job.progress=percent;mountAttachments(job.taskId);}}});
    recovery.trackWrite(sending);const value=await sending;
    if(job.cancelled)return;const current=sameTask(job.taskId,task);if(!current)throw new Error('The task is no longer available.');
    const mapped=serverFile(value),index=(current.attachments||[]).findIndex(file=>file.id===mapped.id);if(index>=0)current.attachments[index]=mapped;else(current.attachments ||= []).push(mapped);
    loaded.add(current.attachments);jobs.splice(jobs.indexOf(job),1);refreshAttachments(job.taskId);App.toast('Attachment added');
  }catch(error){if(job.cancelled)return;reject(job,errorMessage(error,'Upload failed. Please try again.'),error?.status===400&&error?.code==='validation_failed');}
}
function editableAttachment(taskId,fileId,includeCleaned=false){
  const task=taskById(taskId),file=(task?.attachments||[]).find(f=>f.id===fileId&&(!f.state||f.state==='available'||includeCleaned&&f.state==='cleaned'));
  if(!file){App.toast('This attachment is no longer available','error');return null;}
  if(!canEdit(taskId)){App.toast('You no longer have permission to change attachments','error');return null;}
  if(!recovery.ensureOnline())return null;
  return file;
}
function setTemporary(taskId,fileId,value){
  const task=taskById(taskId),file=editableAttachment(taskId,fileId);if(!file)return false;if(retentionPending.has(fileId)){App.toast('This retention change is still being saved.','info');return false;}
  const before=!!file.ephemeral;if(before===!!value)return true;file.ephemeral=!!value;syncRetention(taskId,file);
  retentionPending.add(fileId);transport().updateAttachment(fileId,{isEphemeral:!!value,expectedRevision:file.revision}).then(saved=>{const current=sameTask(taskId,task)?.attachments?.find(item=>item.id===fileId);if(!current)return;Object.assign(current,serverFile(saved));syncRetention(taskId,current);App.toast(current.ephemeral?'Attachment marked temporary':'Attachment marked permanent');}).catch(error=>{const current=sameTask(taskId,task)?.attachments?.find(item=>item.id===fileId);if(current){current.ephemeral=before;syncRetention(taskId,current);}if(error?.status===409||error?.uncertain)loadAttachments(taskId,true);App.toast(errorMessage(error,'Retention could not be changed.'),'error');}).finally(()=>retentionPending.delete(fileId));
  return true;
}
// A row's switch acts through its data-action arguments. Actions never run in
// the untrusted preview body, so the preview's switch gets its handler here.
function syncRetention(taskId,file){
  document.querySelectorAll('[data-attachment-id]').forEach(row=>{if(row.dataset.attachmentId!==file.id)return;const toggle=row.querySelector('.retention-switch');if(toggle){toggle.setAttribute('aria-checked',String(file.ephemeral));toggle.dataset.args=JSON.stringify([taskId,file.id,!file.ephemeral]);}});
  if(shownPreview()?.fileId===file.id){const toggle=document.querySelector('[data-file-ephemeral]');if(toggle){toggle.setAttribute('aria-checked',String(file.ephemeral));toggle.onclick=()=>setTemporary(taskId,file.id,!file.ephemeral);}const value=document.querySelector('[data-file-retention]');if(value)value.textContent=file.ephemeral?'Temporary':'Permanent';}
}
function retentionSwitch(taskId,file,previewControl=false){
  return `<button type="button" class="retention-switch" role="switch" aria-checked="${!!file.ephemeral}" aria-label="Temporary: ${escape(file.name)}" title="Allow this file to be removed when storage is low" ${previewControl?'data-file-ephemeral':UIAction('setAttachmentTemporary',taskId,file.id,!file.ephemeral)}>${icons.clock}<span>Temporary</span><span class="retention-track" aria-hidden="true"></span></button>`;
}
function openAttachment(event,taskId,fileId){
  const file=taskById(taskId)?.attachments?.find(f=>f.id===fileId);
  if(file&&canPreview(file)){event.preventDefault();previewAttachment(taskId,fileId);return false;}
  return download(event,taskId,fileId);
}
function downloadOriginal(taskId,fileId){
  const file=taskById(taskId)?.attachments?.find(f=>f.id===fileId);
  if(!download({preventDefault(){}},taskId,fileId))return;
  const link=document.createElement('a');link.href=file.downloadUrl||file.url;link.download=displayText(file.name);link.click();
}
function attachmentHeader(task,editable){
  const hasAttachments=(task.attachments||[]).some(file=>file.state!=='removed');
  const dropArea=editable?`<button type="button" class="attachment-dropzone${hasAttachments?' is-compact':''}" ${UIAction('chooseAttachments')} aria-label="Drag &amp; drop or browse files"><span class="attachment-drop-icon" aria-hidden="true">${icons.plus}</span><span class="attachment-drop-copy"><span><span class="attachment-drop-title">Drag &amp; drop</span><span class="attachment-browse"> or <span class="attachment-choose">browse files</span></span></span><small class="attachment-drop-limit">${icons.info}<span>Max file size: ${maxFile()/1024/1024} MB</span></small></span></button>`:'';
  return `<div class="attachment-heading"><div class="attachment-heading-copy"><h2>Attachments</h2></div></div>${dropArea}`;
}
function attachmentName(name){
  const dot=name.lastIndexOf('.'),hasExtension=dot>0&&name.length-dot<=13;
  return `<bdi class="attachment-name-base">${escape(hasExtension?name.slice(0,dot):name)}</bdi>${hasExtension?`<bdi class="attachment-name-extension">${escape(name.slice(dot))}</bdi>`:''}`;
}
function renderAttachments(task,editable){
  const rows=(task.attachments||[]).filter(f=>f.state!=='removed').map(f=>{
    const cleaned=f.state==='cleaned',previewable=!cleaned&&canPreview(f),ext=extension(f),action=previewable?'Preview':'Download',link=`href="${escape(previewable?(f.contentUrl||f.url):(f.downloadUrl||f.url||'#'))}" download="${escape(f.name)}" ${UIAction('openAttachment',UIAction.event,task.id,f.id)}`;
    const image=previewable&&(f.previewKind==='image'||!Object.hasOwn(f,'previewKind')&&['png','jpg','jpeg','webp','gif','avif'].includes(ext))&&f.url;
    const thumb=`${image?`<img src="${escape(f.thumbnailUrl||f.url)}" alt="" loading="lazy">`:`${icons.document}<span>${escape(ext.slice(0,5).toUpperCase())}</span>`}${cleaned?'':`<span class="thumbnail-action" aria-hidden="true">${previewable?icons.preview:icons.download}</span>`}`;
    const thumbnail=cleaned?`<span class="attachment-thumbnail" aria-hidden="true">${thumb}</span>`:`<a class="attachment-thumbnail${image?' has-image':''}" ${link} aria-label="${action} ${escape(f.name)}" title="${action}">${thumb}</a>`;
    const title=cleaned?`<span class="attachment-title" data-tip="${escape(f.name)}" data-tip-overflow>${attachmentName(f.name)}</span>`:`<a class="attachment-title" data-tip="${escape(f.name)}" data-tip-overflow aria-label="${escape(f.name)}" ${link}>${attachmentName(f.name)}</a>`;
    const downloadAction=cleaned?`<button type="button" class="btn file-download" disabled aria-label="Download ${escape(f.name)} unavailable" title="Temporary file cleaned up">${icons.download}<span class="attachment-action-label">Download</span></button>`:`<a class="btn file-download" href="${escape(f.downloadUrl||f.url||'#')}" download="${escape(f.name)}" aria-label="Download ${escape(f.name)}" ${UIAction('downloadAttachment',UIAction.event,task.id,f.id)}>${icons.download}<span class="attachment-action-label">Download</span></a>`;
    return `<article class="attachment-card${cleaned?' is-cleaned':''}" data-attachment-id="${escape(f.id)}"><div class="attachment-summary">${editable?`<button type="button" class="attachment-grip" data-reorder-task="${esc(task.id)}" data-reorder-file="${escape(f.id)}" aria-label="Reorder ${escape(f.name)}" title="Drag to reorder · Arrow keys to move">${icons.grip}</button>`:''}${thumbnail}<div class="attachment-identity">${title}<div class="attachment-meta">${cleaned?`<span class="attachment-cleaned-status" title="Temporary file removed during storage cleanup">${icons.clock}Cleaned up</span>`:`<span>${size(f.size)}</span>${!previewable?'<span>Download only</span>':''}`}</div></div></div><div class="attachment-actions">${!cleaned?(editable?retentionSwitch(task.id,f):`<span class="attachment-retention-label">${f.ephemeral?'Temporary':'Permanent'}</span>`):''}${downloadAction}${editable?`<button type="button" class="btn icon file-remove" aria-label="Delete ${escape(f.name)} attachment" title="Delete attachment" ${UIAction('delAttachment',task.id,task.attachments.indexOf(f))}>${icons.remove}</button>`:''}</div></article>`;
  }).join('');
  return rows||(!editable?'<div class="attachment-empty">No attachments yet</div>':'');
}
function previewAttachment(taskId,fileId){
  if(!D.session||!canReadTask(taskById(taskId))){App.toast('This file is unavailable','error');return;}const task=taskById(taskId),file=task?.attachments?.find(f=>f.id===fileId);if(!file){App.toast('This attachment is no longer available','error');return;}
  if(file.state&&file.state!=='available'){App.toast(file.state==='cleaned'?'This temporary file was cleaned up':'This attachment is no longer available','info');return;}
  if(!canPreview(file)){downloadOriginal(taskId,fileId);return;}
  const editable=canEdit(taskId);
  const details=`<dt>File name</dt><dd>${escape(file.name)}</dd><dt>Type</dt><dd>${escape(file.name.split('.').pop().toUpperCase())}</dd><dt>Size</dt><dd>${size(file.size)}</dd><dt>Uploaded by</dt><dd>${escape(D.users.find(u=>u.id===file.uploadedBy)?.name||'Unavailable')}</dd><dt>Uploaded</dt><dd>${file.uploadedAt?formatInstant(file.uploadedAt):'Unavailable'}</dd><dt>Retention</dt><dd class="file-retention-control"><span data-file-retention>${file.ephemeral?'Temporary':'Permanent'}</span>${editable?`${retentionSwitch(taskId,file,true)}<span class="retention-help"><button type="button" class="btn icon" aria-label="About temporary files" aria-expanded="false" aria-describedby="retention-help-text">${icons.info}</button><span id="retention-help-text" role="tooltip">Allow this file to be removed when storage is low.</span></span>`:''}</dd>`;
  previewFile({file,files:available(task),details,key:taskId,canRead:()=>canReadTask(taskById(taskId)),session:()=>D.session,open:id=>previewAttachment(taskId,id),download:event=>download(event,taskId,fileId)});
  if(editable)syncRetention(taskId,file);
}
function download(event,taskId,fileId){const file=taskById(taskId)?.attachments?.find(f=>f.id===fileId);if(!D.session||!canReadTask(taskById(taskId))||!(file?.downloadUrl||file?.url)||file.state&&file.state!=='available'){event.preventDefault();App.toast('File unavailable','error');return false;}return true;}
// Undo of a deletion, at the revision the deletion left. Every try has the
// same key, so a retry after an unknown result applies once, and a failure
// worth trying again goes to `again`, which offers Undo again.
function restoreAttachment(taskId,task,file,again){
  transport().restoreAttachment(file.id,{expectedRevision:file.revision+1,idempotencyKey:file.restoreKey ||= crypto.randomUUID()}).then(()=>{if(sameTask(taskId,task))loadAttachments(taskId,true);App.toast('Attachment restored');}).catch(error=>{if(sameTask(taskId,task))loadAttachments(taskId,true);const message=errorMessage(error,'Attachment could not be restored.');if(again&&retryableFailure(error))again(message);else App.toast(message,'error');});
}
function reorderAttachment(taskId,fileId,targetId,after=false){
  const file=editableAttachment(taskId,fileId,true),task=taskById(taskId);if(!file||fileId===targetId)return false;if(reorderPending.has(fileId)){App.toast('This attachment is still being reordered.','info');return false;}
  const target=task.attachments.find(f=>f.id===targetId&&f.state!=='removed');if(!target)return false;
  const before=task.attachments.map(f=>f.id),ordered=task.attachments.filter(f=>f.id!==fileId),index=ordered.indexOf(target)+(after?1:0);ordered.splice(index,0,file);
  if(ordered.every((f,i)=>f===task.attachments[i]))return false;
  setFiles(task,ordered);
  reorderPending.add(fileId);transport().reorderAttachment(task.internalId||taskId,{attachmentId:fileId,targetId,after,expectedRevision:file.revision,idempotencyKey:crypto.randomUUID()}).then(result=>{const current=sameTask(taskId,task);if(!current)return;setFiles(current,(result.items||[]).map(serverFile));refreshAttachments(taskId);App.toast('Attachment order updated');}).catch(error=>{const current=sameTask(taskId,task);if(current&&current.attachments===ordered){setFiles(current,before.map(id=>ordered.find(f=>f.id===id)).filter(Boolean));refreshAttachments(taskId);}if(error?.status===409||error?.uncertain)loadAttachments(taskId,true);App.toast(errorMessage(error,'Attachment order could not be updated.'),'error');}).finally(()=>reorderPending.delete(fileId));
  refreshAttachments(taskId);
  [...document.querySelectorAll('[data-reorder-file]')].find(el=>el.dataset.reorderFile===fileId)?.focus({preventScroll:true});return true;
}
let sorting=null;
function stopSorting(){
  if(!sorting)return;const current=sorting;sorting=null;cancelAnimationFrame(current.frame);current.row.classList.remove('is-sorting');current.ghost?.remove();current.marker?.remove();document.body.classList.remove('attachment-sorting');
  try{current.handle.releasePointerCapture(current.pointerId);}catch{}
}
function locateSortTarget(){
  const s=sorting;if(!s?.active)return;
  const zone=s.row.closest('.task-attachments'),bounds=zone?.getBoundingClientRect();
  if(!bounds||!s.row.isConnected){stopSorting();return;}
  s.ghost.style.left=Math.min(innerWidth-210,Math.max(8,s.x+12))+'px';s.ghost.style.top=Math.max(8,Math.min(innerHeight-48,s.y+12))+'px';
  s.target=null;s.marker.hidden=true;
  if(s.x<bounds.left||s.x>bounds.right||s.y<bounds.top||s.y>bounds.bottom)return;
  const candidates=[...zone.querySelectorAll('[data-attachment-id]')].filter(row=>row!==s.row);
  const target=candidates.find(row=>s.y<row.getBoundingClientRect().bottom)||candidates.at(-1);if(!target)return;
  const r=target.getBoundingClientRect();s.target=target.dataset.attachmentId;s.after=s.y>r.top+r.height/2;
  s.marker.hidden=false;Object.assign(s.marker.style,{left:r.left+'px',top:(s.after?r.bottom+4:r.top-4)+'px',width:r.width+'px'});
}
function scrollSort(){
  const s=sorting;if(!s?.active)return;if(!s.row.isConnected){stopSorting();return;}
  const panel=s.row.closest('.task-page'),r=panel?.getBoundingClientRect();
  if(r&&s.x>=r.left&&s.x<=r.right){const amount=s.y<r.top+56?-10:s.y>r.bottom-56?10:0;if(amount)panel.scrollTop+=amount;}
  locateSortTarget();if(sorting)s.frame=requestAnimationFrame(scrollSort);
}
document.addEventListener('pointerdown',event=>{
  const handle=event.target.closest?.('#app .task-attachments [data-reorder-file]');if(!handle||event.button!==0||handle.closest('[inert]')||document.querySelector('.file-overlay,.confirmation-layer,.modal,.peek')||!canEdit(handle.dataset.reorderTask))return;
  stopSorting();sorting={handle,row:handle.closest('[data-attachment-id]'),taskId:handle.dataset.reorderTask,fileId:handle.dataset.reorderFile,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY};
  handle.focus({preventScroll:true});try{handle.setPointerCapture(event.pointerId);}catch{}
});
document.addEventListener('pointermove',event=>{
  const s=sorting;if(!s||event.pointerId!==s.pointerId)return;s.x=event.clientX;s.y=event.clientY;
  if(!s.active&&Math.hypot(s.x-s.startX,s.y-s.startY)<6)return;
  event.preventDefault();if(!s.active){s.active=true;s.row.classList.add('is-sorting');document.body.classList.add('attachment-sorting');s.ghost=document.createElement('div');s.ghost.className='attachment-drag-label';s.ghost.textContent=s.row.querySelector('.attachment-title').textContent;s.ghost.setAttribute('aria-hidden','true');s.marker=document.createElement('div');s.marker.className='attachment-insert-marker';s.marker.setAttribute('aria-hidden','true');document.body.append(s.ghost,s.marker);scrollSort();}locateSortTarget();
},{passive:false});
document.addEventListener('pointerup',event=>{const s=sorting;if(!s||event.pointerId!==s.pointerId)return;locateSortTarget();stopSorting();if(s.active&&s.target)reorderAttachment(s.taskId,s.fileId,s.target,s.after);});
document.addEventListener('pointercancel',stopSorting);window.addEventListener('blur',stopSorting);window.addEventListener('hashchange',stopSorting);
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&sorting){event.preventDefault();event.stopImmediatePropagation();stopSorting();return;}
  const handle=event.target.closest?.('#app .task-attachments [data-reorder-file]');if(!handle||handle.closest('[inert]')||document.querySelector('.file-overlay,.confirmation-layer,.modal,.peek')||!canEdit(handle.dataset.reorderTask)||!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  event.preventDefault();const task=taskById(handle.dataset.reorderTask),files=(task?.attachments||[]).filter(f=>f.state!=='removed'),index=files.findIndex(f=>f.id===handle.dataset.reorderFile),next=event.key==='Home'?0:event.key==='End'?files.length-1:index+(event.key==='ArrowDown'?1:-1),target=files[next];if(target)reorderAttachment(task.id,handle.dataset.reorderFile,target.id,next>index);
},true);
const fileDrag=event=>Array.from(event.dataTransfer?.types||[]).includes('Files')||!!event.dataTransfer?.files?.length;
function setDropHighlight(activeZone){
  document.querySelectorAll('.task-attachments.is-file-dragover').forEach(zone=>{
    if(zone===activeZone)return;zone.classList.remove('is-file-dragover');const title=zone.querySelector('.attachment-drop-title');if(title)title.textContent='Drag & drop';
  });
  if(activeZone&&!activeZone.classList.contains('is-file-dragover')){activeZone.classList.add('is-file-dragover');const title=activeZone.querySelector('.attachment-drop-title');if(title)title.textContent='Release to upload';}
}
function clearDropHighlight(){setDropHighlight(null);}
function dropZone(event){
  const zone=document.querySelector('.task-attachments[data-upload-task]');
  return zone&&zone.contains(event.target)&&!document.getElementById('app')?.inert&&!document.querySelector('.modal,.file-overlay,.confirmation-layer,.peek,.menu')?zone:null;
}
document.addEventListener('dragover',event=>{
  if(!fileDrag(event))return;event.preventDefault();event.stopPropagation();
  const zone=dropZone(event),allowed=zone&&canEdit(zone.dataset.uploadTask);setDropHighlight(allowed?zone:null);
  event.dataTransfer.dropEffect=allowed?'copy':'none';
},true);
document.addEventListener('dragleave',event=>{
  if(!fileDrag(event))return;
  if(event.relatedTarget&&!document.querySelector('.task-attachments')?.contains(event.relatedTarget)||!event.relatedTarget&&[document.body,document.documentElement].includes(event.target))clearDropHighlight();
},true);
document.addEventListener('drop',event=>{
  if(!fileDrag(event))return;event.preventDefault();event.stopPropagation();const zone=dropZone(event);clearDropHighlight();
  if(!zone){App.toast(document.querySelector('.task-page')?'Drop files in the attachment section':'Open a task to attach files','info');return;}
  const taskId=zone.dataset.uploadTask;
  if(!taskById(taskId)){App.toast('This task is no longer available','error');return;}
  if(!canEdit(taskId)){App.toast('You no longer have permission to upload attachments','error');return;}
  const items=Array.from(event.dataTransfer.items||[]),directories=items.filter(item=>item.kind==='file'&&item.webkitGetAsEntry?.()?.isDirectory);
  if(directories.length)App.toast('Folders are not supported. Drop individual files instead.','error');
  const files=items.some(item=>item.kind==='file')?items.filter(item=>item.kind==='file'&&!directories.includes(item)).map(item=>item.getAsFile()).filter(Boolean):Array.from(event.dataTransfer.files||[]);
  if(files.length)App.attachFiles(taskId,{files,value:''});
  else if(!directories.length)App.toast('Could not read dropped files. Choose files instead.','error');
},true);
document.addEventListener('dragend',clearDropHighlight);window.addEventListener('blur',clearDropHighlight);window.addEventListener('hashchange',clearDropHighlight);

/** The attachments section of `task`'s page. */
export function attachmentsHtml(task,editable){
  return `<div class="tp-sec task-attachments">${attachmentHeader(task,editable)}
        ${editable ? `<input type="file" id="attIn" multiple hidden ${UIAction.on('change', 'attachFiles', task.id, UIAction.element)}>` : ''}
        ${renderAttachments(task,editable)}<div class="upload-list"></div></div>`;
}
/** Draw the attachments section of the open task again, and its activity, which lists attachment changes. */
function refreshAttachments(id){
  const context=App.context();if(context.view!=='task'||context.taskId!==id)return;
  const template=document.createElement('template');setHTML(template,attachmentsHtml(taskById(id),canEdit(id)));
  const oldAttachments=document.querySelector('.task-attachments'),before=oldAttachments?.getBoundingClientRect().height,rows=UIMotion.rows(oldAttachments,'[data-attachment-id]','data-attachment-id');
  oldAttachments?.replaceWith(template.content.querySelector('.task-attachments'));
  const nextAttachments=document.querySelector('.task-attachments');UIMotion.height(nextAttachments,before);UIMotion.reflow(nextAttachments,'[data-attachment-id]','data-attachment-id',rows);
  App.refreshTaskActivity(id);mountAttachments(id);
}

// Another person signing in, a new projection and live updates change what
// the attachments show. The first page that shows them starts following.
let following=false;
function followChanges(){
  if(following)return;following=true;
  let accountScope=D.session?.id;
  runtime().transport.subscribe(change=>{
    if(change?.type==='auth'&&accountScope!==D.session?.id){clearAccount();accountScope=D.session?.id;}
    if(change?.type==='bootstrap'){loaded=new WeakSet();return;}
    if(change?.type==='sse'&&change.taskId&&(!change.entityType||['attachment','task'].includes(change.entityType))){const changedTask=taskById(change.taskId);if(changedTask)loadAttachments(changedTask.id,true,true);}
  });
}
function clearAccount(){jobs.splice(0).forEach(job=>{job.cancelled=true;job.reader?.abort();});loaded=new WeakSet();loading.clear();refreshPending.clear();retentionPending.clear();reorderPending.clear();attachmentsRead=new Set();}

Object.assign(App, {
  reorderAttachment,openAttachment,previewAttachment,downloadAttachment:download,setAttachmentTemporary:setTemporary,
  delAttachment(id,index){const task=taskById(id),file=task?.attachments?.[index];if(!editableAttachment(id,file?.id,true))return;askConfirmation({title:'Delete attachment?',text:`${displayText(file.name)} will be deleted. You can undo this right after.`,action:'Delete attachment',confirm:()=>{if(!editableAttachment(id,file.id,true))return;if(!sameTask(id,task)){App.toast('This task is no longer available.','error');return;}transport().deleteAttachment(file.id,{expectedRevision:file.revision,idempotencyKey:file.deleteKey ||= crypto.randomUUID()}).then(()=>{const current=sameTask(id,task);if(current)setFiles(current,current.attachments.filter(item=>item.id!==file.id));forgetPreview(file.id);if(shownPreview()?.fileId===file.id)closePreview();refreshAttachments(id);App.offerUndo('Attachment deleted',again=>restoreAttachment(id,task,file,again));}).catch(error=>{if(error?.status===404||error?.status===409||error?.uncertain)loadAttachments(id,true);App.toast(errorMessage(error,'Attachment could not be deleted.'),'error');});}});},
  chooseAttachments(){document.getElementById('attIn')?.click();},
  attachFiles(id,input){if(!canEdit(id)){App.toast('You no longer have permission to upload attachments','error');return;}for(const file of [...input.files]){const job={id:'upload-'+(++next),taskId:id,file,owner:D.session?.userId,ephemeral:false,state:'queued',progress:0};jobs.push(job);start(job);}input.value='';},
});
