// @ts-check

/** The view bridge's Pool actions: capturing items, their descriptions, and reading each Pool. */

import { toWireScope } from '../../data/wire.js';
import { completeForm } from '../form-feedback.js';
import { text } from './commands.js';

/** @param {import('../view-bridge.js').BridgeContext} ctx */
export function installPool(ctx) {
  const { app, data, reads, recovery, poolItem, context, sessionScope, execute, fire, formValues } = ctx;
  // Pool items that could not be added, kept for their person until the
  // capture field of their Pool is free, or until they sign out in this tab.
  /** @type {{userId:string,projectId:string,scope:string,title:string,description:string,key:string}[]} */
  const unsentCaptures = [];
  /** @type {{projectId:string,scope:string,title:string,description:string,key:string}|null} */
  let returnedCapture = null;
  // Pool items on their way, so a second Enter on the field one just left says nothing.
  let capturesSending = 0;

  // An item leaves the field as soon as it is sent, so what is typed next is a
  // new item: never joined to this one, and sent on its own. An item that
  // can't be added comes back once the field is free.
  app.poolKey=(event)=>{
    if(event.key!=='Enter'||event.shiftKey||event.isComposing||event.repeat)return;
    event.preventDefault();
    const input=event.target;
    const enteredTitle=input.value,title=text(enteredTitle,140);
    if(!title){if(!capturesSending)app.toast('Give the Pool item a title.','error');return false;}
    const notes=/** @type {HTMLTextAreaElement|null} */(document.getElementById('poolNewDesc'));
    const description=text(notes?.value||'',2000),scope=toWireScope(context().poolTab),projectId=context().projectId,sent=sessionScope(),userId=data.session?.userId??'';
    // An item sent again after an unknown result keeps its key, so it is added once.
    const returned=returnedCapture;returnedCapture=null;
    const key=returned&&returned.projectId===projectId&&returned.scope===scope&&returned.title===title&&returned.description===description?returned.key:`pool:create:${crypto.randomUUID()}`;
    input.value='';if(notes)notes.value='';capturesSending++;
    // The next item starts as a title alone, as the first one did.
    if(notes?.closest('.pool-capture')?.classList.contains('is-expanded'))app.togglePoolDescription();
    return fire(execute('pool.create',{projectId,scope,title,description},null,'Pool item added',{
      create:true,paint:false,interactionKey:key,poolScope:scope,onAccepted:returnCaptures,
    }).catch((error)=>{
      if(sessionScope()===sent){unsentCaptures.push({userId,projectId,scope,title,description,key});returnCaptures();}
      throw error;
    }).finally(()=>{capturesSending--;}));
  };
  /** Put the oldest item that wasn't added back in the capture field of its Pool, once the field is empty. */
  function returnCaptures(){
    const userId=data.session?.userId;
    for(let index=unsentCaptures.length-1;index>=0;index--)if(unsentCaptures[index].userId!==userId)unsentCaptures.splice(index,1);
    const input=/** @type {HTMLInputElement|null} */(document.getElementById('poolAdd'));
    const notes=/** @type {HTMLTextAreaElement|null} */(document.getElementById('poolNewDesc'));
    if(!input||input.hidden||input.value||notes?.value)return;
    const scope=toWireScope(context().poolTab),index=unsentCaptures.findIndex(item=>item.projectId===context().projectId&&item.scope===scope);
    if(index<0)return;
    const [item]=unsentCaptures.splice(index,1);
    input.value=item.title;
    if(notes&&item.description){
      // Opening the notes moves focus there; it goes back to where it was.
      const focused=/** @type {HTMLElement|null} */(document.activeElement);
      if(!notes.closest('.pool-capture')?.classList.contains('is-expanded'))app.togglePoolDescription();
      notes.value=item.description;
      if(focused?.isConnected)focused.focus({preventScroll:true});
    }
    returnedCapture={projectId:item.projectId,scope:item.scope,title:item.title,description:item.description,key:item.key};
  }
  recovery.trackUnsaved(()=>unsentCaptures.some(item=>!data.session||item.userId===data.session.userId),()=>{unsentCaptures.length=0;returnedCapture=null;});
  app.savePoolDescription=(event,id)=>{const form=event.target,values=formValues(event),item=poolItem(id);if(!item)return false;return fire(execute('pool.update',{poolItemId:item.id,description:text(values.get('desc'),2000)},item,'Description saved',{poolScope:toWireScope(item.scope),form,paint:false,onAccepted:()=>completeForm(form,()=>app.refreshPool({completeItemId:id}))}));};
  app.delPool=(event,id)=>{event.stopPropagation();const item=poolItem(id);if(!item)return;app.confirm({title:'Delete Pool item?',text:item.title,action:'Delete item',confirm:()=>fire(execute('pool.delete',{id:item.id},item,'Pool item deleted',{poolScope:toWireScope(item.scope),paint:false,onAccepted:()=>app.refreshPool()}))});};

  return {
    async openPool(){
      const projectId=context().projectId;
      returnCaptures();
      const results=await Promise.all(['personal','team'].map(scope=>reads.pool(projectId,scope)));
      return {stale:results.some(result=>result?.stale)||context().projectId!==projectId};
    },
    /** @param {string} scope `mine` or `project`, as the Pool's tabs name them */
    async selectPool(scope){returnCaptures();return reads.pool(context().projectId,toWireScope(scope));},
    /** @param {string} scope */
    async loadMorePool(scope){return reads.morePool(context().projectId,toWireScope(scope));},
  };
}
