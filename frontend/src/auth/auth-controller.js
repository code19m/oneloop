// @ts-check

import { ApiError } from '../data/api-client.js';
import { applyAuthSession } from '../data/projection-store.js';
import { sessionDateLabel, sessionDateTimeLabel, sessionDeviceLabel } from './session-label.js';
import { isFormRetryPending, presentFormError } from '../app/form-feedback.js';

function disableForm(form, disabled) {
  for (const control of form?.querySelectorAll('input,button') ?? []) {
    control.disabled = disabled || (control.tagName === 'BUTTON' && isFormRetryPending(form)
      && (control.type === 'submit' || control.matches?.('.primary')));
  }
}

function validateNewPassword(password) {
  if ([...password].length < 5) throw new ApiError('Use at least 5 characters.', { code:'validation_error' });
}

export function createAuthController({ api, data, refresh, loadBootstrap, reportError, invalidate = () => {}, onSessionChange = (_session) => {} }) {
  let pendingCredentials = null;
  let pendingCompletion = null;
  let generation=0;
  const begin=()=>{generation++;invalidate();return generation;};
  const current=(token)=>token===generation;

  function clearPrivateData(){
    pendingCompletion=null;
    for(const key of ['users','projects','tracks','epics','milestones','tasks','pool','notifications','browserSessions','appGrants'])data[key]?.splice?.(0);
    data.session=null;data.inboxUnreadCount=0;data.boardPageInfo=null;data.projectTaskCounts={};data.poolPageInfo={};data.epicPageInfo={};data.adminUsers={ids:[],nextCursor:null,loaded:false};
    onSessionChange(null);
  }

  async function complete(auth,token) {
    if(!current(token))return false;
    pendingCompletion=auth;
    applyAuthSession(data, auth);
    if (!auth.mustChangePassword) {
      let result;
      try{result=await loadBootstrap();}
      catch(error){
        if(current(token)&&error instanceof ApiError&&error.status===401){pendingCredentials=null;clearPrivateData();}
        throw error;
      }
      if(!current(token))return false;
      if(result?.stale)throw new ApiError('Workspace loading was interrupted.',{code:'load_interrupted'});
    }
    pendingCompletion=null;
    onSessionChange(data.session);
    refresh();
    return true;
  }

  async function login(credentials, form, {resume=false}={}) {
    if(isFormRetryPending(form))return false;
    const token=begin();
    form?.querySelector?.('.auth-address-error')?.remove();
    form?.querySelector?.('.server-feedback')?.remove();
    disableForm(form, true);
    try {
      const auth = resume&&pendingCompletion ? pendingCompletion : await api.login(credentials);
      if(!current(token))return;
      pendingCredentials = auth.mustChangePassword ? credentials : null;
      await complete(auth,token);
    } catch (error) {
      if(!current(token))return;
      disableForm(form, false);
      if (error instanceof ApiError && error.code === 'session_limit') {
        pendingCredentials = credentials;
        const details=/** @type {{sessions?:unknown[],timeZone?:string}|undefined} */(error.details);
        showSessionLimit(form, details?.sessions ?? [], details?.timeZone ?? data.timeZone);
      } else if (error?.code === 'invalid_origin' && showAddressError(form,error)) {
        return;
      } else if(pendingCompletion)showCompletionRetry(form,()=>login(credentials,form,{resume:true}),'Signed in');
      else if (['invalid_credentials','rate_limited','unavailable'].includes(error?.code)
        && presentFormError(form,error,globalThis.App)) return;
      else reportError(error, form);
    } finally { if(current(token))disableForm(form, false); }
  }

  function showAddressError(form,error) {
    if(!form?.isConnected)return false;
    let url;
    try{url=new URL(error?.details?.canonicalUrl);}catch{return false;}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return false;
    form.querySelector('.auth-address-error')?.remove();
    const notice=document.createElement('p');notice.className='auth-notice auth-address-error';notice.setAttribute('role','alert');
    const copy=document.createElement('span');copy.textContent='This address is not configured for sign-in. Open ';
    const link=document.createElement('a');link.href=url.href;link.textContent=url.origin;link.referrerPolicy='no-referrer';
    const end=document.createElement('span');end.textContent=' to continue.';
    notice.append(copy,link,end);form.append(notice);return true;
  }

  function showSessionLimit(form, sessions, timeZone = 'UTC') {
    const card = form?.closest('.auth-card'); if (!card) return;
    const section = document.createElement('section'); section.className = 'session-limit-list';
    const heading = document.createElement('h2'); heading.textContent = 'Session limit reached'; heading.id = 'session-limit-heading'; heading.tabIndex = -1; section.setAttribute('aria-labelledby', heading.id); section.append(heading);
    const copy = document.createElement('p'); copy.textContent = 'Choose one session to sign out, then continue.'; section.append(copy);
    for (const session of [...sessions].sort((a,b)=>(b.lastActivityAt??0)-(a.lastActivityAt??0))) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn quiet';
      button.textContent = `${sessionDeviceLabel(session)} · Last active ${sessionDateTimeLabel(session.lastActivityAt, timeZone)}${session.clientIp ? ` · ${session.clientIp}` : ''} · Created ${sessionDateLabel(session.createdAt, timeZone)}`;
      button.addEventListener('click', () => {
        if (!pendingCredentials) return;
        login({ ...pendingCredentials, revokeSessionId: session.id }, form);
      });
      section.append(button);
    }
    form.hidden = true; card.querySelector('.session-limit-list')?.remove(); card.append(section); heading.focus();
  }

  function showCompletionRetry(form,retry,title) {
    const card=form?.closest?.('.auth-card')??form?.parentElement;if(!card)return false;
    const section=document.createElement('section');section.className='session-limit-list auth-completion-retry';
    const heading=document.createElement('h2');heading.textContent=title;
    const copy=document.createElement('p');copy.className='auth-notice';copy.textContent='Your workspace could not load. Check your connection and try again.';
    const retryButton=document.createElement('button');retryButton.type='button';retryButton.className='btn primary';retryButton.textContent='Try again';
    const otherButton=document.createElement('button');otherButton.type='button';otherButton.className='btn quiet';otherButton.textContent='Use another account';
    retryButton.addEventListener('click',async()=>{retryButton.disabled=true;otherButton.disabled=true;try{await retry();}catch(error){reportError(error,section);}if(section.isConnected){retryButton.disabled=false;otherButton.disabled=false;}});
    otherButton.addEventListener('click',async()=>{
      retryButton.disabled=true;otherButton.disabled=true;
      try{await api.logout();pendingCredentials=null;clearPrivateData();refresh();}
      catch(error){retryButton.disabled=false;otherButton.disabled=false;reportError(error,section);}
    });
    section.append(heading,copy,retryButton,otherButton);form.hidden=true;card.querySelector('.session-limit-list')?.remove();card.append(section);retryButton.focus();return true;
  }

  async function resumeCompletion(form,retry,token) {
    try{return await complete(pendingCompletion,token);}
    catch(error){if(current(token)&&pendingCompletion&&showCompletionRetry(form,retry,'Authentication complete'))return false;throw error;}
  }

  async function setTemporaryPassword(form) {
    if(isFormRetryPending(form))return false;
    const token=begin();
    if(pendingCompletion)return resumeCompletion(form,()=>setTemporaryPassword(form),token);
    const fields = new FormData(form), currentPassword = String(fields.get('cur') || pendingCredentials?.password || '');
    const newPassword = String(fields.get('pw') || '');
    validateNewPassword(newPassword);
    if (newPassword !== String(fields.get('pw2') || '')) throw new ApiError('Passwords do not match', { code:'validation_error' });
    const auth = await api.changePassword({ currentPassword, newPassword });
    if(!current(token))return;
    pendingCredentials = null;
    try{return await complete(auth,token);}
    catch(error){if(current(token)&&pendingCompletion&&showCompletionRetry(form,()=>setTemporaryPassword(form),'Password changed'))return false;throw error;}
  }

  async function changePassword(form) {
    if(isFormRetryPending(form))return false;
    const token=begin();
    if(pendingCompletion)return resumeCompletion(form,()=>changePassword(form),token);
    const fields = new FormData(form), newPassword = String(fields.get('pw') || '');
    validateNewPassword(newPassword);
    if (newPassword !== String(fields.get('pw2') || '')) throw new ApiError('Passwords do not match', { code:'validation_error' });
    const auth = await api.changePassword({ currentPassword:String(fields.get('cur') || ''), newPassword });
    try{return await complete(auth,token);}
    catch(error){if(current(token)&&pendingCompletion&&showCompletionRetry(form,()=>changePassword(form),'Password changed'))return false;throw error;}
  }

  return Object.freeze({
    async initialize() {
      const token=begin();
      try {
        const auth = await api.me();
        if(!current(token))return;
        await complete(auth,token);
      } catch (error) {
        if(!current(token))return;
        if (!(error instanceof ApiError && error.status === 401)) throw error;
        clearPrivateData();
      }
    },
    login,
    expire() {
      begin();
      pendingCredentials=null;
      clearPrivateData();
      refresh();
    },
    async logout() {
      const token=begin();
      await api.logout();
      if(!current(token))return;
      pendingCredentials=null;clearPrivateData();
      refresh();
    },
    setTemporaryPassword,
    changePassword,
    async sessions() { return (await api.sessions()).sessions; },
    async revokeSession(id) { await api.revokeSession(id); },
    async revokeOtherSessions() { return api.revokeOtherSessions(); },
    withRecentAuth(run) {
      // The sign-in time comes from the server, so compare it with the server's clock.
      const now=api.serverNow?.()??Date.now();
      if(now-(data.session?.authenticatedAt||0)<30*60_000){
        // If the server still asks for the password, ask once and try again.
        return Promise.resolve().then(run).catch((error)=>{if(error?.code==='recent_auth_required'&&data.session)return confirmIdentity(run);throw error;});
      }
      return confirmIdentity(run);
    },
  });

  function confirmIdentity(run) {
    const authGeneration=generation;
    return new Promise((resolve,reject)=>{
      if(document.querySelector('.reauth-layer')){reject(new ApiError('Authentication is already in progress',{code:'reauth_pending'}));return;}
      const previous=document.activeElement,appRoot=document.getElementById('app');if(appRoot)appRoot.inert=true;
      const layer=document.createElement('div');layer.className='confirmation-layer reauth-layer';
      const scrim=document.createElement('div');scrim.className='scrim';
      const wrap=document.createElement('div');wrap.className='confirmation-wrap';
      const form=document.createElement('form');form.className='confirm-dialog';form.setAttribute('role','dialog');form.setAttribute('aria-modal','true');
      const heading=document.createElement('h2');heading.id='reauth-title';heading.textContent='Confirm your identity';form.setAttribute('aria-labelledby',heading.id);
      const label=document.createElement('label');label.htmlFor='reauth-password';label.textContent='Current password';
      const input=document.createElement('input');input.className='ctl';input.id='reauth-password';input.name='password';input.type='password';input.autocomplete='current-password';input.required=true;
      const actions=document.createElement('div');actions.className='modal-actions';
      const cancel=document.createElement('button');cancel.className='btn quiet';cancel.type='button';cancel.textContent='Cancel';
      const submit=document.createElement('button');submit.className='btn primary';submit.type='submit';submit.textContent='Continue';
      actions.append(cancel,submit);form.append(heading,label,input,actions);wrap.append(form);layer.append(scrim,wrap);document.body.append(layer);
      let closed=false,phase='password';
      const authController=new AbortController();
      // Escape belongs to this prompt only; the dialog behind it stays open.
      const keydown=(event)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(!cancel.disabled)cancel.click();}else if(event.key==='Tab'){const controls=[input,cancel,submit].filter((control)=>!control.disabled),first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}};
      document.addEventListener('keydown',keydown,true);
      const close=()=>{if(closed)return;closed=true;document.removeEventListener('keydown',keydown,true);if(appRoot)appRoot.inert=false;layer.remove();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true});};
      cancel.addEventListener('click',()=>{if(phase==='action'||phase==='cancelled'||closed)return;phase='cancelled';authController.abort();close();reject(new ApiError('Authentication cancelled',{code:'reauth_cancelled'}));});
      form.addEventListener('submit',async(event)=>{
        event.preventDefault();
        if(phase!=='password'||isFormRetryPending(form))return;
        phase='authenticating';submit.disabled=true;
        let response;
        try{response=await api.recentAuth(input.value,{signal:authController.signal});}
        catch(error){
          if(phase==='cancelled'||closed)return;
          if(!current(authGeneration)){close();reject(error);return;}
          phase='password';submit.disabled=false;
          if(!['incorrect_password','rate_limited','unavailable'].includes(error?.code)
            || !presentFormError(form,error,globalThis.App)) reportError(error,form);
          return;
        }
        if(phase==='cancelled'||closed)return;
        if(!current(authGeneration)){close();reject(new ApiError('The session changed during authentication',{code:'stale_session'}));return;}
        if(data.session)data.session.authenticatedAt=response.authenticatedAt*1000;
        input.value='';phase='action';input.disabled=true;cancel.disabled=true;
        try{
          const result=await run();
          if(!current(authGeneration)){close();reject(new ApiError('The session changed while saving',{code:'stale_session'}));return;}
          close();resolve(result);
        }
        catch(error){close();reject(error);}
      });
      input.focus();
    });
  }
}
