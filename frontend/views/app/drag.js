// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* Dragging Board cards with a pointer. A drag ends in the same drop handlers
   on any device. */

import { UIMotion } from '../../src/app/motion.js';
import { App, canBoard, state } from './model.js';

/**
 * The drag in progress: the card (`item`), where it would drop (`column` and
 * `before`) and the picture that follows the pointer.
 */
export const drag = { item: null, column: null, before: null, preview: null };

/** The line that shows where a drop would land. */
export const dropIndicator = () => document.getElementById('dropInd');
/** The drop line, made when there is none. */
export function makeDropIndicator() {
  let el = dropIndicator();
  if (!el) { el = document.createElement('div'); el.id = 'dropInd'; el.className = 'drop-ind'; }
  return el;
}
/** Give the drag a picture of `source`. */
export function setDragImage(ev, source) {
  const image = UIMotion.ghost(source);
  image.classList.add('drag-preview');
  const r = source.getBoundingClientRect();
  image.style.cssText = `position:fixed;left:-10000px;top:0;width:${r.width}px;height:auto;`;
  document.body.appendChild(image);
  drag.preview = image;
  ev.dataTransfer.setDragImage(image, ev.clientX - r.left, ev.clientY - r.top);
}

// Pointer gestures share the existing destination, optimistic-save and rollback
// paths. Touch and pen start on a card's move button, so the rest of the Board
// stays scrollable.
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
  const target = document.elementFromPoint(pointer.x,pointer.y)?.closest('.col[data-col]');
  if (pointer.target && pointer.target !== target) {
    pointer.target.classList.remove('drop'); dropIndicator()?.remove(); drag.before=null;
  }
  pointer.target = target;
  if (target) App.colOver(pointerEvent(null,target));
  const preview=drag.preview;
  if (preview) { preview.style.left=(pointer.x-pointer.offsetX)+'px'; preview.style.top=(pointer.y-pointer.offsetY)+'px'; }
}

function pointerScroll() {
  const pointer=pointerDrag;if(!pointer?.started)return;
  if(!pointer.source.isConnected || !drag.item){finishPointerDrag(false);return;}
  const speed=(value,min,max)=>value<min+40?-Math.min(18,(min+40-value)/3):value>max-40?Math.min(18,(value-max+40)/3):0;
  const viewport=document.querySelector('.board');
  // Under a still pointer only a scroll moves the content; pointermove retargets after a move.
  let scrolled=false;
  if(viewport){const rect=viewport.getBoundingClientRect(),x=speed(pointer.x,rect.left,rect.right);if(x){viewport.scrollLeft+=x;scrolled=true;}}
  const list=pointer.target?.querySelector('.col-cards');
  if(list){const rect=list.getBoundingClientRect(),y=speed(pointer.y,rect.top,rect.bottom);if(y){list.scrollTop+=y;scrolled=true;}}
  if(scrolled)updatePointerTarget();pointer.frame=requestAnimationFrame(pointerScroll);
}

function finishPointerDrag(commit,event) {
  const pointer=pointerDrag;if(!pointer)return;
  cancelAnimationFrame(pointer.frame);
  if(pointer.started){
    suppressDragClick=true;
    if(commit && pointer.source.isConnected){
      updatePointerTarget();
      if(pointer.target && drag.item)App.dropTask(pointerEvent(event,pointer.target),pointer.target.dataset.col);
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
  const card=event.target.closest('.card[data-task]');
  if(!card || !canBoard())return;
  if(event.target.closest('button,a,input,textarea') && !event.target.closest('.card-move,.card-title-button'))return;
  if(['touch','pen'].includes(event.pointerType) && !event.target.closest('.card-move'))return;
  const rect=card.getBoundingClientRect(),values=new Map();
  pointerDrag={source:card,id:card.dataset.task,pointerId:event.pointerId,
    x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,offsetX:event.clientX-rect.left,offsetY:event.clientY-rect.top,
    transfer:{setData:(key,value)=>values.set(key,value),getData:key=>values.get(key),get types(){return [...values.keys()];},setDragImage(){}},started:false,target:null,frame:0};
});

document.addEventListener('pointermove',event=>{
  const pointer=pointerDrag;if(!pointer || pointer.pointerId!==event.pointerId)return;
  if(!pointer.source.isConnected){finishPointerDrag(false);return;}
  pointer.x=event.clientX;pointer.y=event.clientY;
  if(!pointer.started){
    if(Math.hypot(pointer.x-pointer.startX,pointer.y-pointer.startY)<6)return;
    const synthetic=pointerEvent(event,pointer.source);
    App.taskDragStart(synthetic,pointer.id);
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
// above calls the drag handlers with events of its own. A drag of selected
// text starts from its text node in some browsers, such as Firefox.
document.addEventListener('dragstart',event=>{const source=event.target instanceof Element?event.target:event.target.parentElement;if(source?.closest('.card')){event.preventDefault();event.stopImmediatePropagation();}},true);

Object.assign(App, {
  dragEnd(animate = true) {
    const before = animate ? UIMotion.positions('.card[data-task]') : null;
    drag.before = null; drag.column = null;
    drag.item = null;
    drag.preview?.remove(); drag.preview = null;
    dropIndicator()?.remove();
    document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    document.querySelectorAll('.col.drop').forEach((el) => el.classList.remove('drop'));
    document.body.classList.remove('is-dragging');
    if (before) UIMotion.layout(before, '.card[data-task]');
  },
});
