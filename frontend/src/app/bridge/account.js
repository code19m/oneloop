// @ts-check

/** The view bridge's account actions: signing in and out, Profile, and the Users list. */

import { mapUser, mergeAdminUsersPage } from '../../data/projection-store.js';
import { sessionBrowserLabel, sessionDeviceLabel } from '../../auth/session-label.js';
import { completeForm } from '../form-feedback.js';
import { text } from './commands.js';

/** The server's username order: SQLite's binary collation, not the browser's locale. */
const compareUsernames = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** @param {import('../view-bridge.js').BridgeContext} ctx */
export function installAccount(ctx) {
  const { app, data, auth, api, recovery, context, sessionScope, fire, formValues, fieldError, stale, report, reportFor, stillAdmin, adminGone } = ctx;
  let usersAfter=null,usersDepth=1;
  let usersGeneration=0,profileGeneration=0,profileNameGeneration=0,avatarGeneration=0;
  let usersController=null,profileController=null;
  /** @type {Promise<unknown>} */ let profileNameQueue=Promise.resolve();
  /** @type {Promise<unknown>} */ let avatarQueue=Promise.resolve();
  let profileNameQueueScope='',avatarQueueScope='';

  app.login = (event) => {
    const fields=formValues(event), form=event.target;
    return fire(auth.login({username:text(fields.get('username'),32).toLowerCase(),password:String(fields.get('password')||'')},form));
  };
  app.logout = () => app.confirm({title:'Sign out?',text:app.signOutText(),action:'Sign out',confirm:()=>fire(auth.logout().catch(report))});
  app.setPassword = (event) => { event.preventDefault();if(!recovery.ensureOnline())return false; return fire(auth.setTemporaryPassword(event.target).catch(error=>report(error,{form:event.target}))); };
  app.changePassword = (event) => { event.preventDefault();if(!recovery.ensureOnline())return false; return fire(auth.changePassword(event.target).then((/** @type {boolean|undefined} */ ok)=>{if(ok)app.toast('Password changed. Other sessions and app access revoked');}).catch(error=>report(error,{form:event.target}))); };
  app.updMe = (value) => {
    const displayName=text(value,80),form=document.querySelector('.settings');if(!displayName)return fieldError(form,'name','Enter your full name.');
    const me=data.users.find((item)=>item.id===data.session?.userId);if(me?.name===displayName)return false;if(!recovery.ensureOnline())return false;
    const scope=sessionScope(),generation=++profileNameGeneration;
    if(profileNameQueueScope!==scope){profileNameQueueScope=scope;profileNameQueue=Promise.resolve();}
    const request=profileNameQueue.catch(()=>{}).then(async()=>{
      if(sessionScope()!==scope)return stale();
      const response=await api.updateProfile(displayName);
      if(sessionScope()!==scope||generation!==profileNameGeneration||!data.users.includes(me))return stale();
      me.name=response.user.displayName;me.avatar=response.user.avatarUrl??me.avatar;
      if(context().view==='profile'){app.refresh();app.toast('Profile saved');}
      return response;
    });
    profileNameQueue=request;recovery.trackWrite(request);return fire(request.catch(reportFor(scope,{form},()=>generation===profileNameGeneration)));
  };
  app.setAvatar=(input)=>{
    const file=input.files?.[0],me=data.users.find((item)=>item.id===data.session?.userId);if(!file||!me)return;
    // The server takes avatars up to this size, so a larger image isn't sent.
    const limit=data.limits.maxAvatarBytes,tooLarge=`Use an image of at most ${Math.round(limit/1024/1024*10)/10} MiB.`;
    if(file.size>limit){input.value='';app.toast(tooLarge,'error');return;}
    const scope=sessionScope(),generation=++avatarGeneration;
    if(avatarQueueScope!==scope){avatarQueueScope=scope;avatarQueue=Promise.resolve();}
    const request=avatarQueue.catch(()=>{}).then(async()=>{
      if(sessionScope()!==scope)return stale();
      const response=await api.uploadAvatar(file);
      if(sessionScope()!==scope||generation!==avatarGeneration||!data.users.includes(me))return stale();
      me.avatar=response.avatarUrl;if(context().view==='profile'){app.refresh();app.toast('Avatar updated');}return response;
    });
    const reportAvatar=reportFor(scope,{},()=>generation===avatarGeneration);
    avatarQueue=request;recovery.trackWrite(request);return fire(request.catch((error)=>{
      if(error?.status===413||error?.code==='request_too_large'){if(sessionScope()===scope&&generation===avatarGeneration)app.toast(tooLarge,'error');return;}
      reportAvatar(error);
    }).finally(()=>{input.value='';}));
  };
  app.removeAvatar=()=>{
    const me=data.users.find((item)=>item.id===data.session?.userId);if(!me)return false;
    return app.confirm({title:'Remove avatar?',text:'Your account will use its default avatar.',action:'Remove avatar',confirm:()=>{
      const scope=sessionScope(),generation=++avatarGeneration;
      if(avatarQueueScope!==scope){avatarQueueScope=scope;avatarQueue=Promise.resolve();}
      const request=avatarQueue.catch(()=>{}).then(async()=>{
        if(sessionScope()!==scope)return stale();await api.removeAvatar();
        if(sessionScope()!==scope||generation!==avatarGeneration||!data.users.includes(me))return stale();
        me.avatar=null;if(context().view==='profile'){app.refresh();app.toast('Avatar removed');}return {};
      });
      avatarQueue=request;recovery.trackWrite(request);return fire(request.catch(reportFor(scope,{},()=>generation===avatarGeneration)));
    }});
  };
  app.revokeSession = (id) => app.confirm({title:'Revoke session?',text:'This browser will need to sign in again.',action:'Revoke session',confirm:()=>fire(auth.revokeSession(id).then(()=>loadProfileAccess()).catch(report))});
  app.revokeOtherSessions = () => app.confirm({title:'Sign out other sessions?',text:'All other browser sessions will end.',action:'Sign out other sessions',confirm:()=>fire(auth.revokeOtherSessions().then(()=>loadProfileAccess()).catch(report))});
  app.revokeAppAccess=(id)=>app.confirm({title:'Revoke connected app?',text:'The app will lose its authorized access.',action:'Revoke access',confirm:()=>fire(api.revokeConnectedApp(id).then(()=>loadProfileAccess()).catch(report))});
  /** @param {any} error @param {string} scope @param {string} id @param {HTMLFormElement|null} form */
  async function recoverUser(error,scope,id,form=null) {
    if(sessionScope()!==scope)return;
    if(!recovery.isRevisionConflict(error))return report(error,{form});
    const result=await loadUsers(false,id);
    if(result.stale||sessionScope()!==scope)return;
    if(result.error)return report(result.error,{form});
    const latest=data.users.find(user=>user.id===id);
    if(form?.isConnected&&context().modal?.type==='user'&&context().modal?.id===id&&latest){
      for(const [name,value] of Object.entries({name:latest.name,admin:latest.admin,active:latest.active})){
        const input=form.querySelector(/** @type {'input'} */(`[name="${name}"]`));
        if(input){if(name==='name')input.value=String(value);else input.checked=!!value;}
      }
      fieldError(form,'name','This user changed. Review the latest values and save again.');
    }else app.toast('This user changed. Review the latest values and try again.','error');
  }
  app.saveUser=(event,id)=>{
    if(!recovery.ensureOnline()){event.preventDefault();return false;}
    const form=event.target,values=formValues(event),displayName=text(values.get('name'),80),scope=sessionScope();
    if(!displayName)return fieldError(form,'name','Give the user a name.');
    if(id){
      const item=data.users.find((entry)=>entry.id===id);if(!item)return fieldError(form,'name','This user is no longer listed. Reload Users and try again.');
      const isAdmin=form.querySelector('[name="admin"]')?.disabled?item.admin:values.has('admin'),isActive=form.querySelector('[name="active"]')?.disabled?item.active:values.has('active');
      if(item.name===displayName&&item.admin===isAdmin&&item.active===isActive){app.closeOverlays();return false;}
      const sensitive=item.admin!==isAdmin||item.active!==isActive;
      const expectedRevision=item.revision;
      // A refresh may replace the cached row, so look the account up by id.
      const save=()=>{
        if(sessionScope()!==scope)return Promise.resolve();
        if(!stillAdmin())return Promise.reject(adminGone());
        if(!data.users.some(user=>user.id===id)){fieldError(form,'name','This user is no longer listed. Reload Users and try again.');return Promise.resolve();}
        return api.updateUser(id,{displayName,isAdmin,isActive,expectedRevision}).then((user)=>{
        const latest=data.users.find(entry=>entry.id===id);
        if(sessionScope()!==scope||!latest)return;
        Object.assign(latest,{name:user.displayName,admin:user.isAdmin,active:user.isActive,revision:user.revision});completeForm(form,()=>app.closeOverlays());app.refreshUsers();app.toast('User saved');
        });
      };
      const apply=()=>fire((sensitive?auth.withRecentAuth(save):save()).catch((/** @type {any} */ error)=>recoverUser(error,scope,id,form)));
      if(item.active&&!isActive)return app.confirm({title:'Deactivate user?',text:`${item.name} will lose access, including existing sessions and connected apps.${item.admin&&!isAdmin?' Admin access will also be removed.':''}`,action:'Deactivate user',confirm:apply});
      if(item.admin&&!isAdmin)return app.confirm({title:'Remove admin access?',text:`${item.name} will keep only their project permissions.`,action:'Remove admin access',confirm:apply});
      return apply();
    }
    const username=text(values.get('username'),32).toLowerCase();
    if(!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username))return fieldError(form,'username','Use 3–32 lowercase letters, numbers, dots, dashes, or underscores.');
    const create=()=>api.createUser({username:text(values.get('username'),32),displayName,isAdmin:values.has('admin')}).then(({user,temporaryPassword})=>{
      if(sessionScope()!==scope)return;
      const account=mapUser(user);
      if(data.adminUsers.loaded){
        // Users list in the server's username order, a page at a time. A new
        // account joins only the loaded range; otherwise its own page brings it.
        const name=(id)=>data.users.find((item)=>item.id===id)?.username??'',last=name(data.adminUsers.ids.at(-1));
        if(!data.adminUsers.nextCursor||compareUsernames(account.username,last)<0){
          mergeAdminUsersPage(data,[account],{append:true,nextCursor:data.adminUsers.nextCursor});
          data.adminUsers.ids.sort((left,right)=>compareUsernames(name(left),name(right)));
        }else data.users.push(account);
      }
      else data.users.push(account);
      app.refreshUsers();
      // The password is shown once, so a closed dialog must not lose it.
      if(!completeForm(form,()=>app.showTemporaryPassword(user.id,temporaryPassword))&&app.showTemporaryPassword(user.id,temporaryPassword,{wait:true})===false)app.toast('User created. Its temporary password appears when this dialog closes.');
    });
    return fire((values.has('admin')?auth.withRecentAuth(create):create()).catch(reportFor(scope,{form})));
  };
  app.resetPassword=(id)=>{const scope=sessionScope();return app.confirm({title:'Reset password?',text:'Existing sessions and connected app access will be revoked.',action:'Reset password',confirm:()=>fire(auth.withRecentAuth(()=>api.resetUserPassword(id)).then(({temporaryPassword})=>{if(sessionScope()===scope&&app.showTemporaryPassword(id,temporaryPassword,{wait:true})===false)app.toast('Password reset. The temporary password appears when this dialog closes.');}).catch((/** @type {any} */ error)=>recoverUser(error,scope,id)))});};

  /**
   * A refresh with `keepDepth` reloads as many pages as were loaded, so the list keeps its place.
   * A `background` (live) refresh is passive: it never counts as the person using the session.
   */
  async function loadUsers(append=false,throughUser=/** @type {string|null} */(null),{keepDepth=false,background=false}={}){
    const generation=++usersGeneration,expectedSession=sessionScope();usersController?.abort();usersController=new AbortController();
    const depth=keepDepth&&data.adminUsers.loaded?usersDepth:1;
    data.adminUsers.loading=true;data.adminUsers.error=null;app.refreshUsers({loadingOnly:true});
    let response,pages=1;
    try{
      response=await api.users({afterUsername:append?usersAfter:undefined,background,signal:usersController.signal});
      while((throughUser&&!response.users.some((/** @type {any} */ user)=>user.id===throughUser)||pages<depth)&&response.nextCursor){
        if(generation!==usersGeneration||expectedSession!==sessionScope())return {stale:true};
        const page=await api.users({afterUsername:response.nextCursor,background,signal:usersController.signal});
        response={...page,users:[...response.users,...page.users]};pages++;
      }
    }
    catch(error){if(generation!==usersGeneration||error?.code==='aborted'||expectedSession!==sessionScope()||!['users','settings'].includes(context().view))return {stale:true};data.adminUsers.loading=false;data.adminUsers.error='Could not load users.';app.refreshUsers();return {error};}
    if(generation!==usersGeneration||expectedSession!==sessionScope()||!['users','settings'].includes(context().view))return {stale:true};
    const mapped=response.users.map(mapUser);usersAfter=Object.hasOwn(response,'nextCursor')?response.nextCursor:(mapped.length===50?mapped.at(-1).username:null);usersDepth=append?usersDepth+1:pages;mergeAdminUsersPage(data,mapped,{append,nextCursor:usersAfter});data.adminUsers.loading=false;data.adminUsers.error=null;append?app.acceptMoreUsers():app.refreshUsers();return {stale:false};
  }
  app.retryUsers=()=>fire(loadUsers(false).catch(report));
  app.loadMoreUsers=()=>{if(usersAfter&&!data.adminUsers.loading)return fire(loadUsers(true).catch(report));};

  app.retryProfileAccess=()=>fire(loadProfileAccess().catch(report));
  async function loadProfileAccess({background=false}={}){
    const generation=++profileGeneration,expectedSession=sessionScope();profileController?.abort();profileController=new AbortController();
    let sessionResponse,appResponse;
    app.refreshProfileAccess({loading:true});
    try{[sessionResponse,appResponse]=await Promise.all([api.sessions({signal:profileController.signal,background}),api.connectedApps({signal:profileController.signal,background})]);}
    catch(error){if(generation!==profileGeneration||error?.code==='aborted'||expectedSession!==sessionScope()||context().view!=='profile')return {stale:true};app.refreshProfileAccess({error:'Could not load account access. Try again.'});return {error};}
    if(generation!==profileGeneration||expectedSession!==sessionScope()||context().view!=='profile')return {stale:true};
    const userId=data.session?.userId;
    data.browserSessions.splice(0,data.browserSessions.length,...sessionResponse.sessions.map((session)=>({id:session.id,userId,device:sessionDeviceLabel(session),browser:sessionBrowserLabel(session),ip:session.clientIp||null,createdAt:session.createdAt*1000,lastActiveAt:session.lastActivityAt*1000,current:session.current,revokedAt:null})));
    data.appGrants.splice(0,data.appGrants.length,...appResponse.apps.map((grant)=>({id:grant.id,userId,clientName:grant.clientName,protocol:'MCP',authorizedAt:grant.createdAt*1000,lastUsedAt:grant.lastUsedAt?grant.lastUsedAt*1000:null,expiresAt:grant.expiresAt*1000,revokedAt:null,access:(grant.projects||[]).map((projectId)=>({projectId,permissions:(grant.scopes||[]).map((scope)=>scope==='project_read'?'read':scope)}))})));
    app.refreshProfileAccess();
    return {stale:false};
  }

  return {
    loadUsers,
    loadProfileAccess,
    /** Forget Users reads still on their way, as when the page changes. */
    leaveUsers(){usersGeneration++;usersController?.abort();},
    /** Forget Profile reads still on their way, as when the page changes. */
    leaveProfile(){profileGeneration++;profileController?.abort();},
  };
}
