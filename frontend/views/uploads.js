/* Attachment transport, previews and rendering. */
(() => {
  // Capture the script location now; previews open after currentScript is cleared.
  const assetBase=new URL('../',(/** @type {HTMLScriptElement|null} */(document.currentScript))?.src||new URL('/views/uploads.js',location.href));
  const limits=()=>/** @type {Window & {DATA?:{limits?:{maxAttachmentBytes:number,maxAvatarBytes:number,maxAttachmentsPerTask:number}}}} */(window).DATA?.limits || {maxAttachmentBytes:25*1024*1024,maxAvatarBytes:5*1024*1024,maxAttachmentsPerTask:25};
  const maxFile=()=>limits().maxAttachmentBytes,maxAvatar=()=>limits().maxAvatarBytes,maxFiles=()=>limits().maxAttachmentsPerTask;
  const PREVIEW_CACHE_BYTES=64*1024*1024;
  const textExtensions=new Set('txt log md markdown mdx json jsonc jsonl ndjson csv tsv yaml yml toml xml ini cfg conf config properties sql graphql gql js mjs cjs jsx ts mts cts tsx py pyi rs go java c h cc cpp cxx hpp cs php rb swift kt kts scala dart lua pl pm r sh bash zsh fish ps1 bat cmd css scss sass less svelte vue astro diff patch gitignore gitattributes editorconfig env dockerfile makefile cmake tex rst adoc svg'.split(' '));
  const textNames=new Set(['.dockerignore', '.editorconfig', '.env', '.gitattributes', '.gitignore', '.npmrc', '.nvmrc', 'authors', 'changelog', 'containerfile', 'dockerfile', 'gemfile', 'gnumakefile', 'justfile', 'licence', 'license', 'makefile', 'notice', 'procfile', 'rakefile', 'readme']);
  let productionLoaded=new WeakSet();
  const jobs=[],sources=new Map(),productionLoading=new Map(),productionRefreshPending=new Map(),retentionPending=new Set(),reorderPending=new Set();
  /** Attachment hooks supplied by the shared renderer's bind call.
   * @type {{task:(id:string)=>any, can:(id:string)=>boolean, canRead:(id:string)=>boolean,
   * confirm:(options:{title:string,text:string,action:string,confirm:()=>void})=>void,
   * instant:(value:number|string)=>string, me:()=>{admin?:boolean,id:string,avatar?:string},
   * refresh:()=>void, refreshAttachments:(id:string)=>void}}
   */
  let hooks;
  let next=0,app,preview=null,serverStorage=null,serverStorageLoading=null,serverStorageState='unloaded',serverStorageRead=false,runtimeUnsubscribe=null;
  // Tasks whose attachments this account has read. Reading them again, after a
  // live update or a refresh replaced the task, is passive: it never keeps an
  // idle session open.
  let attachmentsRead=new Set();
  const transport=()=>window.OneloopTransport.api;
  function cachedSource(id) {
    const source=sources.get(id);
    if(source){sources.delete(id);sources.set(id,source);}
    return source;
  }
  function cacheSource(id,source) {
    sources.delete(id);sources.set(id,source);
    // Count both the ArrayBuffer and Blob, even where the browser shares bytes.
    let bytes=[...sources.values()].reduce((total,item)=>total+item.buffer.byteLength+item.blob.size,0);
    for(const [key,item] of sources){
      if(bytes<=PREVIEW_CACHE_BYTES)break;
      if(key===preview?.fileId)continue;
      bytes-=item.buffer.byteLength+item.blob.size;sources.delete(key);
    }
  }
  const errorMessage=(error,fallback)=>window.OneloopErrorMessage?window.OneloopErrorMessage(error,fallback):(error?.message||fallback);
  const serverFile=file=>({id:file.id,name:file.name,size:file.size,type:file.mediaType,previewKind:file.previewKind,checksum:file.checksum,ephemeral:file.isEphemeral,uploadedBy:file.uploadedBy,uploadedAt:file.uploadedAt*1000,lastAccessAt:file.lastAccessedAt*1000,state:file.state,revision:file.revision,url:file.contentUrl||file.downloadUrl,downloadUrl:file.downloadUrl,contentUrl:file.contentUrl,thumbnailUrl:file.thumbnailUrl,sourceUrl:file.sourceUrl,htmlPreviewUrl:file.htmlPreviewUrl});
  // A live update replaces task objects, so a reply finds its task again by id.
  const sameTask=(taskId,task)=>{const current=hooks.task(taskId);return current&&(current===task||!!current.internalId&&current.internalId===task.internalId)?current:null;};
  function loadProduction(taskId,force=false,background=false){
    const api=transport(),task=hooks?.task(taskId);
    if(!task||!force&&productionLoaded.has(task))return;
    const sessionId=window.DATA.session?.id,internalId=task.internalId||taskId;
    background||=attachmentsRead.has(internalId);
    if(productionLoading.has(taskId)){
      if(force)productionRefreshPending.set(taskId,(productionRefreshPending.get(taskId)??true)&&background);
      return productionLoading.get(taskId);
    }
    if(force)productionLoaded.delete(task);
    // A task detail read can replace its projection while this request is in flight.
    const currentTask=()=>{
      const current=hooks.task(taskId);
      return current&&window.DATA.session?.id===sessionId&&(current.internalId||taskId)===internalId?current:null;
    };
    const request=api.attachments(internalId,{background}).then(result=>{
      const current=currentTask();if(!current)return;
      current.attachments=(result.items||[]).map(serverFile);
      productionLoaded.add(current);attachmentsRead.add(internalId);
      if(preview?.taskId===taskId){
        const file=current.attachments.find(item=>item.id===preview.fileId);
        if(!file||file.state!=='available')closePreview();else syncRetention(taskId,file);
      }
      hooks.refreshAttachments(taskId);
    }).catch(error=>{
      const current=currentTask();if(!current)return;
      if([401,403,404].includes(error?.status)){
        current.attachments=[];productionLoaded.delete(current);
        if(preview?.taskId===taskId)closePreview();
        hooks.refreshAttachments(taskId);
        // Lost access during a live refresh: the page itself says what happened.
        if(background)return;
      }
      app.toast(errorMessage(error,'Attachments could not be loaded.'),'error');
    }).finally(()=>{
      if(productionLoading.get(taskId)!==request)return;
      productionLoading.delete(taskId);
      const pending=productionRefreshPending.get(taskId);
      if(productionRefreshPending.delete(taskId))loadProduction(taskId,true,pending);
    });
    productionLoading.set(taskId,request);
  }

  function mount(id){
    loadProduction(id);
    const host=document.querySelector('.upload-list');if(!host)return;
    const zone=host.closest('.task-attachments');if(zone)zone.dataset.uploadTask=id;
    const current=jobs.filter(job=>job.taskId===id);
    host.querySelectorAll('[data-upload-id]').forEach(el=>{if(!current.some(j=>j.id===el.dataset.uploadId))el.remove();});
    for(const job of current){let row=host.querySelector(`[data-upload-id="${UIEscape(job.id)}"]`);if(!row){row=document.createElement('div');row.className='upload-row';row.dataset.uploadId=job.id;UIHTML(row,'<div class="upload-copy"><span class="upload-name"></span><span class="upload-state"></span><progress max="100"></progress></div><button type="button" class="btn quiet" data-upload-action="cancel">Cancel</button><button type="button" class="btn quiet" data-upload-action="retry">Retry</button><button type="button" class="btn quiet" data-upload-action="remove">Dismiss</button>');host.append(row);UIMotion.enter(row);}
      row.querySelector('.upload-name').textContent=displayText(job.file.name);const status=row.querySelector('.upload-state');status.textContent=job.error||(job.state==='uploading'?`Uploading ${job.progress}%`:job.state==='cancelled'?'Upload cancelled':'Uploaded');status.setAttribute('role',job.state==='error'?'alert':'status');
      const progress=row.querySelector('progress');progress.value=job.progress;progress.hidden=job.state!=='uploading';progress.setAttribute('aria-label',displayText(job.file.name)+' upload');
      row.querySelector('[data-upload-action="cancel"]').hidden=job.state!=='uploading';row.querySelector('[data-upload-action="retry"]').hidden=!['error','cancelled'].includes(job.state)||job.validation;row.querySelector('[data-upload-action="remove"]').hidden=job.state==='uploading';
    }
    host.onclick=event=>{const button=event.target.closest('[data-upload-action]');if(!button)return;const job=jobs.find(j=>j.id===button.closest('[data-upload-id]').dataset.uploadId);if(!job)return;const action=button.dataset.uploadAction;if(action==='cancel'){job.cancelled=true;job.state='cancelled';job.reader?.abort();mount(id);}else if(action==='retry')start(job);else{jobs.splice(jobs.indexOf(job),1);loadProduction(id,true);mount(id);}};
  }
  function reject(job,message,validation=false){job.state='error';job.error=message;job.validation=validation;mount(job.taskId);}
  function start(job){
    const task=hooks.task(job.taskId);if(!task||!hooks.can(job.taskId)||window.DATA.session?.userId!==job.owner){reject(job,'You no longer have permission to attach this file.');return;}
    if(available(task).length+jobs.filter(j=>j!==job&&j.taskId===job.taskId&&j.state==='uploading').length>=maxFiles()){reject(job,`A task can have at most ${maxFiles()} available attachments.`,true);return;}
    if(job.file.size>maxFile()){reject(job,`File exceeds ${maxFile()/1024/1024} MB.`,true);return;}
    if(window.Recovery?.connection==='offline'){reject(job,'The server is unreachable. Retry when connected.');return;}
    upload(job,task);
  }
  async function upload(job,task){
    job.cancelled=false;job.state='uploading';job.progress=0;job.error='';job.validation=false;const controller=new AbortController();job.reader={abort:()=>controller.abort()};mount(job.taskId);
    try{
      // Leaving the page while a file uploads would lose it.
      const sending=transport().uploadAttachment(task.internalId||job.taskId,{file:job.file,ephemeral:job.ephemeral,idempotencyKey:job.idempotencyKey ||= crypto.randomUUID(),signal:controller.signal,onProgress:percent=>{if(job.state==='uploading'&&!job.cancelled){job.progress=percent;mount(job.taskId);}}});
      window.Recovery?.trackWrite?.(sending);const value=await sending;
      if(job.cancelled)return;const current=sameTask(job.taskId,task);if(!current)throw new Error('The task is no longer available.');
      const mapped=serverFile(value),index=(current.attachments||[]).findIndex(file=>file.id===mapped.id);if(index>=0)current.attachments[index]=mapped;else(current.attachments ||= []).push(mapped);
      productionLoaded.add(current);jobs.splice(jobs.indexOf(job),1);hooks.refreshAttachments(job.taskId);app.toast('Attachment added');
    }catch(error){if(job.cancelled)return;reject(job,errorMessage(error,'Upload failed. Please try again.'),error?.status===400&&error?.code==='validation_failed');}
  }
  const displayText=value=>String(value??'').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'');
  const escape=value=>UIEscape(displayText(value));
  const size=n=>n>=1073741824?(n/1073741824).toFixed(n%1073741824?1:0)+' GiB':n>=1048576?(n/1048576).toFixed(1)+' MiB':n>=1024?Math.round(n/1024)+' KiB':n+' B';
  const available=task=>(task.attachments||[]).filter(f=>!f.state||f.state==='available');
  const extension=file=>file.name.split('.').pop().toLowerCase();
  const canPreview=file=>Object.hasOwn(file,'previewKind')?!!file.previewKind:['png','jpg','jpeg','webp','gif','avif','pdf','html','htm'].includes(extension(file))||textExtensions.has(extension(file))||textNames.has(file.name.toLowerCase());
  const icon=paths=>`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const icons={plus:icon('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),grip:icon('<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" stroke-width="3"/>'),close:icon('<path d="m6 6 12 12M6 18 18 6"/>'),info:icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>'),left:icon('<path d="m14 6-6 6 6 6"/>'),right:icon('<path d="m10 6 6 6-6 6"/>'),upload:icon('<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>'),clock:icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),document:icon('<path d="M14 2H5v20h14V7L14 2Z"/><path d="M14 2v6h5M8 12h8M8 16h6"/>'),preview:icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),download:icon('<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>'),remove:icon('<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>')};
  function editableAttachment(taskId,fileId,includeCleaned=false){
    const task=hooks.task(taskId),file=(task?.attachments||[]).find(f=>f.id===fileId&&(!f.state||f.state==='available'||includeCleaned&&f.state==='cleaned'));
    if(!file){app.toast('This attachment is no longer available','error');return null;}
    if(!hooks.can(taskId)){app.toast('You no longer have permission to change attachments','error');return null;}
    if(window.Recovery&&!Recovery.ensureOnline())return null;
    return file;
  }
  function setTemporary(taskId,fileId,value){
    const task=hooks.task(taskId),file=editableAttachment(taskId,fileId);if(!file)return false;if(retentionPending.has(fileId)){app.toast('This retention change is still being saved.','info');return false;}
    const before=!!file.ephemeral;if(before===!!value)return true;file.ephemeral=!!value;syncRetention(taskId,file);
    retentionPending.add(fileId);transport().updateAttachment(fileId,{isEphemeral:!!value,expectedRevision:file.revision}).then(saved=>{const current=sameTask(taskId,task)?.attachments?.find(item=>item.id===fileId);if(!current)return;Object.assign(current,serverFile(saved));syncRetention(taskId,current);app.toast(current.ephemeral?'Attachment marked temporary':'Attachment marked permanent');}).catch(error=>{const current=sameTask(taskId,task)?.attachments?.find(item=>item.id===fileId);if(current){current.ephemeral=before;syncRetention(taskId,current);}if(error?.status===409||error?.uncertain)loadProduction(taskId,true);app.toast(errorMessage(error,'Retention could not be changed.'),'error');}).finally(()=>retentionPending.delete(fileId));
    return true;
  }
  // A row's switch acts through its data-action arguments. Actions never run in
  // the untrusted preview body, so the preview's switch gets its handler here.
  function syncRetention(taskId,file){
    document.querySelectorAll('[data-attachment-id]').forEach(row=>{if(row.dataset.attachmentId!==file.id)return;const toggle=row.querySelector('.retention-switch');if(toggle){toggle.setAttribute('aria-checked',String(file.ephemeral));toggle.dataset.args=JSON.stringify([taskId,file.id,!file.ephemeral]);}});
    if(preview?.fileId===file.id){const toggle=document.querySelector('[data-file-ephemeral]');if(toggle){toggle.setAttribute('aria-checked',String(file.ephemeral));toggle.onclick=()=>setTemporary(taskId,file.id,!file.ephemeral);}const value=document.querySelector('[data-file-retention]');if(value)value.textContent=file.ephemeral?'Temporary':'Permanent';}
  }
  function retentionSwitch(taskId,file,previewControl=false){
    return `<button type="button" class="retention-switch" role="switch" aria-checked="${!!file.ephemeral}" aria-label="Temporary: ${escape(file.name)}" title="Allow this file to be removed when storage is low" ${previewControl?'data-file-ephemeral':UIAction('setAttachmentTemporary',taskId,file.id,!file.ephemeral)}>${icons.clock}<span>Temporary</span><span class="retention-track" aria-hidden="true"></span></button>`;
  }
  function openAttachment(event,taskId,fileId){
    const file=hooks.task(taskId)?.attachments?.find(f=>f.id===fileId);
    if(file&&canPreview(file)){event.preventDefault();previewAttachment(taskId,fileId);return false;}
    return download(event,taskId,fileId);
  }
  function downloadOriginal(taskId,fileId){
    const file=hooks.task(taskId)?.attachments?.find(f=>f.id===fileId);
    if(!download({preventDefault(){}},taskId,fileId))return;
    const link=document.createElement('a');link.href=file.downloadUrl||file.url;link.download=displayText(file.name);link.click();
  }
  function attachmentHeader(task,canEdit){
    const hasAttachments=(task.attachments||[]).some(file=>file.state!=='removed');
    const dropArea=canEdit?`<button type="button" class="attachment-dropzone${hasAttachments?' is-compact':''}" ${UIAction('chooseAttachments')} aria-label="Drag &amp; drop or browse files"><span class="attachment-drop-icon" aria-hidden="true">${icons.plus}</span><span class="attachment-drop-copy"><span><span class="attachment-drop-title">Drag &amp; drop</span><span class="attachment-browse"> or <span class="attachment-choose">browse files</span></span></span><small class="attachment-drop-limit">${icons.info}<span>Max file size: ${maxFile()/1024/1024} MB</span></small></span></button>`:'';
    return `<div class="attachment-heading"><div class="attachment-heading-copy"><h2>Attachments</h2></div></div>${dropArea}`;
  }
  function attachmentName(name){
    const dot=name.lastIndexOf('.'),hasExtension=dot>0&&name.length-dot<=13;
    return `<bdi class="attachment-name-base">${escape(hasExtension?name.slice(0,dot):name)}</bdi>${hasExtension?`<bdi class="attachment-name-extension">${escape(name.slice(dot))}</bdi>`:''}`;
  }
  function renderAttachments(task,canEdit){
    const rows=(task.attachments||[]).filter(f=>f.state!=='removed').map(f=>{
      const cleaned=f.state==='cleaned',previewable=!cleaned&&canPreview(f),ext=extension(f),action=previewable?'Preview':'Download',link=`href="${escape(previewable?(f.contentUrl||f.url):(f.downloadUrl||f.url||'#'))}" download="${escape(f.name)}" ${UIAction('openAttachment',UIAction.event,task.id,f.id)}`;
      const image=previewable&&(f.previewKind==='image'||!Object.hasOwn(f,'previewKind')&&['png','jpg','jpeg','webp','gif','avif'].includes(ext))&&f.url;
      const thumb=`${image?`<img src="${escape(f.thumbnailUrl||f.url)}" alt="" loading="lazy">`:`${icons.document}<span>${escape(ext.slice(0,5).toUpperCase())}</span>`}${cleaned?'':`<span class="thumbnail-action" aria-hidden="true">${previewable?icons.preview:icons.download}</span>`}`;
      const thumbnail=cleaned?`<span class="attachment-thumbnail" aria-hidden="true">${thumb}</span>`:`<a class="attachment-thumbnail${image?' has-image':''}" ${link} aria-label="${action} ${escape(f.name)}" title="${action}">${thumb}</a>`;
      const title=cleaned?`<span class="attachment-title" data-tip="${escape(f.name)}" data-tip-overflow>${attachmentName(f.name)}</span>`:`<a class="attachment-title" data-tip="${escape(f.name)}" data-tip-overflow aria-label="${escape(f.name)}" ${link}>${attachmentName(f.name)}</a>`;
      const downloadAction=cleaned?`<button type="button" class="btn file-download" disabled aria-label="Download ${escape(f.name)} unavailable" title="Temporary file cleaned up">${icons.download}<span class="attachment-action-label">Download</span></button>`:`<a class="btn file-download" href="${escape(f.downloadUrl||f.url||'#')}" download="${escape(f.name)}" aria-label="Download ${escape(f.name)}" ${UIAction('downloadAttachment',UIAction.event,task.id,f.id)}>${icons.download}<span class="attachment-action-label">Download</span></a>`;
      return `<article class="attachment-card${cleaned?' is-cleaned':''}" data-attachment-id="${escape(f.id)}"><div class="attachment-summary">${canEdit?`<button type="button" class="attachment-grip" data-reorder-task="${UIEscape(task.id)}" data-reorder-file="${escape(f.id)}" aria-label="Reorder ${escape(f.name)}" title="Drag to reorder · Arrow keys to move">${icons.grip}</button>`:''}${thumbnail}<div class="attachment-identity">${title}<div class="attachment-meta">${cleaned?`<span class="attachment-cleaned-status" title="Temporary file removed during storage cleanup">${icons.clock}Cleaned up</span>`:`<span>${size(f.size)}</span>${!previewable?'<span>Download only</span>':''}`}</div></div></div><div class="attachment-actions">${!cleaned?(canEdit?retentionSwitch(task.id,f):`<span class="attachment-retention-label">${f.ephemeral?'Temporary':'Permanent'}</span>`):''}${downloadAction}${canEdit?`<button type="button" class="btn icon file-remove" aria-label="Delete ${escape(f.name)} attachment" title="Delete attachment" ${UIAction('delAttachment',task.id,task.attachments.indexOf(f))}>${icons.remove}</button>`:''}</div></article>`;
    }).join('');
    return rows||(!canEdit?'<div class="attachment-empty">No attachments yet</div>':'');
  }

  /** A `background` read (a live update, or a refresh of usage already shown) is passive. */
  function loadStorageUsage({background=false}={}){
    if(serverStorageLoading)return serverStorageLoading;
    serverStorageState='loading';
    serverStorageLoading=transport().storageUsage({background}).then(value=>{serverStorage=value;serverStorageState='ready';serverStorageRead=true;if(app.context?.().view==='storage')hooks.refresh();return value;}).catch(error=>{serverStorageState='error';if(app.context?.().view==='storage')hooks.refresh();return null;}).finally(()=>serverStorageLoading=null);return serverStorageLoading;
  }
  function storageHtml(){
    if(!serverStorage){if(serverStorageState==='unloaded')loadStorageUsage({background:serverStorageRead});return `<section class="storage-capacity"><div class="storage-section-heading"><h2>Storage usage</h2></div>${serverStorageState==='error'?`<p class="access-note" role="alert">Could not load storage usage. <button class="btn quiet" ${UIAction('retryStorageUsage')}>Retry</button></p>`:'<p class="access-note" role="status">Loading storage usage…</p>'}</section>`;}
    const c={budgetBytes:serverStorage.budgetBytes,high:serverStorage.highWatermarkBytes/serverStorage.budgetBytes,low:serverStorage.lowWatermarkBytes/serverStorage.budgetBytes},used=serverStorage.usedBytes,permanent=serverStorage.permanentBytes,temporary=serverStorage.temporaryBytes,pending=serverStorage.pendingDeletionBytes||0,other=Math.max(0,used-permanent-temporary-pending),free=Math.max(0,c.budgetBytes-used),canClean=used>=serverStorage.highWatermarkBytes;
    const breakdown=[['Permanent',permanent,'permanent'],['Temporary',temporary,'temporary'],...(pending?[['Pending deletion',pending,'other']]:[]),...(other?[['Other usage',other,'other']]:[])],projects=serverStorage.projects||[],history=serverStorage.recentCleanup||[];
    return `${serverStorageState==='error'?`<p class="access-note" role="alert">Could not refresh storage usage. <button class="btn quiet" ${UIAction('retryStorageUsage')}>Retry</button></p>`:''}<section class="storage-capacity"><div class="storage-section-heading"><h2>Storage usage</h2><span class="storage-health${canClean?' attention':''}">${used>=c.budgetBytes?'Storage full':canClean?'Cleanup threshold reached':'Within capacity'}</span></div><div class="storage-amount"><strong>${size(used)}</strong><span>of ${size(c.budgetBytes)} used</span><span class="storage-free">${size(free)} free</span></div><div class="storage-meter" role="meter" aria-label="Attachment storage usage" aria-valuemin="0" aria-valuemax="${c.budgetBytes}" aria-valuenow="${Math.min(used,c.budgetBytes)}" aria-valuetext="${size(used)} of ${size(c.budgetBytes)} used">${breakdown.map(([label,bytes,kind])=>`<span class="storage-segment ${kind}" style="width:${Math.min(100,bytes/c.budgetBytes*100)}%" title="${label}: ${size(bytes)}"></span>`).join('')}<i class="storage-threshold" style="left:${Math.min(100,c.high*100)}%" title="Cleanup starts at ${Math.round(c.high*100)}%"></i></div><div class="storage-breakdown">${breakdown.map(([label,bytes,kind])=>`<span><i class="${kind}"></i>${label}<strong>${size(bytes)}</strong></span>`).join('')}</div></section>
    <section class="storage-cleanup"><div class="storage-section-heading"><div><h2>Temporary files</h2><p>Free up space from files marked temporary.</p></div><button class="btn" ${!canClean?'disabled':''} title="${canClean?'Remove eligible temporary files':'Cleanup is not needed below the storage threshold'}" ${UIAction('cleanupStorage')}>${icons.clock}Clean up now</button></div><div class="storage-cleanup-summary"><span><strong>${serverStorage.cleanedRecords}</strong> cleaned-up metadata ${serverStorage.cleanedRecords===1?'record':'records'}</span><span>${size(serverStorage.reservedBytes)} reserved</span></div><dl class="storage-policy"><div><dt>Automatic cleanup</dt><dd>Starts at ${Math.round(c.high*100)}% · clears space to ${Math.round(c.low*100)}%</dd></div><div><dt>Recently used files</dt><dd>Protected for 24 hours</dd></div><div><dt>Permanent files</dt><dd>Never removed automatically</dd></div></dl></section>
    <section class="storage-projects"><div class="storage-section-heading"><h2>By project</h2></div><div class="storage-project-list">${projects.map(project=>`<div class="storage-project-row"><span class="storage-project-avatar">${escape(project.projectName.slice(0,1).toUpperCase())}</span><span class="storage-project-name">${escape(project.projectName)}</span><span class="storage-project-count">${project.fileCount} ${project.fileCount===1?'file':'files'}</span><strong>${size(project.bytes)}</strong></div>`).join('')||'<div class="storage-history-empty"><span>No stored attachments</span></div>'}</div></section>
    <section class="storage-history"><div class="storage-section-heading"><h2>Recent cleanup</h2></div>${history.length?history.map(event=>`<div class="storage-history-row"><span class="storage-history-icon">${icons.clock}</span><div><strong>${event.fileCount} temporary ${event.fileCount===1?'file':'files'} cleaned up</strong><time datetime="${new Date(event.at*1000).toISOString()}">${hooks.instant(event.at*1000)}</time></div><span>${size(event.bytes)} freed</span></div>`).join(''):`<div class="storage-history-empty">${icons.clock}<span>No cleanup runs yet</span></div>`}</section>`;
  }

  /** The dialog's preview owns `preview`; an inline preview lives while its host does. */
  const previewActive=(owner,host)=>!!owner&&!owner.disposed&&(owner.inline?host.isConnected:preview===owner);
  function bindWheelZoom(surface,owner,zoom){
    surface.setAttribute('aria-description','Hold Ctrl or Command and scroll to zoom.');
    const wheel=event=>{
      if(!previewActive(owner,surface)||!surface.isConnected||surface.closest('[inert]')||!(event.ctrlKey||event.metaKey)||!Number.isFinite(event.deltaY)||event.deltaY===0)return;
      event.preventDefault();event.stopPropagation();
      const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?surface.clientHeight||800:1);
      zoom(-Math.max(-100,Math.min(100,pixels))*.0025,event);
    };
    surface.addEventListener('wheel',wheel,{passive:false});owner.zoomWheelOff=()=>surface.removeEventListener('wheel',wheel);
  }
  function mountRetentionHelp(layer,owner){
    const button=layer.querySelector('.retention-help button'),tip=layer.querySelector('#retention-help-text');if(!button||!tip)return;
    // Keep the hint outside the scrolling/clipped details drawer.
    tip.className='retention-tooltip';tip.hidden=true;layer.append(tip);
    let pinned=false,leaveTimer;
    const hide=()=>{clearTimeout(leaveTimer);pinned=false;tip.hidden=true;button.setAttribute('aria-expanded','false');};
    const position=()=>{
      if(tip.hidden)return;const r=button.getBoundingClientRect(),panel=layer.querySelector('.file-info'),bounds=panel.getBoundingClientRect();
      if(panel.hidden||panel.inert||r.bottom<=bounds.top||r.top>=bounds.bottom){hide();return;}
      const width=tip.getBoundingClientRect().width,height=tip.getBoundingClientRect().height,gap=8,margin=8;
      const above=r.bottom+gap+height>innerHeight-margin&&r.top-gap-height>=margin;
      tip.style.left=Math.max(margin,Math.min(r.right-width,innerWidth-width-margin))+'px';
      tip.style.top=Math.max(margin,Math.min(above?r.top-gap-height:r.bottom+gap,innerHeight-height-margin))+'px';
    };
    const show=()=>{clearTimeout(leaveTimer);const wasHidden=tip.hidden;tip.hidden=false;button.setAttribute('aria-expanded','true');position();if(wasHidden&&!tip.hidden)UIMotion.fade(tip);};
    const leave=()=>{if(!pinned)leaveTimer=setTimeout(hide,100);};
    const focus=()=>{if(button.matches(':focus-visible'))show();};
    const outside=event=>{if(!button.contains(event.target)&&!tip.contains(event.target))hide();};
    button.onpointerenter=event=>{if(event.pointerType!=='touch')show();};button.onpointerleave=leave;button.onfocus=focus;button.onblur=leave;
    button.onclick=()=>{pinned=!pinned;if(pinned)show();else hide();};tip.onpointerenter=()=>clearTimeout(leaveTimer);tip.onpointerleave=leave;
    document.addEventListener('pointerdown',outside);document.addEventListener('scroll',position,true);window.addEventListener('resize',position);
    owner.hideRetentionHelp=()=>{if(tip.hidden)return false;hide();return true;};
    owner.retentionHelpOff=()=>{hide();tip.remove();document.removeEventListener('pointerdown',outside);document.removeEventListener('scroll',position,true);window.removeEventListener('resize',position);};
  }
  function disposePreview(owner){if(!owner)return;owner.disposed=true;owner.sourceController?.abort();clearTimeout(owner.sourceTimeout);owner.retentionHelpOff?.();owner.zoomWheelOff?.();clearTimeout(owner.pdfWheelTimer);clearTimeout(owner.pdfTimeout);clearTimeout(owner.pdfResizeTimer);owner.pdfResize?.disconnect();owner.imageResize?.disconnect();owner.detailsMedia?.removeEventListener?.('change',owner.detailsSync);owner.pdfRender?.cancel();owner.pdfLoading?.destroy()?.catch?.(()=>{});}
  function closePreview(){if(!preview)return;disposePreview(preview);const focus=preview.focus;UIMotion.remove(document.querySelector('.file-overlay'));document.getElementById('app').inert=false;preview=null;if(focus?.isConnected)focus.focus({preventScroll:true});}
  const uploadedDate=value=>hooks.instant(value);
  function previewAttachment(taskId,fileId,collection=null){
    if(!window.DATA.session||!(collection?collection.canRead():hooks.canRead(taskId))){app.toast('This file is unavailable','error');return;}const task=collection?null:hooks.task(taskId),file=(collection?.files||task?.attachments)?.find(f=>f.id===fileId);if(!file){app.toast('This attachment is no longer available','error');return;}
    if(file.state&&file.state!=='available'){app.toast(file.state==='cleaned'?'This temporary file was cleaned up':'This attachment is no longer available','info');return;}
    if(!canPreview(file)){if(!collection)downloadOriginal(taskId,fileId);return;}
    const existingLayer=preview?document.querySelector('.file-overlay:not([data-motion-exiting])'):null,switching=!!existingLayer,detailsOpen=existingLayer?.querySelector('[data-file-details]')?.getAttribute('aria-expanded')==='true',oldFocus=preview?.focus||document.activeElement;disposePreview(preview);existingLayer?.querySelectorAll('iframe').forEach(frame=>frame.remove());preview={taskId,fileId,collection,scale:1,focus:oldFocus};file.lastAccessAt=Date.now();
    const editable=!collection&&hooks.can(taskId)&&(!file.state||file.state==='available');
    let layer=document.createElement('div');layer.className='file-overlay';UIHTML(layer,`<div class="scrim"></div><section class="file-dialog" role="dialog" aria-modal="true" aria-labelledby="file-preview-title"><header><span class="file-preview-symbol" aria-hidden="true">${icons.document}</span><div class="file-preview-heading"><h2 id="file-preview-title" data-tip="${escape(file.name)}" data-tip-overflow>${escape(file.name)}</h2><span>${escape(extension(file).toUpperCase())}<span aria-hidden="true"> · </span>${size(file.size)}</span></div><button class="btn quiet file-details-toggle" aria-label="File details" aria-expanded="false" aria-controls="file-preview-details" data-file-details>${icons.info}<span>Details</span></button><a class="btn primary" href="${escape(file.downloadUrl||file.url||'#')}" download="${escape(file.name)}" data-file-download aria-label="Download ${escape(file.name)}">${icons.download}<span>Download</span></a><button class="btn icon" aria-label="Close file preview" data-file-close title="Close preview (Esc)">${icons.close}</button></header><div class="file-toolbar"><div class="file-navigation" role="group" aria-label="Attachment navigation"><button class="btn icon" aria-label="Previous file" data-file-prev>${icons.left}</button><span class="preview-position" data-file-position></span><button class="btn icon" aria-label="Next file" data-file-next>${icons.right}</button></div><div class="file-tools"></div></div><div class="file-preview-body"><div class="file-preview-content"></div><aside class="file-info" id="file-preview-details" hidden><h3>File details</h3><dl><dt>File name</dt><dd>${escape(file.name)}</dd><dt>Type</dt><dd>${escape(file.name.split('.').pop().toUpperCase())}</dd><dt>Size</dt><dd>${size(file.size)}</dd><dt>Uploaded by</dt><dd>${escape(window.DATA.users.find(u=>u.id===file.uploadedBy)?.name||'Unavailable')}</dd><dt>Uploaded</dt><dd>${file.uploadedAt?uploadedDate(file.uploadedAt):'Unavailable'}</dd><dt>Retention</dt><dd class="file-retention-control"><span data-file-retention>${file.ephemeral?'Temporary':'Permanent'}</span>${editable?`${retentionSwitch(taskId,file,true)}<span class="retention-help"><button type="button" class="btn icon" aria-label="About temporary files" aria-expanded="false" aria-describedby="retention-help-text">${icons.info}</button><span id="retention-help-text" role="tooltip">Allow this file to be removed when storage is low.</span></span>`:''}</dd></dl>${file.checksum?`<div class="file-integrity"><button type="button" class="file-integrity-toggle" aria-expanded="false" aria-controls="file-checksum-value"><svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="m4 2 5 4-5 4z"/></svg>File checksum</button><div class="file-integrity-content" id="file-checksum-value" aria-hidden="true" inert><div><div class="file-checksum">${escape(file.checksum)}</div></div></div></div>`:''}</aside></div></section>`);
    if(collection){
      // Synced files have a path and a date, never an uploader or a retention choice.
      UIHTML(layer.querySelector('.file-info dl'),`<dt>File name</dt><dd>${escape(file.name)}</dd><dt>Path</dt><dd>${escape(file.path||file.name)}</dd><dt>Size</dt><dd>${size(file.size)}</dd>${file.updatedAt?`<dt>Updated</dt><dd>${hooks.instant(file.updatedAt*1000)}</dd>`:''}`);
    }
    if(existingLayer){
      // Keep the scrim, dialog and layout mounted; only the selected file changes.
      existingLayer.querySelector('header').replaceWith(layer.querySelector('header'));
      existingLayer.querySelector('.file-tools').replaceChildren();
      existingLayer.querySelector('.file-navigation').replaceChildren(...layer.querySelector('.file-navigation').childNodes);
      existingLayer.querySelector('.file-preview-content').replaceWith(layer.querySelector('.file-preview-content'));
      existingLayer.querySelector('.file-info').replaceWith(layer.querySelector('.file-info'));
      layer=existingLayer;
    }else{document.body.append(layer);UIMotion.enter(layer.querySelector('.file-dialog'));}
    document.getElementById('app').inert=true;
    layer.querySelector('[data-file-close]').onclick=closePreview;layer.querySelector('[data-file-close]').focus();if(!collection)layer.querySelector('[data-file-download]').onclick=e=>download(e,taskId,fileId);
    if(editable)syncRetention(taskId,file);
    const files=(collection?collection.files:available(task)).filter(canPreview),index=files.indexOf(file),previous=layer.querySelector('[data-file-prev]'),next=layer.querySelector('[data-file-next]');
    layer.querySelector('[data-file-position]').textContent=`File ${index+1} of ${files.length}`;layer.querySelector('.file-navigation').hidden=files.length<2;previous.disabled=index<=0;next.disabled=index>=files.length-1;
    const move=delta=>{const target=files[index+delta];if(!target)return;previewAttachment(taskId,target.id,collection);document.querySelector(delta<0?'[data-file-prev]:not(:disabled)':'[data-file-next]:not(:disabled)')?.focus({preventScroll:true});};previous.onclick=()=>move(-1);next.onclick=()=>move(1);
    const checksumToggle=layer.querySelector('.file-integrity-toggle');
    if(checksumToggle)checksumToggle.onclick=()=>{const open=checksumToggle.getAttribute('aria-expanded')!=='true',content=layer.querySelector('.file-integrity-content');checksumToggle.setAttribute('aria-expanded',String(open));content.setAttribute('aria-hidden',String(!open));content.inert=!open;checksumToggle.closest('.file-integrity').classList.toggle('is-expanded',open);};
    const host=layer.querySelector('.file-preview-content'),ext=extension(file),kind=file.previewKind||(['png','jpg','jpeg','webp','gif','avif'].includes(ext)?'image':ext==='pdf'?'pdf':['html','htm'].includes(ext)?'html':['md','markdown'].includes(ext)?'markdown':'text');
    if(switching&&ext!=='pdf')UIMotion.animate(host,[{opacity:0},{opacity:1}]);host.dataset.format=ext;host.setAttribute('role','region');host.setAttribute('aria-label','File preview');
    const detailsButton=layer.querySelector('[data-file-details]'),detailsPanel=layer.querySelector('.file-info'),detailsBody=layer.querySelector('.file-preview-body'),owner=preview;
    mountRetentionHelp(layer,owner);owner.detailsPanel=detailsPanel;detailsButton.setAttribute('aria-expanded',String(detailsOpen));detailsPanel.hidden=!detailsOpen;detailsBody.classList.toggle('has-details',detailsOpen);
    owner.detailsMedia=matchMedia('(max-width:600px)');owner.detailsSync=()=>{const covered=owner.detailsMedia.matches&&detailsButton.getAttribute('aria-expanded')==='true';host.inert=covered;if(covered)host.setAttribute('aria-hidden','true');else host.removeAttribute('aria-hidden');};owner.detailsMedia.addEventListener('change',owner.detailsSync);owner.detailsSync();
    detailsButton.onclick=()=>{owner.hideRetentionHelp?.();const open=detailsButton.getAttribute('aria-expanded')!=='true';detailsButton.setAttribute('aria-expanded',String(open));UIMotion.visibility(detailsPanel,open);detailsBody.classList.toggle('has-details',open);owner.detailsSync();};
    if(file.state&&file.state!=='available'){host.textContent=file.state==='cleaned'?'Temporary file removed during storage cleanup.':'Attachment removed.';return;}
    if(!file.url){UIHTML(host,'<div class="preview-unavailable">File bytes are unavailable. Try downloading the file again.</div>');return;}
    if(kind==='image')renderImage(host,file,preview,layer.querySelector('.file-tools'));
    else if(kind==='html')renderHTML(host,file);
    else if(kind==='pdf')renderPDF(host,file);
    else if(canPreview(file))renderText(host,file,ext);
    else UIHTML(host,'<div class="preview-unavailable">Preview is not available for this format. Download the original file.</div>');
  }
  function renderImage(host,file,owner,tools){
    UIHTML(host,`<div class="image-controls"><div class="preview-control-group"><button class="btn quiet" data-image-fit>Fit</button><span class="preview-position" data-image-zoom>100%</span><button class="btn icon" aria-label="Zoom out" data-image-out>−</button><button class="btn icon" aria-label="Zoom in" data-image-in>+</button></div></div><div class="image-stage" tabindex="0" role="region" aria-label="Image"><div class="preview-unavailable" data-image-loading role="status">Loading image…</div><div class="image-canvas" hidden><img alt="${escape(file.name)}" src="${escape(file.url)}"></div></div>`);
    const controls=host.querySelector('.image-controls');tools?.append(controls);
    const stage=host.querySelector('.image-stage'),image=host.querySelector('img');
    const layoutImage=()=>{if(!previewActive(owner,host)||!image.naturalWidth)return;const fit=Math.min(1,Math.max(1,stage.clientWidth-48)/image.naturalWidth,Math.max(1,stage.clientHeight-48)/image.naturalHeight);image.style.width=Math.round(image.naturalWidth*fit*owner.scale)+'px';image.style.height=Math.round(image.naturalHeight*fit*owner.scale)+'px';stage.classList.toggle('is-zoomed',owner.scale>1);controls.querySelector('[data-image-zoom]').textContent=(fit*owner.scale<.01?'<1':Math.round(fit*owner.scale*100))+'%';};
    const zoom=(amount,event)=>{if(controls.querySelector('[data-image-in]').disabled&&controls.querySelector('[data-image-out]').disabled)return;const before=image.getBoundingClientRect(),anchor=event&&before.width&&before.height?{x:Math.max(0,Math.min(1,(event.clientX-before.left)/before.width)),y:Math.max(0,Math.min(1,(event.clientY-before.top)/before.height))}:null;owner.scale=Math.max(.5,Math.min(4,owner.scale+amount));layoutImage();if(anchor){const after=image.getBoundingClientRect();stage.scrollLeft+=after.left+after.width*anchor.x-event.clientX;stage.scrollTop+=after.top+after.height*anchor.y-event.clientY;}controls.querySelector('[data-image-out]').disabled=owner.scale===.5;controls.querySelector('[data-image-in]').disabled=owner.scale===4;};
    controls.querySelector('[data-image-out]').onclick=()=>zoom(-.25);controls.querySelector('[data-image-in]').onclick=()=>zoom(.25);bindWheelZoom(stage,owner,zoom);
    controls.querySelector('[data-image-fit]').onclick=()=>{owner.scale=1;zoom(0);stage.scrollLeft=0;stage.scrollTop=0;};
    image.onload=()=>{if(!previewActive(owner,host))return;host.querySelector('[data-image-loading]')?.remove();host.querySelector('.image-canvas').hidden=false;layoutImage();UIMotion.fade(image);};image.onerror=()=>{if(!previewActive(owner,host))return;UIHTML(stage,'<div class="preview-unavailable">This image could not be displayed. Try downloading the original.</div>');controls.querySelectorAll('[data-image-fit],[data-image-in],[data-image-out]').forEach(button=>button.disabled=true);};if(image.complete&&image.naturalWidth)image.onload();
    if(window.ResizeObserver){owner.imageResize=new ResizeObserver(layoutImage);owner.imageResize.observe(stage);}
    let drag;stage.onpointerdown=e=>{if(e.button!==0)return;drag={x:e.clientX,y:e.clientY,left:stage.scrollLeft,top:stage.scrollTop};stage.setPointerCapture(e.pointerId);};stage.onpointermove=e=>{if(drag){stage.scrollLeft=drag.left+drag.x-e.clientX;stage.scrollTop=drag.top+drag.y-e.clientY;}};stage.onpointerup=()=>drag=null;stage.onpointercancel=()=>drag=null;
  }
  async function sourceFor(file,url,owner=preview,host=null){
    const current=cachedSource(file.id);if(current)return current;if(!url)return null;
    const session=window.DATA.session?.id,controller=new AbortController();
    owner.sourceController=controller;owner.sourceTimeout=setTimeout(()=>controller.abort(),30000);
    try{
      // Name the person the page shows, as API requests do.
      const person=window.DATA.session?.userId;
      const response=await fetch(url,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:person?{'X-Oneloop-User':person}:{}});
      if(!response.ok)throw new Error('Preview unavailable.');
      const buffer=await response.arrayBuffer();
      if(controller.signal.aborted||!previewActive(owner,host)||window.DATA.session?.id!==session)throw new DOMException('Preview closed','AbortError');
      const source={blob:new Blob([buffer]),buffer};cacheSource(file.id,source);return source;
    }finally{clearTimeout(owner.sourceTimeout);}
  }
  function renderText(host,file,ext){
    const current=cachedSource(file.id);if(current){showText(host,file,ext,current);return;}
    UIHTML(host,'<p class="access-note" role="status">Loading preview…</p>');
    sourceFor(file,file.sourceUrl).then(source=>{if(!source||preview?.fileId!==file.id)return;showText(host,file,ext,source);}).catch(()=>{if(preview?.fileId===file.id)UIHTML(host,'<div class="preview-unavailable">Preview unavailable. Download the original file.</div>');});
  }
  function showText(host,file,ext,source){
    host.replaceChildren();const text=new TextDecoder().decode(source.buffer.slice(0,200000));if(['md','markdown'].includes(ext)){FileViews.markdown(host,file,text,file.size>200000,file.markdownContext);return;}FileViews.text(host,file,text,file.size>200000);
  }
  function renderHTML(host,file){
    const current=cachedSource(file.id);if(current){showHTML(host,file,current);return;}
    sourceFor(file,file.sourceUrl).then(source=>{if(preview?.fileId!==file.id)return;if(!source){UIHTML(host,'<div class="preview-unavailable">Preview unavailable. Download the original file.</div>');return;}showHTML(host,file,source);}).catch(()=>{if(preview?.fileId===file.id)UIHTML(host,'<div class="preview-unavailable">Preview unavailable. Download the original file.</div>');});
  }
  function showHTML(host,file,source){
    if(source.buffer.byteLength>1024*1024){UIHTML(host,'<div class="preview-unavailable">HTML preview is limited to 1 MiB. Download the original file to view it.</div>');return;}
    FileViews.html(host,file,new TextDecoder().decode(source.buffer));
  }

  async function renderPDF(host,file,owner=preview,tools=host.closest('.file-dialog')?.querySelector('.file-tools')){
    let source=cachedSource(file.id);UIHTML(host,'<p class="access-note" role="status">Loading PDF…</p>');

    if(!source)try{source=await sourceFor(file,file.contentUrl,owner,host);}catch{}if(!source){UIHTML(host,'<div class="preview-unavailable">Preview unavailable. Download the original file.</div>');return;}
    try{
      const root=new URL('vendor/pdfjs/',assetBase),pdfjs=await import(new URL('pdf.mjs',root).href);
      if(!previewActive(owner,host))return;pdfjs.GlobalWorkerOptions.workerSrc=new URL('pdf.worker.mjs',root).href;
      owner.pdfLoading=pdfjs.getDocument({data:new Uint8Array(source.buffer.slice(0)),isEvalSupported:false,enableXfa:false,useWasm:false,useSystemFonts:false,useWorkerFetch:false,standardFontDataUrl:new URL('standard_fonts/',root).href,cMapUrl:new URL('cmaps/',root).href,cMapPacked:true});
      owner.pdfTimeout=setTimeout(()=>{if(previewActive(owner,host)){disposePreview(owner);host.textContent='PDF preview took too long. Download the original file.';}},30000);
      const pdf=await owner.pdfLoading.promise;if(!previewActive(owner,host))return;clearTimeout(owner.pdfTimeout);
      let pageNumber=1,zoom=1,sequence=0,requestedKey=null,paintedPage=null;
      UIHTML(host,`<div class="pdf-controls"><div class="preview-control-group"><button class="btn icon" aria-label="Previous page" data-pdf-prev>${icons.left}</button><span data-pdf-page aria-live="polite"></span><button class="btn icon" aria-label="Next page" data-pdf-next>${icons.right}</button></div><div class="preview-control-group"><button class="btn quiet" data-pdf-fit>Fit width</button><button class="btn icon" aria-label="Zoom out" data-pdf-out>−</button><button class="btn icon" aria-label="Zoom in" data-pdf-in>+</button></div></div><div class="pdf-surface" tabindex="0" role="region" aria-label="PDF page"></div>`);
      const controls=host.querySelector('.pdf-controls');tools?.append(controls);if(owner.inline&&pdf.numPages===1)controls.querySelectorAll('[data-pdf-prev],[data-pdf-next]').forEach(button=>button.hidden=true);
      const paint=async()=>{clearTimeout(owner.pdfWheelTimer);owner.pdfWheelTimer=null;if(!previewActive(owner,host))return;const width=Math.round(host.clientWidth),density=Math.min(devicePixelRatio||1,2),key=[pageNumber,zoom,width,density].join(':');if(key===requestedKey)return;requestedKey=key;const seq=++sequence;owner.pdfRender?.cancel();clearTimeout(owner.pdfTimeout);
        controls.querySelector('[data-pdf-out]').disabled=zoom===.5;controls.querySelector('[data-pdf-in]').disabled=zoom===4;
        controls.querySelector('[data-pdf-page]').textContent=`Page ${pageNumber} of ${pdf.numPages}`;controls.querySelector('[data-pdf-prev]').disabled=pageNumber===1;controls.querySelector('[data-pdf-next]').disabled=pageNumber===pdf.numPages;
        try{const page=await pdf.getPage(pageNumber);if(!previewActive(owner,host)||seq!==sequence)return;
          const natural=page.getViewport({scale:1}),fit=Math.max(100,width-40)/natural.width;
          const scale=Math.min(fit*zoom,8192/natural.width/density,8192/natural.height/density,Math.sqrt(8e6/(natural.width*natural.height*density*density))),viewport=page.getViewport({scale});
          const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width*density);canvas.height=Math.ceil(viewport.height*density);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';canvas.setAttribute('aria-label',`Page ${pageNumber} of ${pdf.numPages}`);
          owner.pdfRender=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:density===1?null:[density,0,0,density,0,0],annotationMode:0});
          owner.pdfTimeout=setTimeout(()=>{if(previewActive(owner,host)){owner.pdfRender?.cancel();host.querySelector('.pdf-surface').textContent='This page is too complex to preview. Download the original.';}},30000);
          await owner.pdfRender.promise;if(!previewActive(owner,host)||seq!==sequence)return;host.querySelector('.pdf-surface').replaceChildren(canvas);if(paintedPage!==pageNumber)UIMotion.fade(canvas);paintedPage=pageNumber;clearTimeout(owner.pdfTimeout);
        }catch(error){if(!previewActive(owner,host)||seq!==sequence)return;clearTimeout(owner.pdfTimeout);requestedKey=null;if(error.name!=='RenderingCancelledException')host.querySelector('.pdf-surface').textContent='Unable to preview this page. Download the original file.';}
      };
      bindWheelZoom(host.querySelector('.pdf-surface'),owner,amount=>{const next=Math.max(.5,Math.min(4,zoom+amount));if(next===zoom)return;zoom=next;controls.querySelector('[data-pdf-out]').disabled=zoom===.5;controls.querySelector('[data-pdf-in]').disabled=zoom===4;if(!owner.pdfWheelTimer)owner.pdfWheelTimer=setTimeout(()=>{owner.pdfWheelTimer=null;if(previewActive(owner,host))paint();},80);});
      controls.querySelector('[data-pdf-prev]').onclick=()=>{if(pageNumber>1){pageNumber--;paint();}};controls.querySelector('[data-pdf-next]').onclick=()=>{if(pageNumber<pdf.numPages){pageNumber++;paint();}};controls.querySelector('[data-pdf-fit]').onclick=()=>{zoom=1;paint();};controls.querySelector('[data-pdf-out]').onclick=()=>{zoom=Math.max(.5,zoom-.25);paint();};controls.querySelector('[data-pdf-in]').onclick=()=>{zoom=Math.min(4,zoom+.25);paint();};if(window.ResizeObserver){let observedWidth=Math.round(host.clientWidth);owner.pdfResize=new ResizeObserver(()=>{const width=Math.round(host.clientWidth);if(width===observedWidth)return;observedWidth=width;clearTimeout(owner.pdfResizeTimer);owner.pdfResizeTimer=setTimeout(()=>{if(previewActive(owner,host))paint();},120);});owner.pdfResize.observe(host);}await paint();
    }catch(error){clearTimeout(owner.pdfTimeout);if(previewActive(owner,host))host.textContent=error.name==='PasswordException'?'This PDF is password protected. Download it to open it.':'Unable to preview this PDF. Download the original file.';}
  }
  function download(event,taskId,fileId){const file=hooks.task(taskId)?.attachments?.find(f=>f.id===fileId);if(!window.DATA.session||!hooks.canRead(taskId)||!(file?.downloadUrl||file?.url)||file.state&&file.state!=='available'){event.preventDefault();app.toast('File unavailable','error');return false;}return true;}
  // Undo of a deletion, at the revision the deletion left. Every try has the
  // same key, so a retry after an unknown result applies once, and a failure
  // worth trying again goes to `again`, which offers Undo again.
  function restoreAttachment(taskId,task,file,again){
    transport().restoreAttachment(file.id,{expectedRevision:file.revision+1,idempotencyKey:file.restoreKey ||= crypto.randomUUID()}).then(()=>{if(sameTask(taskId,task))loadProduction(taskId,true);app.toast('Attachment restored');}).catch(error=>{if(sameTask(taskId,task))loadProduction(taskId,true);const message=errorMessage(error,'Attachment could not be restored.');if(again&&window.OneloopRetryable?.(error))again(message);else app.toast(message,'error');});
  }
  function reorderAttachment(taskId,fileId,targetId,after=false){
    const file=editableAttachment(taskId,fileId,true),task=hooks.task(taskId);if(!file||fileId===targetId)return false;if(reorderPending.has(fileId)){app.toast('This attachment is still being reordered.','info');return false;}
    const target=task.attachments.find(f=>f.id===targetId&&f.state!=='removed');if(!target)return false;
    const before=task.attachments.map(f=>f.id),ordered=task.attachments.filter(f=>f.id!==fileId),index=ordered.indexOf(target)+(after?1:0);ordered.splice(index,0,file);
    if(ordered.every((f,i)=>f===task.attachments[i]))return false;
    task.attachments=ordered;
    reorderPending.add(fileId);transport().reorderAttachment(task.internalId||taskId,{attachmentId:fileId,targetId,after,expectedRevision:file.revision,idempotencyKey:crypto.randomUUID()}).then(result=>{const current=sameTask(taskId,task);if(!current)return;current.attachments=(result.items||[]).map(serverFile);hooks.refreshAttachments(taskId);app.toast('Attachment order updated');}).catch(error=>{const current=sameTask(taskId,task);if(current&&current.attachments===ordered){current.attachments=before.map(id=>ordered.find(f=>f.id===id)).filter(Boolean);hooks.refreshAttachments(taskId);}if(error?.status===409||error?.uncertain)loadProduction(taskId,true);app.toast(errorMessage(error,'Attachment order could not be updated.'),'error');}).finally(()=>reorderPending.delete(fileId));
    hooks.refreshAttachments(taskId);
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
    const handle=event.target.closest?.('#app .task-attachments [data-reorder-file]');if(!handle||event.button!==0||handle.closest('[inert]')||document.querySelector('.file-overlay,.confirmation-layer,.modal,.peek')||!hooks.can(handle.dataset.reorderTask))return;
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
    const handle=event.target.closest?.('#app .task-attachments [data-reorder-file]');if(!handle||handle.closest('[inert]')||document.querySelector('.file-overlay,.confirmation-layer,.modal,.peek')||!hooks?.can(handle.dataset.reorderTask)||!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    event.preventDefault();const task=hooks.task(handle.dataset.reorderTask),files=(task?.attachments||[]).filter(f=>f.state!=='removed'),index=files.findIndex(f=>f.id===handle.dataset.reorderFile),next=event.key==='Home'?0:event.key==='End'?files.length-1:index+(event.key==='ArrowDown'?1:-1),target=files[next];if(target)reorderAttachment(task.id,handle.dataset.reorderFile,target.id,next>index);
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
    const zone=dropZone(event),allowed=zone&&hooks?.can(zone.dataset.uploadTask);setDropHighlight(allowed?zone:null);
    event.dataTransfer.dropEffect=allowed?'copy':'none';
  },true);
  document.addEventListener('dragleave',event=>{
    if(!fileDrag(event))return;
    if(event.relatedTarget&&!document.querySelector('.task-attachments')?.contains(event.relatedTarget)||!event.relatedTarget&&[document.body,document.documentElement].includes(event.target))clearDropHighlight();
  },true);
  document.addEventListener('drop',event=>{
    if(!fileDrag(event))return;event.preventDefault();event.stopPropagation();const zone=dropZone(event);clearDropHighlight();
    if(!zone){app.toast(document.querySelector('.task-page')?'Drop files in the attachment section':'Open a task to attach files','info');return;}
    const taskId=zone.dataset.uploadTask;
    if(!hooks.task(taskId)){app.toast('This task is no longer available','error');return;}
    if(!hooks.can(taskId)){app.toast('You no longer have permission to upload attachments','error');return;}
    const items=Array.from(event.dataTransfer.items||[]),directories=items.filter(item=>item.kind==='file'&&item.webkitGetAsEntry?.()?.isDirectory);
    if(directories.length)app.toast('Folders are not supported. Drop individual files instead.','error');
    const files=items.some(item=>item.kind==='file')?items.filter(item=>item.kind==='file'&&!directories.includes(item)).map(item=>item.getAsFile()).filter(Boolean):Array.from(event.dataTransfer.files||[]);
    if(files.length)app.attachFiles(taskId,{files,value:''});
    else if(!directories.length)app.toast('Could not read dropped files. Choose files instead.','error');
  },true);
  document.addEventListener('dragend',clearDropHighlight);window.addEventListener('blur',clearDropHighlight);window.addEventListener('hashchange',clearDropHighlight);
  document.addEventListener('keydown',e=>{if(!preview)return;if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(preview.hideRetentionHelp?.())return;closePreview();}if(e.key==='Tab'){const items=[...document.querySelectorAll('.file-dialog button:not(:disabled),.file-dialog a[href],.file-dialog input:not(:disabled),.file-dialog summary,.file-dialog [tabindex="0"]')].filter(el=>!el.closest('[hidden]')&&el.getClientRects().length),first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}},true);
  window.addEventListener('hashchange',closePreview);
  window.Uploads={validateAccess(){if(preview&&!(preview.collection?preview.collection.canRead():hooks.canRead(preview.taskId)))closePreview();},
    /** Show an image or PDF inside a page, with its controls in `tools`. Returns a disposer. */
    mountInlinePreview(host,file,tools){
      const owner={inline:true,disposed:false,scale:1};
      if(file.previewKind==='pdf')renderPDF(host,file,owner,tools);
      else if(file.previewKind==='image')renderImage(host,file,owner,tools);
      return ()=>disposePreview(owner);
    },
    /** Open read-only files, such as synced Knowledge files, in the file dialog. */
    previewCollection(files,fileId,canRead){if(typeof canRead==='function'&&canRead())previewAttachment(null,fileId,{files,canRead});},mount,attachmentHeader,renderAttachments,storageHtml,available,canPreview,get limits(){return {file:maxFile(),avatar:maxAvatar(),count:maxFiles()};},clearAccount(){closePreview();sources.clear();jobs.splice(0).forEach(job=>{job.cancelled=true;job.reader?.abort();});productionLoaded=new WeakSet();productionLoading.clear();productionRefreshPending.clear();retentionPending.clear();reorderPending.clear();attachmentsRead=new Set();serverStorage=null;serverStorageState='unloaded';serverStorageRead=false;},
    bind(api,callbacks){app=api;hooks=callbacks;
      let accountScope=window.DATA.session?.id;
      runtimeUnsubscribe?.();runtimeUnsubscribe=window.OneloopTransport?.subscribe?.(change=>{if(change?.type==='auth'&&accountScope!==window.DATA.session?.id){window.Uploads.clearAccount();accountScope=window.DATA.session?.id;}if(change?.type==='bootstrap'){productionLoaded=new WeakSet();serverStorage=null;serverStorageState='unloaded';return;}if(change?.type==='sse'){if(app.context?.().view==='storage')loadStorageUsage({background:true});if(change.taskId&&(!change.entityType||['attachment','task'].includes(change.entityType))){const changedTask=hooks.task(change.taskId);if(changedTask)loadProduction(changedTask.id,true,true);}}});
      app.retryStorageUsage=()=>loadStorageUsage();
      app.reorderAttachment=reorderAttachment;app.openAttachment=openAttachment;app.previewAttachment=previewAttachment;app.downloadAttachment=download;app.setAttachmentTemporary=setTemporary;
      app.cleanupStorage=()=>{if(!hooks.me()?.admin||window.Recovery&&!Recovery.ensureOnline())return;transport().cleanupStorage().then(report=>{serverStorage=null;return loadStorageUsage().then(()=>app.toast(report.temporaryFilesCleaned?`Removed ${report.temporaryFilesCleaned} temporary ${report.temporaryFilesCleaned===1?'file':'files'} (${size(report.bytesReclaimed)})`:'No temporary files are eligible for cleanup','info'));}).catch(error=>app.toast(errorMessage(error,'Storage cleanup could not be completed.'),'error'));};
      app.delAttachment=(id,index)=>{const task=hooks.task(id),file=task?.attachments?.[index];if(!editableAttachment(id,file?.id,true))return;hooks.confirm({title:'Delete attachment?',text:`${displayText(file.name)} will be deleted. You can undo this right after.`,action:'Delete attachment',confirm:()=>{if(!editableAttachment(id,file.id,true))return;if(!sameTask(id,task)){app.toast('This task is no longer available.','error');return;}transport().deleteAttachment(file.id,{expectedRevision:file.revision,idempotencyKey:file.deleteKey ||= crypto.randomUUID()}).then(()=>{const current=sameTask(id,task);if(current)current.attachments=current.attachments.filter(item=>item.id!==file.id);sources.delete(file.id);if(preview?.fileId===file.id)closePreview();hooks.refreshAttachments(id);app.offerUndo('Attachment deleted',again=>restoreAttachment(id,task,file,again));}).catch(error=>{if(error?.status===404||error?.status===409||error?.uncertain)loadProduction(id,true);app.toast(errorMessage(error,'Attachment could not be deleted.'),'error');});}});};
      app.chooseAttachments=()=>document.getElementById('attIn')?.click();
      app.attachFiles=(id,input)=>{if(!hooks.can(id)){app.toast('You no longer have permission to upload attachments','error');return;}for(const file of [...input.files]){const job={id:'upload-'+(++next),taskId:id,file,owner:window.DATA.session?.userId,ephemeral:false,state:'queued',progress:0};jobs.push(job);start(job);}input.value='';};
    }
  };
})();
