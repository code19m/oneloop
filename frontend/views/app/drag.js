// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* Dragging Board cards and Roadmap tracks with a pointer. A drag ends in the
   same drop handlers on any device. */

import { UIMotion } from '../../src/app/motion.js';
import { App, canBoard, canRoadmap, state } from './model.js';

/**
 * The drag in progress: the card or track (`item`), where it would drop
 * (`column` and `before` on the Board, `laneBefore` on the Roadmap) and the
 * picture that follows the pointer.
 */
export const drag = { item: null, column: null, before: null, laneBefore: null, preview: null };

/** The line that shows where a drop would land. */
export const dropIndicator = () => document.getElementById('dropInd');
/** The drop line, made when there is none; `absolute` places it between Roadmap lanes. */
export function makeDropIndicator(absolute) {
  let el = dropIndicator();
  if (!el) { el = document.createElement('div'); el.id = 'dropInd'; el.className = 'drop-ind'; }
  el.style.cssText = absolute ? 'position:absolute;left:0;right:0;margin:0;z-index:8' : '';
  el.classList.toggle('track-ind', absolute);
  return el;
}
/** Give the drag a picture of `source`; `compact` for a Roadmap lane's head. */
export function setDragImage(ev, source, compact = false) {
  const image = UIMotion.ghost(source);
  image.classList.add('drag-preview');
  const r = source.getBoundingClientRect();
  image.style.cssText = `position:fixed;left:-10000px;top:0;width:${compact ? 240 : r.width}px;height:auto;`;
  if (compact) image.querySelectorAll('.head-ctl').forEach((el) => el.remove());
  document.body.appendChild(image);
  drag.preview = image;
  ev.dataTransfer.setDragImage(image, compact ? 24 : ev.clientX - r.left, compact ? 20 : ev.clientY - r.top);
}

// Pointer gestures share the existing destination, optimistic-save and rollback
// paths. Touch/pen start on grips so the rest of the Board remains scrollable.
// The click that ends a drag is not a click on the card. Some browsers send
// it only after the drop has redrawn the Board, however long that takes, so
// a drag that started swallows the next click; the next press forgets it.
let pointerDrag = null, suppressDragClick = false;

function pointerEvent(event, currentTarget) {
  const pointer = pointerDrag;
  return {target:pointer.source,currentTarget,clientX:pointer.x,clientY:pointer.y,
    dataTransfer:pointer.transfer,preventDefault:()=>event?.preventDefault()};
}

function updatePointerTarget() {
  const pointer = pointerDrag; if (!pointer?.started || !drag.item) return;
  const hit = document.elementFromPoint(pointer.x,pointer.y);
  const target = hit?.closest(pointer.kind === 'task' ? '.col[data-col]' : '.lane[data-track]');
  if (pointer.target && pointer.target !== target) {
    pointer.target.classList.remove('drop'); dropIndicator()?.remove(); drag.before=null; drag.laneBefore=null;
  }
  pointer.target = target;
  if (target) {
    if (pointer.kind === 'task') App.colOver(pointerEvent(null,target));
    else App.laneOver(pointerEvent(null,target));
  }
  const preview=drag.preview;
  if (preview) { preview.style.left=(pointer.x-pointer.offsetX)+'px'; preview.style.top=(pointer.y-pointer.offsetY)+'px'; }
}

function pointerScroll() {
  const pointer=pointerDrag;if(!pointer?.started)return;
  if(!pointer.source.isConnected || !drag.item){finishPointerDrag(false);return;}
  const speed=(value,min,max)=>value<min+40?-Math.min(18,(min+40-value)/3):value>max-40?Math.min(18,(value-max+40)/3):0;
  const viewport=document.querySelector(pointer.kind==='task'?'.board':'.rm-scroll');
  if(viewport){const rect=viewport.getBoundingClientRect();viewport.scrollLeft+=speed(pointer.x,rect.left,rect.right);if(pointer.kind==='track')viewport.scrollTop+=speed(pointer.y,rect.top,rect.bottom);}
  const list=pointer.target?.querySelector('.col-cards');
  if(list){const rect=list.getBoundingClientRect();list.scrollTop+=speed(pointer.y,rect.top,rect.bottom);}
  updatePointerTarget();pointer.frame=requestAnimationFrame(pointerScroll);
}

function finishPointerDrag(commit,event) {
  const pointer=pointerDrag;if(!pointer)return;
  cancelAnimationFrame(pointer.frame);
  if(pointer.started){
    suppressDragClick=true;
    if(commit && pointer.source.isConnected){
      updatePointerTarget();
      if(pointer.target && drag.item){
        if(pointer.kind==='task')App.dropTask(pointerEvent(event,pointer.target),pointer.target.dataset.col);
        else App.trackDrop(pointerEvent(event,pointer.target),pointer.target.dataset.track);
      }
    }
    App.dragEnd(false);
  }
  pointerDrag=null;
  if(pointer.source.hasPointerCapture?.(pointer.pointerId))pointer.source.releasePointerCapture(pointer.pointerId);
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
  const pointer=pointerDrag;if(!pointer || pointer.pointerId!==event.pointerId)return;
  if(!pointer.source.isConnected){finishPointerDrag(false);return;}
  pointer.x=event.clientX;pointer.y=event.clientY;
  if(!pointer.started){
    if(Math.hypot(pointer.x-pointer.startX,pointer.y-pointer.startY)<6)return;
    const synthetic=pointerEvent(event,pointer.source);
    if(pointer.kind==='task')App.taskDragStart(synthetic,pointer.id);else App.trackDragStart(synthetic,pointer.id);
    if(!drag.item){pointerDrag=null;return;}
    pointer.started=true;pointer.source.setPointerCapture?.(pointer.pointerId);
    pointer.frame=requestAnimationFrame(pointerScroll);
  }
  event.preventDefault();updatePointerTarget();
},{passive:false});

document.addEventListener('pointerup',event=>{if(pointerDrag?.pointerId===event.pointerId)finishPointerDrag(true,event);},true);

document.addEventListener('pointercancel',event=>{if(pointerDrag?.pointerId===event.pointerId)finishPointerDrag(false);},true);

document.addEventListener('lostpointercapture',event=>{if(pointerDrag?.pointerId===event.pointerId && event.target===pointerDrag.source && !pointerDrag.source.hasPointerCapture?.(event.pointerId))finishPointerDrag(false);},true);

document.addEventListener('keydown',event=>{if(event.key==='Escape'&&pointerDrag){event.preventDefault();event.stopImmediatePropagation();finishPointerDrag(false);}},true);

window.addEventListener('blur',()=>finishPointerDrag(false));

document.addEventListener('click',event=>{if(event.detail>0 && suppressDragClick){suppressDragClick=false;event.preventDefault();event.stopImmediatePropagation();}},true);

// Native HTML dragging would steal the pointer stream, so the pointer code
// above calls the drag handlers with events of its own.
document.addEventListener('dragstart',event=>{if(event.target.closest('.card,.grip')){event.preventDefault();event.stopImmediatePropagation();}},true);

Object.assign(App, {
  dragEnd(animate = true) {
    const before = animate ? UIMotion.positions('.card[data-task]') : null;
    drag.before = null; drag.column = null; drag.laneBefore = null;
    drag.item = null;
    drag.preview?.remove(); drag.preview = null;
    dropIndicator()?.remove();
    document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    document.querySelectorAll('.col.drop').forEach((el) => el.classList.remove('drop'));
    document.body.classList.remove('is-dragging');
    if (before) UIMotion.layout(before, '.card[data-task]');
  },
});
