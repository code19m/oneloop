// @ts-check

/** The view bridge's project actions: creating, renaming and deleting projects, and their members. */

import { completeForm } from '../form-feedback.js';
import { text } from './commands.js';

/** @param {import('../view-bridge.js').BridgeContext} ctx */
export function installProjects(ctx) {
  const { app, data, auth, reloadBootstrap, context, sessionScope, nav, execute, fire, formValues, fieldError, ifCurrent, report, stillAdmin, adminGone } = ctx;

  app.saveProjectNew=(event)=>{
    const form=event.target,values=formValues(event),name=text(values.get('name'),60),taskPrefix=text(values.get('key'),4).toUpperCase(),scope=sessionScope();if(!name)return fieldError(form,'name','The project needs a name.');if(!/^[A-Z0-9]{2,4}$/.test(taskPrefix))return fieldError(form,'key','Use 2–4 letters or digits.');
    // The new project opens only while its dialog is still the open one; a re-render keeps it open.
    const open=()=>completeForm(form,()=>{});
    return fire(execute('project.create',{name,taskPrefix},null,'Project created',{create:true,form,paint:false}).then((result)=>ifCurrent(result,async()=>{if(!open()){app.refreshBackground();return;}const created=result.entities?.find((entity)=>entity.entityType==='project');if(created?.id){await reloadBootstrap({projectId:created.id});if(sessionScope()!==scope||!open())return;app.selectProject(created.id);}if(sessionScope()===scope)nav('roadmap');})));
  };
  app.updateProjectField=(input)=>{const item=data.projects.find((entry)=>entry.id===context().projectId);if(!item||!['name','key'].includes(input.name))return false;const form=input.closest('.project-fields'),field=input.name==='key'?'taskPrefix':'name',value=field==='taskPrefix'?text(input.value,4).toUpperCase():text(input.value,60);if(field==='name'&&!value)return fieldError(form,'name','The project needs a name.');if(field==='taskPrefix'&&!/^[A-Z0-9]{2,4}$/.test(value))return fieldError(form,'key','Use 2–4 letters or digits.');input.value=value;return fire(execute('project.update',{projectId:item.id,[field]:value},item,'Project updated',{form,coalesce:true}));};
  app.addMember=(userId)=>fire(execute('membership.add',{projectId:context().projectId,userId,manageRoadmap:false,manageBoard:false},null,'Member added',{create:true}).catch(report));
  app.setMemberPermission=(userId,permission,enabled,input)=>{
    if(!['manage_roadmap','manage_board'].includes(permission))return false;
    const project=data.projects.find((item)=>item.id===context().projectId),membership=project?.members.find((item)=>item.userId===userId),scope=sessionScope();
    if(!membership||membership.permissions.includes(permission)===enabled)return false;
    // Keep the displayed permission authoritative until the confirmation is accepted.
    if(!enabled&&input)input.checked=true;
    const apply=()=>{
      if(sessionScope()!==scope||context().projectId!==project.id)return false;
      if(!stillAdmin()){adminGone();return false;}
      const latest=project.members.find(item=>item.userId===userId);if(!latest)return false;
      const current=new Set(latest.permissions);enabled?current.add(permission):current.delete(permission);
      // A change that fails shows the saved permission again.
      return fire(execute('membership.update',{projectId:project.id,userId,manageRoadmap:current.has('manage_roadmap'),manageBoard:current.has('manage_board')},latest,'Access updated').catch(error=>{report(error);if(sessionScope()===scope)app.refreshUsers();}));
    };
    if(!enabled)return app.confirm({title:'Remove permission?',text:`${data.users.find(user=>user.id===userId)?.name||userId} will lose permission to manage ${permission==='manage_board'?'Board':'Roadmap'} in ${project.name}.`,action:'Remove permission',confirm:apply});
    return apply();
  };
  function showMemberOpenWork(project,userId,count=null){const user=data.users.find((item)=>item.id===userId),who=user?.name||userId;app.showBlocked('Member has open work',count?`Reassign ${count} unfinished task${count===1?'':'s'} before removing ${who} from this project.`:`Reassign this member’s unfinished tasks before removing ${who} from this project.`);}
  app.removeMember=(userId)=>{const project=data.projects.find((item)=>item.id===context().projectId),membership=project?.members.find((item)=>item.userId===userId);if(!membership)return;const assigned=data.tasks.filter((item)=>item.projectId===project.id&&item.state!=='done'&&(item.assignees||[]).includes(userId));if(assigned.length){showMemberOpenWork(project,userId,assigned.length);return false;}app.confirm({title:'Remove member?',text:'They will lose access to this project.',action:'Remove member',confirm:()=>fire(execute('membership.remove',{projectId:project.id,userId},membership,'Member removed',{handleError:(error)=>{if(!['member_has_open_tasks','precondition_failed'].includes(error?.code))return false;showMemberOpenWork(project,userId);return true;}}).catch(report))});};
  app.deleteProject=()=>{const item=data.projects.find((entry)=>entry.id===context().projectId);if(!item)return;app.confirm({title:'Delete project?',text:'This permanently removes the project and all of its work.',action:'Delete project',match:item.name,confirm:()=>fire(auth.withRecentAuth(()=>execute('project.delete',{projectId:item.id,confirmedName:item.name},item,'Project deleted')).then((result)=>ifCurrent(result,()=>nav('roadmap'))).catch(report))});};
}
