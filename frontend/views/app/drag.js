// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* Dragging Board cards and Roadmap tracks with a pointer. A drag ends in the
   same drop handlers on any device. */

import { App, canBoard, canRoadmap, state } from './model.js';

// Pointer gestures share the existing destination, optimistic-save and rollback
// paths. Touch/pen start on grips so the rest of the Board remains scrollable.
// The click that ends a drag is not a click on the card. Some browsers send
// it only after the drop has redrawn the Board, however long that takes, so
// a drag that started swallows the next click; the next press forgets it.
let pointerDrag = null, suppressDragClick = false;

function pointerEvent(event, currentTarget) {
  const drag = pointerDrag;
  return {target:drag.source,currentTarget,clientX:drag.x,clientY:drag.y,
    dataTransfer:drag.transfer,preventDefault:()=>event?.preventDefault()};
}

function updatePointerTarget() {
  const drag = pointerDrag; if (!drag?.started || !App._drag) return;
  const hit = document.elementFromPoint(drag.x,drag.y);
  const target = hit?.closest(drag.kind === 'task' ? '.col[data-col]' : '.lane[data-track]');
  if (drag.target && drag.target !== target) {
    drag.target.classList.remove('drop'); App._ind()?.remove(); App._dropBefore=null; App._laneBefore=null;
  }
  drag.target = target;
  if (target) {
    if (drag.kind === 'task') App.colOver(pointerEvent(null,target));
    else App.laneOver(pointerEvent(null,target));
  }
  const preview=App._dragPreview;
  if (preview) { preview.style.left=(drag.x-drag.offsetX)+'px'; preview.style.top=(drag.y-drag.offsetY)+'px'; }
}

function pointerScroll() {
  const drag=pointerDrag;if(!drag?.started)return;
  if(!drag.source.isConnected || !App._drag){finishPointerDrag(false);return;}
  const speed=(value,min,max)=>value<min+40?-Math.min(18,(min+40-value)/3):value>max-40?Math.min(18,(value-max+40)/3):0;
  const viewport=document.querySelector(drag.kind==='task'?'.board':'.rm-scroll');
  if(viewport){const rect=viewport.getBoundingClientRect();viewport.scrollLeft+=speed(drag.x,rect.left,rect.right);if(drag.kind==='track')viewport.scrollTop+=speed(drag.y,rect.top,rect.bottom);}
  const list=drag.target?.querySelector('.col-cards');
  if(list){const rect=list.getBoundingClientRect();list.scrollTop+=speed(drag.y,rect.top,rect.bottom);}
  updatePointerTarget();drag.frame=requestAnimationFrame(pointerScroll);
}

function finishPointerDrag(commit,event) {
  const drag=pointerDrag;if(!drag)return;
  cancelAnimationFrame(drag.frame);
  if(drag.started){
    suppressDragClick=true;
    if(commit && drag.source.isConnected){
      updatePointerTarget();
      if(drag.target && App._drag){
        if(drag.kind==='task')App.dropTask(pointerEvent(event,drag.target),drag.target.dataset.col);
        else App.trackDrop(pointerEvent(event,drag.target),drag.target.dataset.track);
      }
    }
    App.dragEnd(false);
  }
  pointerDrag=null;
  if(drag.source.hasPointerCapture?.(drag.pointerId))drag.source.releasePointerCapture(drag.pointerId);
}

document.addEventListener('pointerdown',event=>{
  suppressDragClick=false;
  if(!event.isPrimary){if(pointerDrag)finishPointerDrag(false);return;}
  if(event.button!==0 || pointerDrag || state.modal || state.peek || state.menu) return;
  const grip=event.target.closest('.grip'),card=event.target.closest('.card[data-task]');
  const kind=grip?'track':card?'task':null;
  if(!kind || (kind==='track'?!canRoadmap():!canBoard()))return;
  if(!grip && event.target.closest('button,a,input,textarea') && !event.target.closest('.card-move,.card-title-button'))return;
  if(!grip && ['touch','pen'].includes(event.pointerType) && !event.target.closest('.card-move'))return;
  const source=grip||card,rect=(grip?grip.closest('.lane').querySelector('.lane-head'):card).getBoundingClientRect();
  const values=new Map();
  pointerDrag={source,kind,id:grip?grip.closest('.lane').dataset.track:card.dataset.task,pointerId:event.pointerId,
    x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,offsetX:grip?24:event.clientX-rect.left,offsetY:grip?20:event.clientY-rect.top,
    transfer:{setData:(key,value)=>values.set(key,value),getData:key=>values.get(key),get types(){return [...values.keys()];},setDragImage(){}},started:false,target:null,frame:0};
});

document.addEventListener('pointermove',event=>{
  const drag=pointerDrag;if(!drag || drag.pointerId!==event.pointerId)return;
  if(!drag.source.isConnected){finishPointerDrag(false);return;}
  drag.x=event.clientX;drag.y=event.clientY;
  if(!drag.started){
    if(Math.hypot(drag.x-drag.startX,drag.y-drag.startY)<6)return;
    const synthetic=pointerEvent(event,drag.source);
    if(drag.kind==='task')App.taskDragStart(synthetic,drag.id);else App.trackDragStart(synthetic,drag.id);
    if(!App._drag){pointerDrag=null;return;}
    drag.started=true;drag.source.setPointerCapture?.(drag.pointerId);
    drag.frame=requestAnimationFrame(pointerScroll);
  }
  event.preventDefault();updatePointerTarget();
},{passive:false});

document.addEventListener('pointerup',event=>{if(pointerDrag?.pointerId===event.pointerId)finishPointerDrag(true,event);},true);

document.addEventListener('pointercancel',event=>{if(pointerDrag?.pointerId===event.pointerId)finishPointerDrag(false);},true);

document.addEventListener('lostpointercapture',event=>{if(pointerDrag?.pointerId===event.pointerId && event.target===pointerDrag.source && !pointerDrag.source.hasPointerCapture?.(event.pointerId))finishPointerDrag(false);},true);

document.addEventListener('keydown',event=>{if(event.key==='Escape'&&pointerDrag){event.preventDefault();event.stopImmediatePropagation();finishPointerDrag(false);}},true);

window.addEventListener('blur',()=>finishPointerDrag(false));

document.addEventListener('click',event=>{if(event.detail>0 && suppressDragClick){suppressDragClick=false;event.preventDefault();event.stopImmediatePropagation();}},true);

// Native HTML dragging would steal the pointer stream. Retain callable legacy
// handlers only as a compatibility surface for the shared mutation model.
document.addEventListener('dragstart',event=>{if(event.target.closest('.card,.grip')){event.preventDefault();event.stopImmediatePropagation();}},true);

Object.assign(App, {

  // Drag destinations and mutations retain their existing behavior.
  _ind() { return document.getElementById('dropInd'); },
  _mkInd(absolute) {
    let el = App._ind();
    if (!el) { el = document.createElement('div'); el.id = 'dropInd'; el.className = 'drop-ind'; }
    el.style.cssText = absolute ? 'position:absolute;left:0;right:0;margin:0;z-index:8' : '';
    el.classList.toggle('track-ind', absolute);
    return el;
  },
  dragEnd(animate = true) {
    const before = animate ? UIMotion.positions('.card[data-task]') : null;
    App._dropBefore = null; App._dropColumn = null; App._laneBefore = null;
    App._drag = null;
    App._dragPreview?.remove(); App._dragPreview = null;
    const ind = App._ind(); if (ind) ind.remove();
    document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    document.querySelectorAll('.col.drop').forEach((el) => el.classList.remove('drop'));
    document.body.classList.remove('is-dragging');
    if (before) UIMotion.layout(before, '.card[data-task]');
  },
  _dragImage(ev, source, compact = false) {
    const image = UIMotion.ghost(source);
    image.classList.add('drag-preview');
    const r = source.getBoundingClientRect();
    image.style.cssText = `position:fixed;left:-10000px;top:0;width:${compact ? 240 : r.width}px;height:auto;`;
    if (compact) image.querySelectorAll('.head-ctl').forEach((el) => el.remove());
    document.body.appendChild(image);
    App._dragPreview = image;
    ev.dataTransfer.setDragImage(image, compact ? 24 : ev.clientX - r.left, compact ? 20 : ev.clientY - r.top);
  },
});
