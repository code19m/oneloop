// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* The Storage page: how much space attachments use, by project, and the
   cleanup of temporary files. */

import { errorMessage } from '../../src/app/action-feedback.js';
import { byteSize as size, displayText, fileIcons as icons } from '../../src/features/files/preview.js';
import { UIAction, esc, formatInstant } from './format.js';
import { App, D, me, recovery, runtime } from './model.js';

let serverStorage=null,serverStorageLoading=null,serverStorageState='unloaded',serverStorageRead=false;
const transport=()=>runtime().transport.api;
const escape=value=>esc(displayText(value));

/** A `background` read (a live update, or a refresh of usage already shown) is passive. */
function loadStorageUsage({background=false}={}){
  if(serverStorageLoading)return serverStorageLoading;
  serverStorageState='loading';
  serverStorageLoading=transport().storageUsage({background}).then(value=>{serverStorage=value;serverStorageState='ready';serverStorageRead=true;if(App.context().view==='storage')App.refresh();return value;}).catch(error=>{serverStorageState='error';if(App.context().view==='storage')App.refresh();return null;}).finally(()=>serverStorageLoading=null);return serverStorageLoading;
}
/** The Storage page, which loads its usage the first time it draws. */
export function storageHtml(){
  followChanges();
  if(!serverStorage){if(serverStorageState==='unloaded')loadStorageUsage({background:serverStorageRead});return `<section class="storage-capacity"><div class="storage-section-heading"><h2>Storage usage</h2></div>${serverStorageState==='error'?`<p class="access-note" role="alert">Could not load storage usage. <button class="btn quiet" ${UIAction('retryStorageUsage')}>Retry</button></p>`:'<p class="access-note" role="status">Loading storage usage…</p>'}</section>`;}
  const c={budgetBytes:serverStorage.budgetBytes,high:serverStorage.highWatermarkBytes/serverStorage.budgetBytes,low:serverStorage.lowWatermarkBytes/serverStorage.budgetBytes},used=serverStorage.usedBytes,permanent=serverStorage.permanentBytes,temporary=serverStorage.temporaryBytes,pending=serverStorage.pendingDeletionBytes||0,other=Math.max(0,used-permanent-temporary-pending),free=Math.max(0,c.budgetBytes-used),canClean=used>=serverStorage.highWatermarkBytes;
  const breakdown=[['Permanent',permanent,'permanent'],['Temporary',temporary,'temporary'],...(pending?[['Pending deletion',pending,'other']]:[]),...(other?[['Other usage',other,'other']]:[])],projects=serverStorage.projects||[],history=serverStorage.recentCleanup||[];
  return `${serverStorageState==='error'?`<p class="access-note" role="alert">Could not refresh storage usage. <button class="btn quiet" ${UIAction('retryStorageUsage')}>Retry</button></p>`:''}<section class="storage-capacity"><div class="storage-section-heading"><h2>Storage usage</h2><span class="storage-health${canClean?' attention':''}">${used>=c.budgetBytes?'Storage full':canClean?'Cleanup threshold reached':'Within capacity'}</span></div><div class="storage-amount"><strong>${size(used)}</strong><span>of ${size(c.budgetBytes)} used</span><span class="storage-free">${size(free)} free</span></div><div class="storage-meter" role="meter" aria-label="Attachment storage usage" aria-valuemin="0" aria-valuemax="${c.budgetBytes}" aria-valuenow="${Math.min(used,c.budgetBytes)}" aria-valuetext="${size(used)} of ${size(c.budgetBytes)} used">${breakdown.map(([label,bytes,kind])=>`<span class="storage-segment ${kind}" style="width:${Math.min(100,bytes/c.budgetBytes*100)}%" title="${label}: ${size(bytes)}"></span>`).join('')}<i class="storage-threshold" style="left:${Math.min(100,c.high*100)}%" title="Cleanup starts at ${Math.round(c.high*100)}%"></i></div><div class="storage-breakdown">${breakdown.map(([label,bytes,kind])=>`<span><i class="${kind}"></i>${label}<strong>${size(bytes)}</strong></span>`).join('')}</div></section>
  <section class="storage-cleanup"><div class="storage-section-heading"><div><h2>Temporary files</h2><p>Free up space from files marked temporary.</p></div><button class="btn" ${!canClean?'disabled':''} title="${canClean?'Remove eligible temporary files':'Cleanup is not needed below the storage threshold'}" ${UIAction('cleanupStorage')}>${icons.clock}Clean up now</button></div><div class="storage-cleanup-summary"><span><strong>${serverStorage.cleanedRecords}</strong> cleaned-up metadata ${serverStorage.cleanedRecords===1?'record':'records'}</span><span>${size(serverStorage.reservedBytes)} reserved</span></div><dl class="storage-policy"><div><dt>Automatic cleanup</dt><dd>Starts at ${Math.round(c.high*100)}% · clears space to ${Math.round(c.low*100)}%</dd></div><div><dt>Recently used files</dt><dd>Protected for 24 hours</dd></div><div><dt>Permanent files</dt><dd>Never removed automatically</dd></div></dl></section>
  <section class="storage-projects"><div class="storage-section-heading"><h2>By project</h2></div><div class="storage-project-list">${projects.map(project=>`<div class="storage-project-row"><span class="storage-project-avatar">${escape(project.projectName.slice(0,1).toUpperCase())}</span><span class="storage-project-name">${escape(project.projectName)}</span><span class="storage-project-count">${project.fileCount} ${project.fileCount===1?'file':'files'}</span><strong>${size(project.bytes)}</strong></div>`).join('')||'<div class="storage-history-empty"><span>No stored attachments</span></div>'}</div></section>
  <section class="storage-history"><div class="storage-section-heading"><h2>Recent cleanup</h2></div>${history.length?history.map(event=>`<div class="storage-history-row"><span class="storage-history-icon">${icons.clock}</span><div><strong>${event.fileCount} temporary ${event.fileCount===1?'file':'files'} cleaned up</strong><time datetime="${new Date(event.at*1000).toISOString()}">${formatInstant(event.at*1000)}</time></div><span>${size(event.bytes)} freed</span></div>`).join(''):`<div class="storage-history-empty">${icons.clock}<span>No cleanup runs yet</span></div>`}</section>`;
}

// Another person signing in, a new projection and live updates change the
// usage. The first time the page draws, it starts following them.
let following=false;
function followChanges(){
  if(following)return;following=true;
  let accountScope=D.session?.id;
  runtime().transport.subscribe(change=>{
    if(change?.type==='auth'&&accountScope!==D.session?.id){serverStorage=null;serverStorageState='unloaded';serverStorageRead=false;accountScope=D.session?.id;}
    if(change?.type==='bootstrap'){serverStorage=null;serverStorageState='unloaded';return;}
    if(change?.type==='sse'&&App.context().view==='storage')loadStorageUsage({background:true});
  });
}

Object.assign(App, {
  retryStorageUsage(){return loadStorageUsage();},
  cleanupStorage(){if(!me()?.admin||!recovery.ensureOnline())return;transport().cleanupStorage().then(report=>{serverStorage=null;return loadStorageUsage().then(()=>App.toast(report.temporaryFilesCleaned?`Removed ${report.temporaryFilesCleaned} temporary ${report.temporaryFilesCleaned===1?'file':'files'} (${size(report.bytesReclaimed)})`:'No temporary files are eligible for cleanup','info'));}).catch(error=>App.toast(errorMessage(error,'Storage cleanup could not be completed.'),'error'));},
});
