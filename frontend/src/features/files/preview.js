// @ts-check

/**
 * File previews, which attachments and Knowledge share: the file dialog, and
 * images and PDFs shown inside a page. Text formats show through
 * file-views.js.
 */

import { placeNear, trapFocus } from '../../app/layers.js';
import { escapeHtml } from '../../app/markup.js';
import { UIMotion } from '../../app/motion.js';
import { setTrustedHTML } from '../../app/trusted-types.js';
import { htmlView, markdownView, textView } from './file-views.js';

// The app's files, as this module's address names them: `/v/<version>/` in a
// release, so PDF.js comes from the same version.
const assetBase=new URL('../../../',import.meta.url);
const PREVIEW_CACHE_BYTES=64*1024*1024;
/** The element `selector` finds in `root`. @param {ParentNode} root @param {string} selector */
const find=(root,selector)=>/** @type {HTMLElement} */ (root.querySelector(selector));

const textExtensions=new Set('txt log md markdown mdx json jsonc jsonl ndjson csv tsv yaml yml toml xml ini cfg conf config properties sql graphql gql js mjs cjs jsx ts mts cts tsx py pyi rs go java c h cc cpp cxx hpp cs php rb swift kt kts scala dart lua pl pm r sh bash zsh fish ps1 bat cmd css scss sass less svelte vue astro diff patch gitignore gitattributes editorconfig env dockerfile makefile cmake tex rst adoc svg'.split(' '));
const textNames=new Set(['.dockerignore', '.editorconfig', '.env', '.gitattributes', '.gitignore', '.npmrc', '.nvmrc', 'authors', 'changelog', 'containerfile', 'dockerfile', 'gemfile', 'gnumakefile', 'justfile', 'licence', 'license', 'makefile', 'notice', 'procfile', 'rakefile', 'readme']);
/** A file name without the direction controls that could make it read as another. */
export const displayText=value=>String(value??'').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'');
const escape=value=>escapeHtml(displayText(value));
/** A byte count as people read it, such as 1.5 MiB. */
export const byteSize=n=>n>=1073741824?(n/1073741824).toFixed(n%1073741824?1:0)+' GiB':n>=1048576?(n/1048576).toFixed(1)+' MiB':n>=1024?Math.round(n/1024)+' KiB':n+' B';
/** A file's extension, in lowercase. */
export const fileExtension=file=>file.name.split('.').pop().toLowerCase();
/** Whether the file dialog can show `file`; the server says so for files it lists. */
export const canPreview=file=>Object.hasOwn(file,'previewKind')?!!file.previewKind:['png','jpg','jpeg','webp','gif','avif','pdf','html','htm'].includes(fileExtension(file))||textExtensions.has(fileExtension(file))||textNames.has(file.name.toLowerCase());
const icon=paths=>`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
/** The icons of files and their actions. */
export const fileIcons={plus:icon('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),grip:icon('<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" stroke-width="3"/>'),close:icon('<path d="m6 6 12 12M6 18 18 6"/>'),info:icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>'),left:icon('<path d="m14 6-6 6 6 6"/>'),right:icon('<path d="m10 6 6 6-6 6"/>'),clock:icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),document:icon('<path d="M14 2H5v20h14V7L14 2Z"/><path d="M14 2v6h5M8 12h8M8 16h6"/>'),preview:icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),download:icon('<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>'),remove:icon('<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>')};

/** Recently shown files, by id, so going back to one shows it at once. */
const sources=new Map();
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

/**
 * The dialog's preview, while it shows: what opened it, with the file it
 * shows. The dialog's renderers take it as their owner.
 * @type {any}
 */
let preview=null;
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
    const {left,top}=placeNear(r,tip,{align:'end',gap:8});tip.style.left=left+'px';tip.style.top=top+'px';
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
/** Close the file dialog, and give focus back to where it was. */
export function closePreview(){if(!preview)return;disposePreview(preview);const focus=preview.focus;UIMotion.remove(document.querySelector('.file-overlay'));document.getElementById('app').inert=false;preview=null;if(focus?.isConnected)focus.focus({preventScroll:true});}
/**
 * Show `file` in the file dialog, or switch the dialog that shows to it.
 * Previous and Next step through `files`, and `open(id)` shows one of them;
 * `details` is the list the Details panel shows. While the dialog shows,
 * `canRead` says whether the person may still see the file, and `key` names
 * what opened it, such as its task.
 * @param {{file:any,files:any[],details:string,canRead:()=>boolean,session:()=>any,open:(id:string)=>void,download?:(event:Event)=>unknown,key?:string|null}} request
 */
export function previewFile(request){
  const {file}=request;
  const existingLayer=preview?/** @type {HTMLElement|null} */ (document.querySelector('.file-overlay:not([data-motion-exiting])')):null,switching=!!existingLayer,detailsOpen=existingLayer?.querySelector('[data-file-details]')?.getAttribute('aria-expanded')==='true',oldFocus=preview?.focus||document.activeElement;disposePreview(preview);existingLayer?.querySelectorAll('iframe').forEach(frame=>frame.remove());preview={...request,fileId:file.id,scale:1,focus:oldFocus};file.lastAccessAt=Date.now();
  /** @type {HTMLElement} */
  let layer=document.createElement('div');layer.className='file-overlay';setTrustedHTML(layer,`<div class="scrim"></div><section class="file-dialog" role="dialog" aria-modal="true" aria-labelledby="file-preview-title"><header><span class="file-preview-symbol" aria-hidden="true">${fileIcons.document}</span><div class="file-preview-heading"><h2 id="file-preview-title" data-tip="${escape(file.name)}" data-tip-overflow>${escape(file.name)}</h2><span>${escape(fileExtension(file).toUpperCase())}<span aria-hidden="true"> · </span>${byteSize(file.size)}</span></div><button class="btn quiet file-details-toggle" aria-label="File details" aria-expanded="false" aria-controls="file-preview-details" data-file-details>${fileIcons.info}<span>Details</span></button><a class="btn primary" href="${escape(file.downloadUrl||file.url||'#')}" download="${escape(file.name)}" data-file-download aria-label="Download ${escape(file.name)}">${fileIcons.download}<span>Download</span></a><button class="btn icon" aria-label="Close file preview" data-file-close title="Close preview (Esc)">${fileIcons.close}</button></header><div class="file-toolbar"><div class="file-navigation" role="group" aria-label="Attachment navigation"><button class="btn icon" aria-label="Previous file" data-file-prev>${fileIcons.left}</button><span class="preview-position" data-file-position></span><button class="btn icon" aria-label="Next file" data-file-next>${fileIcons.right}</button></div><div class="file-tools"></div></div><div class="file-preview-body"><div class="file-preview-content"></div><aside class="file-info" id="file-preview-details" hidden><h3>File details</h3><dl>${request.details}</dl>${file.checksum?`<div class="file-integrity"><button type="button" class="file-integrity-toggle" aria-expanded="false" aria-controls="file-checksum-value"><svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="m4 2 5 4-5 4z"/></svg>File checksum</button><div class="file-integrity-content" id="file-checksum-value" aria-hidden="true" inert><div><div class="file-checksum">${escape(file.checksum)}</div></div></div></div>`:''}</aside></div></section>`);
  if(existingLayer){
    // Keep the scrim, dialog and layout mounted; only the selected file changes.
    existingLayer.querySelector('header').replaceWith(find(layer,'header'));
    existingLayer.querySelector('.file-tools').replaceChildren();
    existingLayer.querySelector('.file-navigation').replaceChildren(...find(layer,'.file-navigation').childNodes);
    existingLayer.querySelector('.file-preview-content').replaceWith(find(layer,'.file-preview-content'));
    existingLayer.querySelector('.file-info').replaceWith(find(layer,'.file-info'));
    layer=existingLayer;
  }else{document.body.append(layer);UIMotion.enter(find(layer,'.file-dialog'));}
  find(document,'#app').inert=true;
  find(layer,'[data-file-close]').onclick=closePreview;find(layer,'[data-file-close]').focus();if(request.download)find(layer,'[data-file-download]').onclick=request.download;
  const files=request.files.filter(canPreview),index=files.indexOf(file),previous=/** @type {HTMLButtonElement} */ (find(layer,'[data-file-prev]')),next=/** @type {HTMLButtonElement} */ (find(layer,'[data-file-next]'));
  find(layer,'[data-file-position]').textContent=`File ${index+1} of ${files.length}`;find(layer,'.file-navigation').hidden=files.length<2;previous.disabled=index<=0;next.disabled=index>=files.length-1;
  const move=delta=>{const target=files[index+delta];if(!target)return;request.open(target.id);find(document,delta<0?'[data-file-prev]:not(:disabled)':'[data-file-next]:not(:disabled)')?.focus({preventScroll:true});};previous.onclick=()=>move(-1);next.onclick=()=>move(1);
  const checksumToggle=find(layer,'.file-integrity-toggle');
  if(checksumToggle)checksumToggle.onclick=()=>{const open=checksumToggle.getAttribute('aria-expanded')!=='true',content=find(layer,'.file-integrity-content');checksumToggle.setAttribute('aria-expanded',String(open));content.setAttribute('aria-hidden',String(!open));content.inert=!open;checksumToggle.closest('.file-integrity').classList.toggle('is-expanded',open);};
  const host=find(layer,'.file-preview-content'),ext=fileExtension(file),kind=file.previewKind||(['png','jpg','jpeg','webp','gif','avif'].includes(ext)?'image':ext==='pdf'?'pdf':['html','htm'].includes(ext)?'html':['md','markdown'].includes(ext)?'markdown':'text');
  if(switching&&ext!=='pdf')UIMotion.animate(host,[{opacity:0},{opacity:1}]);host.dataset.format=ext;host.setAttribute('role','region');host.setAttribute('aria-label','File preview');
  const detailsButton=find(layer,'[data-file-details]'),detailsPanel=find(layer,'.file-info'),detailsBody=find(layer,'.file-preview-body'),owner=preview;
  mountRetentionHelp(layer,owner);owner.detailsPanel=detailsPanel;detailsButton.setAttribute('aria-expanded',String(detailsOpen));detailsPanel.hidden=!detailsOpen;detailsBody.classList.toggle('has-details',detailsOpen);
  owner.detailsMedia=matchMedia('(max-width:600px)');owner.detailsSync=()=>{const covered=owner.detailsMedia.matches&&detailsButton.getAttribute('aria-expanded')==='true';host.inert=covered;if(covered)host.setAttribute('aria-hidden','true');else host.removeAttribute('aria-hidden');};owner.detailsMedia.addEventListener('change',owner.detailsSync);owner.detailsSync();
  detailsButton.onclick=()=>{owner.hideRetentionHelp?.();const open=detailsButton.getAttribute('aria-expanded')!=='true';detailsButton.setAttribute('aria-expanded',String(open));UIMotion.visibility(detailsPanel,open);detailsBody.classList.toggle('has-details',open);owner.detailsSync();};
  if(!file.url){setTrustedHTML(host,'<div class="preview-unavailable">File bytes are unavailable. Try downloading the file again.</div>');return;}
  if(kind==='image')renderImage(host,file,preview,find(layer,'.file-tools'));
  else if(kind==='html')renderHTML(host,file);
  else if(kind==='pdf')renderPDF(host,file);
  else if(canPreview(file))renderText(host,file,ext);
  else setTrustedHTML(host,'<div class="preview-unavailable">Preview is not available for this format. Download the original file.</div>');
}
function renderImage(host,file,owner,tools){
  setTrustedHTML(host,`<div class="image-controls"><div class="preview-control-group"><button class="btn quiet" data-image-fit>Fit</button><span class="preview-position" data-image-zoom>100%</span><button class="btn icon" aria-label="Zoom out" data-image-out>−</button><button class="btn icon" aria-label="Zoom in" data-image-in>+</button></div></div><div class="image-stage" tabindex="0" role="region" aria-label="Image"><div class="preview-unavailable" data-image-loading role="status">Loading image…</div><div class="image-canvas" hidden><img alt="${escape(file.name)}" src="${escape(file.url)}"></div></div>`);
  const controls=host.querySelector('.image-controls');tools?.append(controls);
  const stage=host.querySelector('.image-stage'),image=host.querySelector('img');
  const layoutImage=()=>{if(!previewActive(owner,host)||!image.naturalWidth)return;const fit=Math.min(1,Math.max(1,stage.clientWidth-48)/image.naturalWidth,Math.max(1,stage.clientHeight-48)/image.naturalHeight);image.style.width=Math.round(image.naturalWidth*fit*owner.scale)+'px';image.style.height=Math.round(image.naturalHeight*fit*owner.scale)+'px';stage.classList.toggle('is-zoomed',owner.scale>1);controls.querySelector('[data-image-zoom]').textContent=(fit*owner.scale<.01?'<1':Math.round(fit*owner.scale*100))+'%';};
  const zoom=(amount,event)=>{if(controls.querySelector('[data-image-in]').disabled&&controls.querySelector('[data-image-out]').disabled)return;const before=image.getBoundingClientRect(),anchor=event&&before.width&&before.height?{x:Math.max(0,Math.min(1,(event.clientX-before.left)/before.width)),y:Math.max(0,Math.min(1,(event.clientY-before.top)/before.height))}:null;owner.scale=Math.max(.5,Math.min(4,owner.scale+amount));layoutImage();if(anchor){const after=image.getBoundingClientRect();stage.scrollLeft+=after.left+after.width*anchor.x-event.clientX;stage.scrollTop+=after.top+after.height*anchor.y-event.clientY;}controls.querySelector('[data-image-out]').disabled=owner.scale===.5;controls.querySelector('[data-image-in]').disabled=owner.scale===4;};
  controls.querySelector('[data-image-out]').onclick=()=>zoom(-.25);controls.querySelector('[data-image-in]').onclick=()=>zoom(.25);bindWheelZoom(stage,owner,zoom);
  controls.querySelector('[data-image-fit]').onclick=()=>{owner.scale=1;zoom(0);stage.scrollLeft=0;stage.scrollTop=0;};
  image.onload=()=>{if(!previewActive(owner,host))return;host.querySelector('[data-image-loading]')?.remove();host.querySelector('.image-canvas').hidden=false;layoutImage();UIMotion.fade(image);};image.onerror=()=>{if(!previewActive(owner,host))return;setTrustedHTML(stage,'<div class="preview-unavailable">This image could not be displayed. Try downloading the original.</div>');controls.querySelectorAll('[data-image-fit],[data-image-in],[data-image-out]').forEach(button=>button.disabled=true);};if(image.complete&&image.naturalWidth)image.onload();
  if(window.ResizeObserver){owner.imageResize=new ResizeObserver(layoutImage);owner.imageResize.observe(stage);}
  let drag;stage.onpointerdown=e=>{if(e.button!==0)return;drag={x:e.clientX,y:e.clientY,left:stage.scrollLeft,top:stage.scrollTop};stage.setPointerCapture(e.pointerId);};stage.onpointermove=e=>{if(drag){stage.scrollLeft=drag.left+drag.x-e.clientX;stage.scrollTop=drag.top+drag.y-e.clientY;}};stage.onpointerup=()=>drag=null;stage.onpointercancel=()=>drag=null;
}
async function sourceFor(file,url,owner=preview,host=null){
  const current=cachedSource(file.id);if(current)return current;if(!url)return null;
  const session=owner.session()?.id,controller=new AbortController();
  owner.sourceController=controller;owner.sourceTimeout=setTimeout(()=>controller.abort(),30000);
  try{
    // Name the person the page shows, as API requests do.
    const person=owner.session()?.userId;
    const response=await fetch(url,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:person?{'X-Oneloop-User':person}:{}});
    if(!response.ok)throw new Error('Preview unavailable.');
    const buffer=await response.arrayBuffer();
    if(controller.signal.aborted||!previewActive(owner,host)||owner.session()?.id!==session)throw new DOMException('Preview closed','AbortError');
    const source={blob:new Blob([buffer]),buffer};cacheSource(file.id,source);return source;
  }finally{clearTimeout(owner.sourceTimeout);}
}
function renderText(host,file,ext){
  const current=cachedSource(file.id);if(current){showText(host,file,ext,current);return;}
  setTrustedHTML(host,'<p class="access-note" role="status">Loading preview…</p>');
  sourceFor(file,file.sourceUrl).then(source=>{if(!source||preview?.fileId!==file.id)return;showText(host,file,ext,source);}).catch(()=>{if(preview?.fileId===file.id)setTrustedHTML(host,'<div class="preview-unavailable">Preview unavailable. Download the original file.</div>');});
}
function showText(host,file,ext,source){
  host.replaceChildren();const text=new TextDecoder().decode(source.buffer.slice(0,200000));if(['md','markdown'].includes(ext)){markdownView(host,file,text,file.size>200000,file.markdownContext);return;}textView(host,file,text,file.size>200000);
}
function renderHTML(host,file){
  const current=cachedSource(file.id);if(current){showHTML(host,file,current);return;}
  sourceFor(file,file.sourceUrl).then(source=>{if(preview?.fileId!==file.id)return;if(!source){setTrustedHTML(host,'<div class="preview-unavailable">Preview unavailable. Download the original file.</div>');return;}showHTML(host,file,source);}).catch(()=>{if(preview?.fileId===file.id)setTrustedHTML(host,'<div class="preview-unavailable">Preview unavailable. Download the original file.</div>');});
}
function showHTML(host,file,source){
  if(source.buffer.byteLength>1024*1024){setTrustedHTML(host,'<div class="preview-unavailable">HTML preview is limited to 1 MiB. Download the original file to view it.</div>');return;}
  htmlView(host,file,new TextDecoder().decode(source.buffer));
}

async function renderPDF(host,file,owner=preview,tools=host.closest('.file-dialog')?.querySelector('.file-tools')){
  let source=cachedSource(file.id);setTrustedHTML(host,'<p class="access-note" role="status">Loading PDF…</p>');

  if(!source)try{source=await sourceFor(file,file.contentUrl,owner,host);}catch{}if(!source){setTrustedHTML(host,'<div class="preview-unavailable">Preview unavailable. Download the original file.</div>');return;}
  try{
    const root=new URL('vendor/pdfjs/',assetBase),pdfjs=await import(new URL('pdf.mjs',root).href);
    if(!previewActive(owner,host))return;pdfjs.GlobalWorkerOptions.workerSrc=new URL('pdf.worker.mjs',root).href;
    owner.pdfLoading=pdfjs.getDocument({data:new Uint8Array(source.buffer.slice(0)),isEvalSupported:false,enableXfa:false,useWasm:false,useSystemFonts:false,useWorkerFetch:false,standardFontDataUrl:new URL('standard_fonts/',root).href,cMapUrl:new URL('cmaps/',root).href,cMapPacked:true});
    owner.pdfTimeout=setTimeout(()=>{if(previewActive(owner,host)){disposePreview(owner);host.textContent='PDF preview took too long. Download the original file.';}},30000);
    const pdf=await owner.pdfLoading.promise;if(!previewActive(owner,host))return;clearTimeout(owner.pdfTimeout);
    let pageNumber=1,zoom=1,sequence=0,requestedKey=null,paintedPage=null;
    setTrustedHTML(host,`<div class="pdf-controls"><div class="preview-control-group"><button class="btn icon" aria-label="Previous page" data-pdf-prev>${fileIcons.left}</button><span data-pdf-page aria-live="polite"></span><button class="btn icon" aria-label="Next page" data-pdf-next>${fileIcons.right}</button></div><div class="preview-control-group"><button class="btn quiet" data-pdf-fit>Fit width</button><button class="btn icon" aria-label="Zoom out" data-pdf-out>−</button><button class="btn icon" aria-label="Zoom in" data-pdf-in>+</button></div></div><div class="pdf-surface" tabindex="0" role="region" aria-label="PDF page"></div>`);
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

/**
 * Close the file dialog with Escape and on a new address, and keep Tab inside
 * it while it shows.
 * @param {Document} doc
 */
export function installPreviews(doc){
  doc.addEventListener('keydown',e=>{if(!preview)return;if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(preview.hideRetentionHelp?.())return;closePreview();}trapFocus(e,/** @type {HTMLElement[]} */ ([...doc.querySelectorAll('.file-dialog button:not(:disabled),.file-dialog a[href],.file-dialog input:not(:disabled),.file-dialog summary,.file-dialog [tabindex="0"]')]).filter(el=>!el.closest('[hidden]')&&el.getClientRects().length));},true);
  doc.defaultView.addEventListener('hashchange',closePreview);
}

/**
 * Show an image or PDF inside a page, with its controls in `tools`. Returns a
 * disposer. `session` gives the signed-in session, for whom the file loads.
 * @param {Element} host @param {any} file @param {Element|null} tools @param {()=>any} session
 */
export function mountInlinePreview(host,file,tools,session){
  const owner={inline:true,disposed:false,scale:1,session};
  if(file.previewKind==='pdf')renderPDF(host,file,owner,tools);
  else if(file.previewKind==='image')renderImage(host,file,owner,tools);
  return ()=>disposePreview(owner);
}

/** The file the dialog shows, and what opened it, or null. */
export const shownPreview=()=>preview?{fileId:preview.fileId,key:preview.key??null}:null;

/** Close the dialog when the person may no longer see its file. */
export function checkPreviewAccess(){if(preview&&!preview.canRead())closePreview();}

/** Forget the bytes of a file, such as one that was deleted. @param {string} id */
export function forgetPreview(id){sources.delete(id);}

/** Close the dialog and forget every file, as when the person changes. */
export function resetPreviews(){closePreview();sources.clear();}
