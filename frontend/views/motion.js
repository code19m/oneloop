/* Shared, interruptible presentation effects. Data changes never wait for motion. */
(() => {
  const quick=140,normal=180,ease='cubic-bezier(.2,.8,.2,1)';
  const running=new WeakMap(),disclosures=new WeakMap(),exits=new Set();
  const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  const can=el=>!!el?.animate&&!reduced();
  const cancel=el=>running.get(el)?.cancel();
  function animate(el,frames,duration=normal){
    cancel(el);
    if(!el?.isConnected||el.ownerDocument!==document||!can(el))return null;
    const animation=el.animate(frames,{duration,easing:ease});running.set(el,animation);
    const clear=()=>{if(running.get(el)===animation)running.delete(el);};animation.finished.then(clear,clear);return animation;
  }
  function enter(el){return animate(el,[{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'none'}]);}
  function fade(el){return animate(el,[{opacity:.5},{opacity:1}]);}
  function height(el,before){if(!el)return;cancel(el);const after=el.getBoundingClientRect().height;if(Math.abs(after-before)>1)return animate(el,[{height:before+'px',overflow:'hidden'},{height:after+'px',overflow:'hidden'}]);}
  function visibility(el,show){
    const current=el.hidden?0:Number(getComputedStyle(el).opacity);cancel(el);
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
    const animation=animate(el,[{opacity:getComputedStyle(el).opacity},{opacity:0}],quick);
    if(animation)animation.finished.then(()=>el.remove(),()=>el.remove());else el.remove();
  }
  /** A copy of `el` that only shows: it takes no input, and has no IDs, names, data or handlers that the app could find or run. */
  function ghost(el){
    const copy=el.cloneNode(true);
    for(const node of [copy,...copy.querySelectorAll('*')])for(const name of node.getAttributeNames())if(name==='id'||name==='name'||name==='draggable'||name.startsWith('on')||name.startsWith('data-'))node.removeAttribute(name);
    copy.inert=true;copy.setAttribute('aria-hidden','true');return copy;
  }
  /** Fade out a copy of `source` where it shows, so that the element itself can leave at once. */
  function exit(source){
    if(!can(source))return;
    const rect=source.getBoundingClientRect();
    if(!rect.width||!rect.height||rect.bottom<=0||rect.top>=innerHeight)return;
    // The copy keeps the look of the original but no class that app styles or selectors could match.
    const copy=ghost(source),originals=[source,...source.querySelectorAll('*')],copies=[copy,...copy.querySelectorAll('*')];
    const properties=['display','position','box-sizing','width','height','min-width','min-height','max-width','max-height','padding','margin','border','border-radius','background','box-shadow','backdrop-filter','color','font','line-height','letter-spacing','text-align','white-space','overflow','text-overflow','flex','flex-direction','align-items','justify-content','gap','opacity'];
    copies.forEach((node,i)=>{
      const original=originals[i],style=getComputedStyle(original);
      node.removeAttribute('class');
      properties.forEach(property=>node.style.setProperty(property,style.getPropertyValue(property)));
      if('value' in original)node.value=original.value;
      node.scrollTop=original.scrollTop;
    });
    copy.className='motion-exit';
    Object.assign(copy.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',margin:'0',minWidth:'0',maxWidth:'none',minHeight:'0',maxHeight:'none',pointerEvents:'none',zIndex:'96',animation:'none'});
    if(exits.size>=4){const oldest=exits.values().next().value;cancel(oldest);oldest.remove();exits.delete(oldest);}
    document.body.append(copy);exits.add(copy);
    const animation=animate(copy,[{opacity:getComputedStyle(source).opacity},{opacity:0}],quick);
    const cleanup=()=>{copy.remove();exits.delete(copy);};
    if(animation)animation.finished.then(cleanup,cleanup);else cleanup();
  }
  /** Drop the copies that exits still show, as when a dialog, drawer or menu opens. */
  function clearExits(){exits.forEach(el=>{cancel(el);el.remove();});exits.clear();}
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
    for(const el of host?.querySelectorAll(selector)||[])cancel(el);
    const measured=measurements(host,selector);
    for(const {el,rect} of measured){const old=before.get(el.getAttribute(key));if(!old){enter(el);continue;}const dy=old.top-rect.top;if(Math.abs(dy)>1)animate(el,[{transform:`translateY(${dy}px)`},{transform:'none'}]);}
  }
  // Board cards and Roadmap lanes move by the task or track they show. The
  // move starts where they are painted now, so a new drag can interrupt it.
  const layoutKey=el=>el.dataset.task||el.dataset.track;
  /** Where each element of `selector` is now, for `layout` to move it from. */
  function positions(selector){return new Map([...document.querySelectorAll(selector)].map(el=>[layoutKey(el),el.getBoundingClientRect()]));}
  /** Move each element of `selector` from where it was before, except the one `skip` names. */
  function layout(before,selector,skip){
    document.querySelectorAll(selector).forEach(el=>{
      const from=before.get(layoutKey(el));cancel(el);
      if(!from||layoutKey(el)===skip||reduced())return;
      const to=el.getBoundingClientRect(),x=from.left-to.left,y=from.top-to.top;
      if(Math.abs(x)+Math.abs(y)>=1)animate(el,[{transform:`translate(${x}px, ${y}px)`},{transform:'translate(0, 0)'}],220);
    });
  }
  document.addEventListener('click',event=>{
    const summary=event.target.closest('summary'),details=summary?.parentElement;
    if(!details?.matches('.markdown-body details')||event.target.closest('a,button,input'))return;
    event.preventDefault();
    const prior=disclosures.get(details),open=prior?!prior.open:!details.open,before=details.getBoundingClientRect().height;
    cancel(details);details.open=true;
    const style=getComputedStyle(details),closed=summary.getBoundingClientRect().height+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth);
    const after=open?details.getBoundingClientRect().height:closed;
    summary.setAttribute('aria-expanded',String(open));[...details.children].filter(el=>el!==summary).forEach(el=>el.inert=!open);
    const record={open};disclosures.set(details,record);
    const finish=()=>{if(disclosures.get(details)!==record)return;details.open=open;disclosures.delete(details);summary.removeAttribute('aria-expanded');};
    const animation=animate(details,[{height:before+'px',overflow:'hidden'},{height:after+'px',overflow:'hidden'}]);
    if(animation)animation.finished.then(finish,()=>{});else finish();
  });
  window.UIMotion={quick,normal,animate,cancel,enter,fade,height,visibility,remove,ghost,exit,clearExits,rows,reflow,positions,layout,reduced};
})();
