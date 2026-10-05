// @ts-check

const EVENT_ATTRIBUTES = Object.freeze([
  'onclick', 'onsubmit', 'oninput', 'onchange', 'onblur', 'onfocus', 'onkeydown',
  'ondragstart', 'ondragend', 'ondragover', 'ondragleave', 'ondrop',
  'onmouseenter', 'onmouseleave',
]);

const ALLOWED_APP_METHODS = new Set([
  'addComment','addPoolItem','archiveNotification','attachFiles','blockReasonInput','boardSearchKey','cancelCommentMode','cancelPoolDescription','changePassword','cleanupStorage','clearBoardFilters','closeEpic',
  'closeOverlays','colLeave','colOver','commentInput','commentKey','commentMenu','confirmYes','copyTemporaryPassword','dateBlur','dateKey','dateTyping',
  'delAttachment','delComment','delPool','deleteEpic','deleteMilestone','deleteProject','downloadAttachment','dragEnd','dropTask',
  'editPoolDescription','epicHover','epicKey','epicLeave','expandDescription','goToday','laneOver',
  'inboxBulk','inboxFilter','jumpToComment','loadMoreBoard','loadMoreEpicActivity','loadMoreEpicTasks','loadMorePool','loadMoreUsers','loadOlderActivity','login','logout','menuAction','milestoneClick','moreInbox',
  'milestoneHover','nav','openAttachment','openModal','openNotification','openPeek','openTask','poolDescriptionKey','poolKey','popDate',
  'popMulti','popSelect','projectMenu','promotePool','removeAvatar','removeMember','reopenEpic',
  'replyComment','resetPassword','retryInbox','retryPool','retryTaskActivity','retryStorageUsage','retryProfileAccess','retryUsers','revokeAppAccess','revokeOtherSessions','revokeSession','roadmapTipKey','saveBlock',
  'saveEpic','saveMilestone','savePoolDescription','saveProjectNew','saveTask','saveTaskDraft','saveTrack','saveUser',
  'setAttachmentTemporary','setAvatar','setBlockedFilter','setMemberPermission','setNotificationRead','setPassword','setPoolTab','setTheme',
  'setBoardQ','sizeDescription','sizeDescriptionEditors','sizeTaskTitle','taskActions','taskDragStart',
  'taskMoveMenu','toggleCommentText','toggleDescription','togglePoolDescription','toggleSidebar','trackDragStart','trackDrop',
  'toggleReplies','trackReorderKey','trackMenu','toast','updMe','updTask','updateProjectField','userMenu',
]);
const ALLOWED_RECOVERY_METHODS = new Set(['activateNotice','copyReference','reconnect','retryLoad','retryRefresh','reloadClient']);

const defaultAppProvider = () => globalThis.App;
const handlerCaches = new WeakMap();
const tokenPattern = /^(?:'(?:[^'\\\r\n]|\\['"\\rn])*'|"(?:[^"\\\r\n]|\\['"\\rn])*"|this\.value|this\.checked|event|this|true|false|null|undefined|-?\d+(?:\.\d+)?)/;

function literal(token,event,element) {
  if(token==='event')return event;
  if(token==='this')return element;
  if(token==='this.value')return element.value;
  if(token==='this.checked')return element.checked;
  if(token==='true')return true;
  if(token==='false')return false;
  if(token==='null')return null;
  if(token==='undefined')return undefined;
  if(token[0]==="'"||token[0]==='"')return token.slice(1,-1).replace(/\\(['"\\rn])/g,(/** @type {string} */ _match,/** @type {string} */ char)=>char==='r'?'\r':char==='n'?'\n':char);
  return Number(token);
}

/** Parse every character of the fixed compatibility grammar; never evaluate source. */
export function compileLegacyHandler(source, appProvider = defaultAppProvider) {
  source=String(source||'').trim();
  let cache=handlerCaches.get(appProvider);
  if(!cache){cache=new Map();handlerCaches.set(appProvider,cache);}
  if(cache.has(source))return cache.get(source);
  let script=source,enterOnly=false;
  const keyboard=/^if\(event\.key==='Enter'\s*&&\s*!event\.isComposing\s*&&\s*event\.keyCode!==229\s*&&\s*!event\.repeat\)/.exec(script)?.[0];
  if(keyboard){
    const body=script.slice(keyboard.length).trim();
    if(!body.startsWith('{')||!body.endsWith('}'))throw new TypeError('Unsupported keyboard handler');
    script=body.slice(1,-1).trim();enterOnly=true;
  }
  script=script.replace(/^return\s+/,'');
  const invocations=[];
  while(script){
    const call=/^(App|Recovery|event|this)\.([A-Za-z_$][\w$]*)\s*\(/.exec(script);
    const click=/^document\.getElementById\('([\w-]+)'\)\.click\(\)/.exec(script);
    if(click){invocations.push(()=>document.getElementById(click[1])?.click());script=script.slice(click[0].length).trim();}
    else {
      if(!call)throw new TypeError('Unsupported inline handler');
      script=script.slice(call[0].length).trim();
      /** @type {string[]} */
      const tokens=[];
      while(!script.startsWith(')')){
        const token=tokenPattern.exec(script)?.[0];
        if(!token||/\b(?:App|Recovery)\.[\w$]+\s*\(/.test(token))throw new TypeError('Unsupported inline argument');
        tokens.push(token);script=script.slice(token.length).trim();
        if(script.startsWith(')'))break;
        if(!script.startsWith(','))throw new TypeError('Unsupported inline argument');
        script=script.slice(1).trim();
        if(script.startsWith(')'))throw new TypeError('Unsupported inline argument');
      }
      script=script.slice(1).trim();
      const [,owner,method]=call;
      if(owner==='App'){
        if(!ALLOWED_APP_METHODS.has(method))throw new TypeError(`Unsupported App handler: ${method}`);
        invocations.push((event,element)=>{
          const app=appProvider();if(typeof app?.[method]!=='function')return;
          if(['openModal','openPeek'].includes(method)&&element.matches?.('button,[role=button]'))element.focus({preventScroll:true});
          return app[method](...tokens.map(token=>literal(token,event,element)));
        });
      }else if(owner==='Recovery'&&!tokens.length){
        if(!ALLOWED_RECOVERY_METHODS.has(method))throw new TypeError(`Unsupported Recovery handler: ${method}`);
        invocations.push(()=>globalThis.Recovery?.[method]?.());
      }else if(owner==='event'&&!tokens.length&&['preventDefault','stopPropagation'].includes(method))invocations.push(event=>event[method]());
      else if(owner==='this'&&!tokens.length&&method==='blur')invocations.push((_event,element)=>element.blur());
      else throw new TypeError('Unsupported inline handler');
    }
    if(script&&!script.startsWith(';'))throw new TypeError('Unsupported inline handler');
    script=script.replace(/^;\s*/,'');
  }
  if(!invocations.length)throw new TypeError('Unsupported inline handler');
  function viewHandler(event){
    if(event.type==='click'&&this.matches?.('button')&&!this.disabled)this.focus({preventScroll:true});
    if(enterOnly&&(event.key!=='Enter'||event.isComposing||event.keyCode===229||event.repeat))return;
    let result;for(const invoke of invocations)result=invoke(event,this);
    if(result===false)event.preventDefault();return result;
  }
  if(cache.size>=2048)cache.delete(cache.keys().next().value);
  cache.set(source,viewHandler);return viewHandler;
}

const installedHandlers = new WeakMap();

const eventAttribute=name=>`data-oneloop-${name}`;
const watchedAttributes=EVENT_ATTRIBUTES.flatMap(name=>[name,eventAttribute(name)]);
function migrateElement(element,onError,trusted=false) {
  if(element.closest?.('.markdown-body,.file-preview-body')||!trusted&&!installedHandlers.has(element)){
    for(const [type,{handler}] of installedHandlers.get(element)??[])element.removeEventListener(type,handler);
    installedHandlers.delete(element);
    for(const attribute of watchedAttributes)element.removeAttribute(attribute);
    return;
  }
  for(const attribute of EVENT_ATTRIBUTES){
    const nativeSource=element.getAttribute?.(attribute),source=nativeSource??element.getAttribute?.(eventAttribute(attribute));
    if(source==null)continue;
    if(nativeSource!=null){element.removeAttribute(attribute);element.setAttribute(eventAttribute(attribute),source);}
    let handlers=installedHandlers.get(element);
    if(!handlers){handlers=new Map();installedHandlers.set(element,handlers);}
    const type=attribute.slice(2),previous=handlers.get(type);
    if(previous?.source===source)continue;
    if(previous)element.removeEventListener(type,previous.handler);
    handlers.delete(type);
    try{const handler=compileLegacyHandler(source);element.addEventListener(type,handler);handlers.set(type,{source,handler});}
    catch(error){onError(error,{element,attribute,source});}
  }
}

function migrateTree(root,onError,trusted=false){
  if(root.nodeType!==1&&root.nodeType!==11)return;
  if(root.nodeType===1)migrateElement(root,onError,trusted);
  for(const element of root.querySelectorAll?.(watchedAttributes.map(name=>`[${name}]`).join(','))??[])migrateElement(element,onError,trusted);
}

/** Prepare trusted UI markup while inert; preserve the bounded, non-eval handler grammar. */
export function installViewEventOwner(root=document.documentElement,{onError=(error,context)=>console.error('Rejected view event handler',context,error)}={}){
  globalThis.OneloopEventAttribute=eventAttribute;
  globalThis.OneloopSetHTML=(element,source)=>{
    const template=element.ownerDocument.createElement('template');template.innerHTML=source;
    migrateTree(template.content,onError,!element.closest?.('.markdown-body,.file-preview-body'));
    (element.tagName==='TEMPLATE'?element.content:element).replaceChildren(template.content);
  };
  globalThis.OneloopMigrateEvents=()=>migrateTree(root,onError);
  migrateTree(root,onError,true);
  const observer=new MutationObserver((records)=>{
    for(const record of records){
      if(record.type==='attributes')migrateElement(record.target,onError);
      else for(const node of record.addedNodes)migrateTree(node,onError);
    }
  });
  observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:watchedAttributes});
  return ()=>observer.disconnect();
}

export const viewEventAttributes=[...EVENT_ATTRIBUTES];
