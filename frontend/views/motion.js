/* Shared, interruptible presentation effects. Data changes never wait for motion. */
/** Escape text and quoted HTML attributes. @param {unknown} value */
function UIEscape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
/**
 * Attributes that run `App[method](...args)` on a click (src/app/view-actions.js).
 * UIAction.on(type, method, ...args) runs one for another event. UIAction.event,
 * .element, .value and .checked stand for the event, the element, and its value and checked state.
 * @param {string} method @param {...unknown} args
 */
function UIAction(method, ...args) { return UIAction.on('click', method, ...args); }
/** @param {string} type @param {string} method @param {...unknown} args */
UIAction.on = (type, method, ...args) => {
  const suffix = type === 'click' ? '' : '-' + type;
  return `data-action${suffix}="${UIEscape(method)}"${args.length ? ` data-args${suffix}="${UIEscape(JSON.stringify(args))}"` : ''}`;
};
for (const name of ['event', 'element', 'value', 'checked']) UIAction[name] = Object.freeze({ $: name });
globalThis.UIEscape=UIEscape;
globalThis.UIAction=UIAction;
window.UIHTML=(element,source)=>window.OneloopSetHTML?window.OneloopSetHTML(element,source):(element.innerHTML=source);
(() => {
  const running=new WeakMap(),disclosures=new WeakMap();
  const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  const can=el=>!!el?.animate&&!reduced();
  function animate(el,frames,duration=180){
    running.get(el)?.cancel();
    if(!el?.isConnected||el.ownerDocument!==document||!can(el))return null;
    const animation=el.animate(frames,{duration,easing:'cubic-bezier(.2,.8,.2,1)'});running.set(el,animation);
    const clear=()=>{if(running.get(el)===animation)running.delete(el);};animation.finished.then(clear,clear);return animation;
  }
  function enter(el){return animate(el,[{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'none'}]);}
  function fade(el){return animate(el,[{opacity:.5},{opacity:1}]);}
  function height(el,before){if(!el)return;running.get(el)?.cancel();const after=el.getBoundingClientRect().height;if(Math.abs(after-before)>1)return animate(el,[{height:before+'px',overflow:'hidden'},{height:after+'px',overflow:'hidden'}]);}
  function visibility(el,show){
    const current=el.hidden?0:Number(getComputedStyle(el).opacity);running.get(el)?.cancel();
    el.style.pointerEvents=show?'':'none';
    if(show){el.hidden=false;el.inert=false;el.removeAttribute('aria-hidden');}
    else {el.inert=true;el.setAttribute('aria-hidden','true');}
    const animation=animate(el,[{opacity:current,transform:show?'translateX(8px)':'none'},{opacity:show?1:0,transform:show?'none':'translateX(8px)'}]);
    if(!animation){el.hidden=!show;return;}
    animation.finished.then(()=>{if(!show&&el.inert)el.hidden=true;},()=>{});
  }
  function remove(el){
    if(!el)return;
    // Never clone live HTML frames or keep their scripts running during an exit.
    el.querySelectorAll('iframe').forEach(frame=>frame.remove());el.inert=true;el.setAttribute('aria-hidden','true');el.style.pointerEvents='none';el.dataset.motionExiting='true';
    const animation=animate(el,[{opacity:getComputedStyle(el).opacity},{opacity:0}],140);
    if(animation)animation.finished.then(()=>el.remove(),()=>el.remove());else el.remove();
  }
  function measurements(host,selector){
    const elements=[...host?.querySelectorAll(selector)||[]];
    // Large histories remain readable without hundreds of animations/layout reads.
    if(elements.length>100||reduced())return [];
    const viewport=host?.closest('.content,.task-page')?.getBoundingClientRect();
    return elements.map(el=>({el,rect:el.getBoundingClientRect()})).filter(({rect})=>!viewport||rect.bottom>=viewport.top&&rect.top<=viewport.bottom);
  }
  function rows(host,selector,key){return new Map(measurements(host,selector).map(({el,rect})=>[el.getAttribute(key),rect]));}
  function reflow(host,selector,key,before){
    // Cancel effects first, then read all geometry, then start animations.
    for(const el of host?.querySelectorAll(selector)||[])running.get(el)?.cancel();
    const measured=measurements(host,selector);
    for(const {el,rect} of measured){const old=before.get(el.getAttribute(key));if(!old){enter(el);continue;}const dy=old.top-rect.top;if(Math.abs(dy)>1)animate(el,[{transform:`translateY(${dy}px)`},{transform:'none'}]);}
  }
  document.addEventListener('click',event=>{
    const summary=event.target.closest('summary'),details=summary?.parentElement;
    if(!details?.matches('.markdown-body details')||event.target.closest('a,button,input'))return;
    event.preventDefault();
    const prior=disclosures.get(details),open=prior?!prior.open:!details.open,before=details.getBoundingClientRect().height;
    running.get(details)?.cancel();details.open=true;
    const style=getComputedStyle(details),closed=summary.getBoundingClientRect().height+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth);
    const after=open?details.getBoundingClientRect().height:closed;
    summary.setAttribute('aria-expanded',String(open));[...details.children].filter(el=>el!==summary).forEach(el=>el.inert=!open);
    const record={open};disclosures.set(details,record);
    const finish=()=>{if(disclosures.get(details)!==record)return;details.open=open;disclosures.delete(details);summary.removeAttribute('aria-expanded');};
    const animation=animate(details,[{height:before+'px',overflow:'hidden'},{height:after+'px',overflow:'hidden'}]);
    if(animation)animation.finished.then(finish,()=>{});else finish();
  });
  window.UIMotion={animate,enter,fade,height,visibility,remove,rows,reflow,reduced};
})();
