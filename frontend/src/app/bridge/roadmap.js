// @ts-check

/** The view bridge's Roadmap actions: epics, tracks and milestones. */

import { validDate } from '../action-feedback.js';
import { text } from './commands.js';

/** @param {import('../view-bridge.js').BridgeContext} ctx */
export function installRoadmap(ctx) {
  const { app, data, reads, recovery, epic, track, milestone, context, openPeek, execute, offerRestore, fire, ifCurrent, formValues, fieldError, validOptionalDate, changedFields, report } = ctx;

  app.saveEpic = (event,id) => {
    event.preventDefault();if(app.validateFormDates(event.target)===false)return false;
    const form=event.target,values=formValues(event), item=id?epic(id):null;
    const base={trackId:String(values.get('trackId')||''),title:text(values.get('title'),120),description:text(values.get('desc'),2000),startDate:String(values.get('start')||''),endDate:values.get('end')||null};
    if(!base.title)return fieldError(form,'title','Give the epic a title.');
    if(!data.tracks.some((entry)=>entry.id===base.trackId&&entry.projectId===context().projectId))return fieldError(form,'trackId','Choose a track.');
    if(!validDate(base.startDate))return fieldError(form,'start','Enter a valid start date in YYYY-MM-DD format.');
    if(!validOptionalDate(form,'end',base.endDate))return false;
    if(base.endDate&&base.endDate<base.startDate)return fieldError(form,'end','End date cannot be before the start date.');
    const changes=item?changedFields('epic',item.id,base):base;
    // An epic that moves to another track takes its tasks along, so the page reads them again.
    const moves=!!item&&changes.trackId!==undefined&&changes.trackId!==item.trackId;
    return fire(execute(item?'epic.update':'epic.create',item?{epicId:item.id,...changes}:{projectId:context().projectId,...base},item,item?'Epic updated':'Epic created',{create:!item,form,closeForm:true,reload:moves}));
  };
  // The epic's counts know all of its tasks; the page holds only some of them.
  app.closeEpic=(id)=>{const item=epic(id);if(!item)return;const open=item.counted?item.total-item.done:data.tasks.filter((entry)=>entry.epicId===id&&entry.state!=='done').length;const confirm=()=>fire(execute('epic.complete',{id:item.id},item,'Epic marked as done',{form:document.querySelector('.modal,.peek'),closeForm:true}));if(open)app.confirm({title:'Open tasks remain',text:`${open} open task${open===1?' stays where it is':'s stay where they are'}.`,action:'Mark as done',confirm});else confirm();};
  app.reopenEpic=(id)=>{const item=epic(id);if(item)return fire(execute('epic.reopen',{id:item.id},item,'Epic reopened'));};
  // The epic's tasks stay on its track without an epic, so the page reads them again.
  app.deleteEpic=(id)=>{
    const item=epic(id);if(!item)return;
    // Without its counts, as before the Roadmap read them, the epic may have tasks.
    const where=track(item.trackId)?.name??'its track',count=item.counted?item.total:null;
    const kept=count===0?'':` Its ${count===1?'task stays':count?`${count} tasks stay`:'tasks stay'} on ${where} without an epic.`;
    app.confirm({title:'Delete epic?',text:`“${item.title}” will be deleted.${kept} You can undo this right after.`,action:'Delete epic',confirm:()=>fire(execute('epic.delete',{id:item.id},item,null,{form:document.querySelector('.modal,.peek'),closeForm:true,reload:true}).then((result)=>ifCurrent(result,()=>offerRestore(result,{id:item.id,item,deleted:'Epic deleted',restored:'Epic restored',operation:'epic.restore'}))))});
  };
  app.openPeek=(id)=>{if(!epic(id))return;openPeek(id);return fire(reads.epic(id).catch(report));};
  app.loadMoreEpicTasks=(id)=>fire(reads.moreEpicTasks(id).catch(report));
  app.loadMoreEpicActivity=(id)=>fire(reads.moreEpicActivity(id).catch(report));

  app.saveTrack=(event,id)=>{const form=event.target,values=formValues(event),item=id?track(id):null,name=text(values.get('name'),60);if(!name)return fieldError(form,'name','Give the track a name.');return fire(execute(item?'track.update':'track.create',item?{trackId:item.id,name}:{projectId:context().projectId,name},item,item?'Track renamed':'Track created',{create:!item,form,closeForm:true}));};
  // Only an empty track can go. Its tasks are counted by the Roadmap's read; the server says the same when they changed meanwhile.
  app.deleteTrack=(id)=>{
    const item=track(id);if(!item)return;
    const counts=data.roadmap?.projectId===item.projectId?data.roadmap.trackCounts[item.id]:null;
    const contents=[[counts?counts.planning+counts.progress+counts.review+counts.done:0,'task'],[data.epics.filter((entry)=>entry.trackId===item.id).length,'epic']]
      .filter(([count])=>count).map(([count,noun])=>`${count} ${noun}${count===1?'':'s'}`).join(' and ');
    if(contents)return app.showBlocked(`“${item.name}” isn’t empty`,`Move or delete its ${contents} first.`);
    app.confirm({title:'Delete track?',text:`“${item.name}” will be deleted.`,action:'Delete track',confirm:()=>fire(execute('track.delete',{id:item.id},item,'Track deleted',{form:document.querySelector('.modal,.peek'),closeForm:true}))});
  };
  app.saveMilestone=(event,id)=>{event.preventDefault();if(app.validateFormDates(event.target)===false)return false;const form=event.target,values=formValues(event),item=id?milestone(id):null,base={title:text(values.get('name'),60),description:text(values.get('desc'),500),milestoneDate:String(values.get('date')||'')};if(!base.title)return fieldError(form,'name','Give the milestone a name.');if(!validDate(base.milestoneDate))return fieldError(form,'date','Enter a valid date in YYYY-MM-DD format.');return fire(execute(item?'milestone.update':'milestone.create',item?{milestoneId:item.id,...changedFields('milestone',item.id,base)}:{projectId:context().projectId,...base},item,item?'Milestone updated':'Milestone created',{create:!item,form,closeForm:true}));};
  app.deleteMilestone=(id)=>{const item=milestone(id);if(!item)return;app.confirm({title:'Delete milestone?',text:`“${item.name}” will be removed.`,action:'Delete',confirm:()=>fire(execute('milestone.delete',{id:item.id},item,'Milestone deleted',{form:document.querySelector('.modal,.peek'),closeForm:true}))});};

  return {
    /** Load the Roadmap again in the background after the instance's date changed. */
    async dateChanged(){return reads.roadmap(context().projectId,{background:true}).catch((/** @type {any} */ error)=>{recovery.refreshFailed(error);throw error;});},
    /** Read more days for the Roadmap's lanes, as its view comes to them. @param {{from:string,to:string,anchor?:string,marks?:number}} days */
    roadmapDays(days){return reads.roadmapDays(context().projectId,days);},
    /** The tasks one of the Roadmap's marks counts. @param {{track:string,epic?:string|null,kind:'done'|'plans'|'open',from?:string,to?:string}} list */
    roadmapList(list){return reads.roadmapList(context().projectId,list);},
    /** @param {{trackId:string,position:number,optimistic?:boolean}} move */
    async moveTrack(move){const item=track(move.trackId);return execute('track.reorder',{trackId:item.id,position:move.position},item,move.optimistic?null:'Track reordered',{skipNoChange:!!move.optimistic,paint:!move.optimistic});},
  };
}
