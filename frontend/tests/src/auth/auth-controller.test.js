import {ApiError} from '../../../src/data/api-client.js';
import assert from 'node:assert/strict';
import test, {mock} from 'node:test';
import {createRequire} from 'node:module';
import {createAuthController} from '../../../src/auth/auth-controller.js';
import {useGlobals,settle,waitFor} from '../../support/helpers.cjs';

const {JSDOM}=createRequire(import.meta.url)('../../support/dom.cjs');

/** A page with #app whose document, HTMLElement and FormData stand in for the global ones until test `t` ends. */
function page(t){
  const {window}=new JSDOM('<main id="app"></main>');
  useGlobals(t,{document:window.document,HTMLElement:window.HTMLElement,FormData:window.FormData});
  return window.document;
}

/** Submit `form` as a person would; its handler may still be running afterwards. */
const submit=(form)=>form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit',{bubbles:true,cancelable:true}));
const button=(root,text)=>[...root.querySelectorAll('button')].find((item)=>item.textContent===text);

function reauthHarness(t,api,reportError=()=>{}){
  const document=page(t);
  const data={session:{id:'s1',userId:'u1',authenticatedAt:0}};
  const auth=createAuthController({api,data,refresh:()=>{},loadBootstrap:async()=>{},reportError});
  return {auth,data,document,form:()=>document.querySelector('form'),cancel:()=>button(document,'Cancel')};
}

function authData(session=null){
  return {session,users:[],projects:[],tracks:[],epics:[],milestones:[],tasks:[],pool:[],notifications:[],browserSessions:[],appGrants:[],inboxUnreadCount:0,boardPageInfo:null,projectTaskCounts:{},poolPageInfo:{},epicPageInfo:{},adminUsers:{ids:[],nextCursor:null,loaded:false}};
}

/** A sign-in card whose form has a named input for each of `fields`. */
function authForm(document,fields={}){
  const card=document.createElement('section');card.className='auth-card';
  const form=document.createElement('form');
  for(const [name,value] of Object.entries(fields)){const input=document.createElement('input');input.name=name;input.value=value;form.append(input);}
  card.append(form);document.getElementById('app').append(card);
  return {card,form};
}

test('runtime expiry clears every private projection while leaving the internal route to the shell',()=>{
  const data={
    session:{id:'s1',userId:'u1'},users:[{id:'u1'}],projects:[{id:'p1'}],tracks:[{}],epics:[{}],milestones:[{}],tasks:[{}],pool:[{}],notifications:[{}],browserSessions:[{}],appGrants:[{}],
    inboxUnreadCount:3,boardPageInfo:{},projectTaskCounts:{p1:{}},poolPageInfo:{p1:{}},epicPageInfo:{e1:{}},adminUsers:{ids:['u1'],nextCursor:'next',loaded:true},
  };
  let refreshes=0,sessionChange='unchanged';
  const auth=createAuthController({api:{},data,refresh:()=>refreshes++,loadBootstrap:async()=>{},reportError:()=>{},onSessionChange:(value)=>{sessionChange=value;}});
  auth.expire();
  for(const key of ['users','projects','tracks','epics','milestones','tasks','pool','notifications','browserSessions','appGrants'])assert.deepEqual(data[key],[]);
  assert.equal(data.session,null);assert.equal(data.inboxUnreadCount,0);assert.deepEqual(data.epicPageInfo,{});assert.deepEqual(data.adminUsers,{ids:[],nextCursor:null,loaded:false});
  assert.equal(refreshes,1);assert.equal(sessionChange,null);
});

test('recent authentication keeps the dialog owned until the protected action settles',async(t)=>{
  const actionError=new Error('protected action failed');let reports=0;
  const state=reauthHarness(t,{recentAuth:async()=>({authenticatedAt:123})},()=>reports++);
  const result=state.auth.withRecentAuth(async()=>{assert.ok(state.document.querySelector('.reauth-layer')?.isConnected);throw actionError;});
  assert.equal(state.form().getAttribute('aria-labelledby'),'reauth-title');
  assert.equal(state.document.getElementById('reauth-title').textContent,'Confirm your identity');
  submit(state.form());
  await assert.rejects(result,(error)=>error===actionError);
  assert.equal(state.document.querySelector('.reauth-layer'),null);
  assert.ok(!state.document.getElementById('app').inert,'the page behind takes input again');
  assert.equal(reports,0,'the action error belongs to its caller, not the removed password form');
});

test('cancelling a pending recent-auth request aborts it and never runs the protected action',async(t)=>{
  let signal,runCount=0;
  const state=reauthHarness(t,{recentAuth:(_password,options)=>new Promise((_resolve,reject)=>{
    signal=options.signal;signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true});
  })});
  const result=state.auth.withRecentAuth(async()=>{runCount++;});
  submit(state.form());
  state.cancel().click();
  await assert.rejects(result,(error)=>error.code==='reauth_cancelled');
  await settle();
  assert.equal(signal.aborted,true);assert.equal(runCount,0);
  assert.equal(state.document.querySelector('.reauth-layer'),null);
});

test('repeated submits run one protected action',async(t)=>{
  let authenticateCount=0,runCount=0;
  const state=reauthHarness(t,{recentAuth:async()=>{authenticateCount++;return {authenticatedAt:123};}});
  const result=state.auth.withRecentAuth(async()=>{runCount++;return 'saved';});
  submit(state.form());submit(state.form());
  assert.equal(await result,'saved');assert.equal(authenticateCount,1);assert.equal(runCount,1);
});

test('a completed login retries workspace loading without creating another session',async(t)=>{
  const {card,form}=authForm(page(t)),data=authData();
  const authResult={sessionId:'s1',authenticatedAt:123,user:{id:'u1',username:'owner',displayName:'Owner',isAdmin:true},mustChangePassword:false};
  let loginCalls=0,bootstrapCalls=0,refreshes=0,sessionChanges=0;
  const auth=createAuthController({
    api:{login:async()=>{loginCalls++;return authResult;},logout:async()=>{}},data,refresh:()=>refreshes++,
    loadBootstrap:async()=>{bootstrapCalls++;if(bootstrapCalls===1)throw new Error('offline');return {stale:false};},
    reportError:()=>{},onSessionChange:()=>sessionChanges++,
  });
  await auth.login({username:'owner',password:'secret'},form);
  assert.equal(loginCalls,1);assert.equal(refreshes,0);assert.equal(sessionChanges,0);assert.equal(form.hidden,true);
  const retry=button(card,'Try again');assert.ok(retry);
  retry.click();await settle();
  assert.equal(loginCalls,1,'retry must reuse the authenticated session');assert.equal(bootstrapCalls,2);
  assert.equal(refreshes,1);assert.equal(sessionChanges,1);assert.equal(data.session.id,'s1');
});

test('temporary-password completion retries only bootstrap after the password changed',async(t)=>{
  const {card,form}=authForm(page(t),{cur:'temporary',pw:'new password',pw2:'new password'}),data=authData({id:'old',userId:'u1',authenticatedAt:0,temporary:true});
  data.users.push({id:'u1',username:'owner',name:'Owner',mustChange:true});
  const authResult={sessionId:'s2',authenticatedAt:456,user:{id:'u1',username:'owner',displayName:'Owner',isAdmin:true},mustChangePassword:false};
  let passwordCalls=0,bootstrapCalls=0,sessionChanges=0;
  const auth=createAuthController({
    api:{changePassword:async()=>{passwordCalls++;return authResult;},logout:async()=>{}},data,refresh:()=>{},
    loadBootstrap:async()=>{bootstrapCalls++;if(bootstrapCalls===1)throw new Error('offline');return {stale:false};},reportError:()=>{},onSessionChange:()=>sessionChanges++,
  });
  assert.equal(await auth.setTemporaryPassword(form),false);assert.equal(passwordCalls,1);assert.equal(form.hidden,true);
  button(card,'Try again').click();await settle();
  assert.equal(passwordCalls,1,'the already accepted password change must not be repeated');assert.equal(bootstrapCalls,2);assert.equal(sessionChanges,1);assert.equal(data.session.id,'s2');
});

test('an older login completion cannot re-enable a form owned by a newer attempt',async(t)=>{
  const document=page(t),{form}=authForm(document),input=document.createElement('input'),save=document.createElement('button');form.append(input,save);
  const data=authData(),pending=[];
  const auth=createAuthController({
    api:{login:(credentials)=>new Promise((resolve)=>pending.push({credentials,resolve}))},data,refresh:()=>{},loadBootstrap:async()=>({stale:false}),reportError:()=>{},
  });
  const first=auth.login({username:'first',password:'one'},form),second=auth.login({username:'second',password:'two'},form);
  pending[0].resolve({sessionId:'s1',authenticatedAt:1,user:{id:'u1',username:'first',displayName:'First',isAdmin:false},mustChangePassword:false});
  await settle();assert.equal(input.disabled,true);assert.equal(save.disabled,true);
  pending[1].resolve({sessionId:'s2',authenticatedAt:2,user:{id:'u2',username:'second',displayName:'Second',isAdmin:false},mustChangePassword:false});
  await Promise.all([first,second]);assert.equal(input.disabled,false);assert.equal(save.disabled,false);assert.equal(data.session.id,'s2');
});

test('a fresh login never reuses another account completion that is still loading',async(t)=>{
  const document=page(t),firstForm=authForm(document).form,secondForm=authForm(document).form,data=authData();
  let releaseBootstrap,loginCalls=0,bootstrapCalls=0;
  const api={login:async(credentials)=>{loginCalls++;return {sessionId:`s-${credentials.username}`,authenticatedAt:1,user:{id:`u-${credentials.username}`,username:credentials.username,displayName:credentials.username,isAdmin:false},mustChangePassword:false};}}
  const auth=createAuthController({
    api,data,refresh:()=>{},reportError:()=>{},
    loadBootstrap:async()=>{bootstrapCalls++;if(bootstrapCalls===1)return new Promise((resolve)=>{releaseBootstrap=resolve;});return {stale:false};},
  });
  const first=auth.login({username:'first',password:'one'},firstForm);await waitFor(()=>bootstrapCalls===1);
  await auth.login({username:'second',password:'two'},secondForm);
  assert.equal(loginCalls,2);assert.equal(data.session.id,'s-second');
  releaseBootstrap({stale:false});await first;assert.equal(data.session.id,'s-second');
});

test('sensitive actions reuse password confirmation for thirty minutes, not ordinary activity',async(t)=>{
  const state=reauthHarness(t,{});
  state.data.session.authenticatedAt=Date.now()-20*60_000;
  let calls=0;await state.auth.withRecentAuth(()=>{calls++;});
  assert.equal(calls,1);assert.equal(state.form(),null);
  state.data.session.authenticatedAt=Date.now()-30*60_000;
  state.data.session.lastActivityAt=Date.now();
  const pending=state.auth.withRecentAuth(()=>{calls++;});
  assert.ok(state.form());state.cancel().click();
  await assert.rejects(pending,error=>error.code==='reauth_cancelled');assert.equal(calls,1);
});

test('both password forms require five Unicode characters without content or maximum-length rules',async(t)=>{
  const document=page(t),passwordForm=(password,confirmation=password)=>authForm(document,{cur:'current',pw:password,pw2:confirmation}).form;
  for(const method of ['setTemporaryPassword','changePassword']){
    const submitted=[],data=authData({id:'s1',userId:'u1',authenticatedAt:0});
    const auth=createAuthController({api:{changePassword:async(input)=>{
      submitted.push(input.newPassword);
      return {sessionId:'s1',authenticatedAt:1,user:{id:'u1',username:'owner',displayName:'Owner'},mustChangePassword:false};
    }},data,refresh:()=>{},loadBootstrap:async()=>({}),reportError:()=>{}});
    for(const password of ['', '1234', '😀😀😀😀']){
      await assert.rejects(auth[method](passwordForm(password)),/at least 5 characters/);
    }
    assert.equal(submitted.length,0);
    for(const password of ['12345','😀😀😀😀😀','     ','x'.repeat(8192)]){
      await auth[method](passwordForm(password));
      assert.equal(submitted.at(-1),password);
    }
    await assert.rejects(auth[method](passwordForm('12345','12346')),/Passwords do not match/);
    assert.equal(submitted.length,4);
  }
});

test('a rejected login address shows one safe link without redirecting or retrying credentials',async(t)=>{
  const {form}=authForm(page(t)),reported=[];let requests=0;
  const error={code:'invalid_origin',status:403,message:'Open the configured address.',details:{canonicalUrl:'http://127.0.0.1:8080/'}};
  const auth=createAuthController({api:{login:async()=>{requests++;throw error;}},data:authData(),loadBootstrap:async()=>{},refresh:()=>{},reportError:err=>reported.push(err)});
  await auth.login({username:'admin',password:'secret'},form);
  await auth.login({username:'admin',password:'secret'},form);
  assert.equal(requests,2);assert.equal(reported.length,0);assert.equal(form.hidden,false);
  assert.equal(form.querySelectorAll('.auth-address-error').length,1);
  const link=form.querySelector('.auth-address-error a');
  assert.equal(link.href,'http://127.0.0.1:8080/');assert.equal(link.textContent,'http://127.0.0.1:8080');
  form.querySelector('.auth-address-error').remove();
  error.details.canonicalUrl='javascript:alert(1)';
  await auth.login({username:'admin',password:'secret'},form);
  assert.equal(form.querySelector('.auth-address-error'),null);assert.equal(reported.length,1);
});

test('incorrect login stays in the form without exposing account existence',async(t)=>{
  const document=page(t),{form}=authForm(document),input=document.createElement('input');input.value='secret';form.append(input);
  const reports=[];let attempts=0;
  const auth=createAuthController({
    api:{login:async()=>{attempts++;throw {status:401,code:'invalid_credentials',message:'authentication is required'};}},
    data:authData(),refresh:()=>{},loadBootstrap:async()=>{},reportError:error=>reports.push(error),
  });
  await auth.login({username:'unknown',password:'secret'},form);
  assert.equal(attempts,1);assert.equal(reports.length,0);
  assert.equal(form.querySelector('.server-feedback')?.textContent,'Incorrect username or password.');
  assert.equal(input.value,'secret');assert.equal(input.disabled,false);
});

test('login waits for Retry-After without clearing input or automatically retrying',async(t)=>{
  const document=page(t),{form}=authForm(document),input=document.createElement('input'),save=document.createElement('button');
  input.value='secret';save.type='submit';form.append(input,save);
  mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  try{
    let attempts=0;
    const auth=createAuthController({
      api:{login:async()=>{attempts++;throw {status:429,code:'rate_limited',retryAfter:'1',message:'too many attempts'};}},
      data:authData(),refresh:()=>{},loadBootstrap:async()=>{},reportError:()=>{},
    });
    await auth.login({username:'owner',password:'secret'},form);
    assert.equal(attempts,1);assert.equal(save.disabled,true);assert.equal(input.disabled,false);
    assert.equal(form.querySelector('.server-feedback')?.textContent,'Too many attempts. Try again in 1 second.');
    await auth.login({username:'owner',password:'secret'},form);
    assert.equal(attempts,1,'submit during the wait must not reach the server');
    mock.timers.tick(999);assert.equal(save.disabled,true);
    mock.timers.tick(1);assert.equal(save.disabled,false);assert.equal(input.value,'secret');assert.equal(attempts,1);
  }finally{mock.timers.reset();}
});

test('wrong current password stays in the recent-auth dialog for correction',async(t)=>{
  const reports=[];
  const state=reauthHarness(t,{recentAuth:async()=>{throw {status:400,code:'incorrect_password',details:{field:'password'},message:'Incorrect current password.'};}},error=>reports.push(error));
  const pending=state.auth.withRecentAuth(async()=>{});
  const input=state.form().querySelector('input');input.value='wrong';
  submit(state.form());await settle();
  assert.equal(state.form().querySelector('.server-feedback')?.textContent,'Incorrect current password.');
  assert.equal(input.value,'wrong');assert.equal(reports.length,0);
  state.cancel().click();await assert.rejects(pending,error=>error.code==='reauth_cancelled');
});


test('session-limit choices use response timezone, activity order, IP and creation date',async(t)=>{
  const {card,form}=authForm(page(t)),requests=[];
  const older=Date.parse('2026-09-26T22:15:00Z')/1000,newer=older+3600;
  const sessions=[{id:'old',clientName:'Work browser',lastActivityAt:older,createdAt:older-86400},{id:'new',clientName:'Work browser',lastActivityAt:newer,createdAt:older,clientIp:'192.0.2.1'}];
  const data=authData();data.timeZone='UTC';
  const auth=createAuthController({api:{login:async credentials=>{requests.push(credentials);throw new ApiError('limit',{code:'session_limit',details:{sessions,timeZone:'Asia/Tashkent'}});}},data,refresh:()=>{},loadBootstrap:async()=>{},reportError:()=>{}});
  await auth.login({username:'owner',password:'secret'},form);
  const buttons=card.querySelectorAll('.session-limit-list button');
  assert.equal(buttons[0].textContent,'Work browser · Last active 2026-09-27 04:15 · 192.0.2.1 · Created 2026-09-27');
  assert.equal(buttons[1].textContent,'Work browser · Last active 2026-09-27 03:15 · Created 2026-09-26');
  buttons[0].click();await settle();assert.equal(requests[1].revokeSessionId,'new');
});

test('recent password confirmation is judged by the server clock',async(t)=>{
  const serverAhead=10*60_000;
  const state=reauthHarness(t,{serverNow:()=>Date.now()+serverAhead});
  state.data.session.authenticatedAt=Date.now()+serverAhead-35*60_000;
  let calls=0;const pending=state.auth.withRecentAuth(()=>{calls++;});
  assert.ok(state.form(),'a browser clock behind the server still asks for the password');assert.equal(calls,0);
  state.cancel().click();await assert.rejects(pending,error=>error.code==='reauth_cancelled');
});

test('a server that still asks for the password opens the prompt and retries once',async(t)=>{
  const required=new ApiError('recent authentication required',{status:412,code:'recent_auth_required'});
  const state=reauthHarness(t,{serverNow:()=>Date.now(),recentAuth:async()=>({authenticatedAt:Math.floor(Date.now()/1000)})});
  state.data.session.authenticatedAt=Date.now();
  let calls=0;const pending=state.auth.withRecentAuth(async()=>{calls++;if(calls===1)throw required;return 'saved';});
  await waitFor(()=>state.form());
  submit(state.form());
  assert.equal(await pending,'saved');assert.equal(calls,2);
});
