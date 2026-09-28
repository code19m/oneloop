import {ApiError} from '../../../src/data/api-client.js';
import assert from 'node:assert/strict';
import test, {mock} from 'node:test';
import {createAuthController} from '../../../src/auth/auth-controller.js';

class FakeElement {
  constructor(tagName='div') {
    this.tagName=tagName.toUpperCase();this.children=[];this.parentElement=null;this.listeners=new Map();
    this.className='';this.id='';this.textContent='';this.value='';this.disabled=false;this.hidden=false;this.inert=false;this.isConnected=false;
  }
  append(...children){for(const child of children){child.parentElement=this;this.children.push(child);child.connect(this.isConnected);}}
  connect(connected){this.isConnected=connected;for(const child of this.children)child.connect(connected);}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter((child)=>child!==this);this.parentElement=null;this.connect(false);}
  addEventListener(type,listener){const list=this.listeners.get(type)??[];list.push(listener);this.listeners.set(type,list);}
  async emit(type,event={}){for(const listener of this.listeners.get(type)??[])await listener(event);}
  click(){return this.emit('click',{preventDefault(){}});}
  focus(){globalThis.document.activeElement=this;}
  setAttribute(name,value){this.attributes??={};this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes?.[name]??null;}
  closest(selector){for(let item=this;item;item=item.parentElement)if(matchesSelector(item,selector))return item;return null;}
  matches(selector){return selector.startsWith('.')?this.className.split(/\s+/).includes(selector.slice(1)):false;}
  querySelector(selector){return find(this,selector);}
  querySelectorAll(selector){const matches=[];walk(this,(item)=>{if(matchesSelector(item,selector))matches.push(item);});return matches;}
}

function walk(root,visit){for(const child of root.children){visit(child);walk(child,visit);}}
function matchesSelector(item,selector){
  if(selector.includes(','))return selector.split(',').some((part)=>matchesSelector(item,part.trim()));
  if(selector.startsWith('.'))return item.className.split(/\s+/).includes(selector.slice(1));
  if(selector.startsWith('#'))return item.id===selector.slice(1);
  return item.tagName.toLowerCase()===selector.toLowerCase();
}
function find(root,selector){let found=null;walk(root,(item)=>{if(!found&&matchesSelector(item,selector))found=item;});return found;}

function fakeDocument(){
  const body=new FakeElement('body');body.connect(true);
  const app=new FakeElement('main');app.id='app';body.append(app);
  return {
    body,activeElement:app,
    createElement:(tag)=>new FakeElement(tag),
    getElementById:(id)=>id==='app'?app:find(body,`#${id}`),
    querySelector:(selector)=>find(body,selector),
    querySelectorAll:(selector)=>body.querySelectorAll(selector),
    addEventListener(){},removeEventListener(){},
  };
}

function reauthHarness(api,reportError=()=>{}){
  const originalDocument=globalThis.document,originalHTMLElement=globalThis.HTMLElement;
  const document=fakeDocument();globalThis.document=document;globalThis.HTMLElement=FakeElement;
  const data={session:{id:'s1',userId:'u1',authenticatedAt:0}};
  const auth=createAuthController({api,data,refresh:()=>{},loadBootstrap:async()=>{},reportError});
  return {
    auth,data,document,
    form:()=>document.querySelector('form'),
    cancel:()=>document.querySelectorAll('button').find((button)=>button.textContent==='Cancel'),
    restore(){globalThis.document=originalDocument;globalThis.HTMLElement=originalHTMLElement;},
  };
}

function authData(session=null){
  return {session,users:[],projects:[],tracks:[],epics:[],milestones:[],tasks:[],pool:[],notifications:[],browserSessions:[],appGrants:[],inboxUnreadCount:0,boardPageInfo:null,projectTaskCounts:{},poolPageInfo:{},epicPageInfo:{},adminUsers:{ids:[],nextCursor:null,loaded:false}};
}

function authForm(document,fields={}){
  const card=new FakeElement('section');card.className='auth-card';const form=new FakeElement('form');form.fields=fields;card.append(form);document.getElementById('app').append(card);return {card,form};
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

test('recent authentication keeps the dialog owned until the protected action settles',async()=>{
  const actionError=new Error('protected action failed');let reports=0;
  const state=reauthHarness({recentAuth:async()=>({authenticatedAt:123})},()=>reports++);
  try{
    const result=state.auth.withRecentAuth(async()=>{assert.ok(state.document.querySelector('.reauth-layer')?.isConnected);throw actionError;});
    assert.equal(state.form().getAttribute('aria-labelledby'),'reauth-title');
    assert.equal(state.document.getElementById('reauth-title').textContent,'Confirm your identity');
    await state.form().emit('submit',{preventDefault(){}});
    await assert.rejects(result,(error)=>error===actionError);
    assert.equal(state.document.querySelector('.reauth-layer'),null);
    assert.equal(state.document.getElementById('app').inert,false);
    assert.equal(reports,0,'the action error belongs to its caller, not the removed password form');
  }finally{state.restore();}
});

test('cancelling a pending recent-auth request aborts it and never runs the protected action',async()=>{
  let signal,runCount=0;
  const state=reauthHarness({recentAuth:(_password,options)=>new Promise((_resolve,reject)=>{
    signal=options.signal;signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true});
  })});
  try{
    const result=state.auth.withRecentAuth(async()=>{runCount++;});
    const submitting=state.form().emit('submit',{preventDefault(){}});
    await state.cancel().click();
    await assert.rejects(result,(error)=>error.code==='reauth_cancelled');
    await submitting;
    assert.equal(signal.aborted,true);assert.equal(runCount,0);
    assert.equal(state.document.querySelector('.reauth-layer'),null);
  }finally{state.restore();}
});

test('repeated submits run one protected action',async()=>{
  let authenticateCount=0,runCount=0;
  const state=reauthHarness({recentAuth:async()=>{authenticateCount++;return {authenticatedAt:123};}});
  try{
    const result=state.auth.withRecentAuth(async()=>{runCount++;return 'saved';});
    const first=state.form().emit('submit',{preventDefault(){}});
    const second=state.form().emit('submit',{preventDefault(){}});
    await Promise.all([first,second]);
    assert.equal(await result,'saved');assert.equal(authenticateCount,1);assert.equal(runCount,1);
  }finally{state.restore();}
});

test('a completed login retries workspace loading without creating another session',async()=>{
  const originalDocument=globalThis.document,originalHTMLElement=globalThis.HTMLElement;
  const document=fakeDocument();globalThis.document=document;globalThis.HTMLElement=FakeElement;
  const {card,form}=authForm(document),data=authData();
  const authResult={sessionId:'s1',authenticatedAt:123,user:{id:'u1',username:'owner',displayName:'Owner',isAdmin:true},mustChangePassword:false};
  let loginCalls=0,bootstrapCalls=0,refreshes=0,sessionChanges=0;
  const auth=createAuthController({
    api:{login:async()=>{loginCalls++;return authResult;},logout:async()=>{}},data,refresh:()=>refreshes++,
    loadBootstrap:async()=>{bootstrapCalls++;if(bootstrapCalls===1)throw new Error('offline');return {stale:false};},
    reportError:()=>{},onSessionChange:()=>sessionChanges++,
  });
  try{
    await auth.login({username:'owner',password:'secret'},form);
    assert.equal(loginCalls,1);assert.equal(refreshes,0);assert.equal(sessionChanges,0);assert.equal(form.hidden,true);
    const retry=card.querySelectorAll('button').find((button)=>button.textContent==='Try again');assert.ok(retry);
    await retry.click();
    assert.equal(loginCalls,1,'retry must reuse the authenticated session');assert.equal(bootstrapCalls,2);
    assert.equal(refreshes,1);assert.equal(sessionChanges,1);assert.equal(data.session.id,'s1');
  }finally{globalThis.document=originalDocument;globalThis.HTMLElement=originalHTMLElement;}
});

test('temporary-password completion retries only bootstrap after the password changed',async()=>{
  const originalDocument=globalThis.document,originalHTMLElement=globalThis.HTMLElement,originalFormData=globalThis.FormData;
  const document=fakeDocument();globalThis.document=document;globalThis.HTMLElement=FakeElement;globalThis.FormData=class {constructor(form){this.fields=form.fields;}get(name){return this.fields[name]??null;}};
  const {card,form}=authForm(document,{cur:'temporary',pw:'new password',pw2:'new password'}),data=authData({id:'old',userId:'u1',authenticatedAt:0,temporary:true});
  data.users.push({id:'u1',username:'owner',name:'Owner',mustChange:true});
  const authResult={sessionId:'s2',authenticatedAt:456,user:{id:'u1',username:'owner',displayName:'Owner',isAdmin:true},mustChangePassword:false};
  let passwordCalls=0,bootstrapCalls=0,sessionChanges=0;
  const auth=createAuthController({
    api:{changePassword:async()=>{passwordCalls++;return authResult;},logout:async()=>{}},data,refresh:()=>{},
    loadBootstrap:async()=>{bootstrapCalls++;if(bootstrapCalls===1)throw new Error('offline');return {stale:false};},reportError:()=>{},onSessionChange:()=>sessionChanges++,
  });
  try{
    assert.equal(await auth.setTemporaryPassword(form),false);assert.equal(passwordCalls,1);assert.equal(form.hidden,true);
    const retry=card.querySelectorAll('button').find((button)=>button.textContent==='Try again');await retry.click();
    assert.equal(passwordCalls,1,'the already accepted password change must not be repeated');assert.equal(bootstrapCalls,2);assert.equal(sessionChanges,1);assert.equal(data.session.id,'s2');
  }finally{globalThis.document=originalDocument;globalThis.HTMLElement=originalHTMLElement;globalThis.FormData=originalFormData;}
});

test('an older login completion cannot re-enable a form owned by a newer attempt',async()=>{
  const originalDocument=globalThis.document,originalHTMLElement=globalThis.HTMLElement;
  const document=fakeDocument();globalThis.document=document;globalThis.HTMLElement=FakeElement;
  const {form}=authForm(document),input=new FakeElement('input'),button=new FakeElement('button');form.append(input,button);
  const data=authData(),pending=[];
  const auth=createAuthController({
    api:{login:(credentials)=>new Promise((resolve)=>pending.push({credentials,resolve}))},data,refresh:()=>{},loadBootstrap:async()=>({stale:false}),reportError:()=>{},
  });
  const first=auth.login({username:'first',password:'one'},form),second=auth.login({username:'second',password:'two'},form);
  try{
    pending[0].resolve({sessionId:'s1',authenticatedAt:1,user:{id:'u1',username:'first',displayName:'First',isAdmin:false},mustChangePassword:false});
    await new Promise((resolve)=>setTimeout(resolve,0));assert.equal(input.disabled,true);assert.equal(button.disabled,true);
    pending[1].resolve({sessionId:'s2',authenticatedAt:2,user:{id:'u2',username:'second',displayName:'Second',isAdmin:false},mustChangePassword:false});
    await Promise.all([first,second]);assert.equal(input.disabled,false);assert.equal(button.disabled,false);assert.equal(data.session.id,'s2');
  }finally{globalThis.document=originalDocument;globalThis.HTMLElement=originalHTMLElement;}
});

test('a fresh login never reuses another account completion that is still loading',async()=>{
  const originalDocument=globalThis.document,originalHTMLElement=globalThis.HTMLElement;
  const document=fakeDocument();globalThis.document=document;globalThis.HTMLElement=FakeElement;
  const firstForm=authForm(document).form,secondForm=authForm(document).form,data=authData();
  let releaseBootstrap,loginCalls=0,bootstrapCalls=0;
  const api={login:async(credentials)=>{loginCalls++;return {sessionId:`s-${credentials.username}`,authenticatedAt:1,user:{id:`u-${credentials.username}`,username:credentials.username,displayName:credentials.username,isAdmin:false},mustChangePassword:false};}};
  const auth=createAuthController({
    api,data,refresh:()=>{},reportError:()=>{},
    loadBootstrap:async()=>{bootstrapCalls++;if(bootstrapCalls===1)return new Promise((resolve)=>{releaseBootstrap=resolve;});return {stale:false};},
  });
  try{
    const first=auth.login({username:'first',password:'one'},firstForm);while(bootstrapCalls<1)await new Promise((resolve)=>setTimeout(resolve,0));
    const second=auth.login({username:'second',password:'two'},secondForm);await second;
    assert.equal(loginCalls,2);assert.equal(data.session.id,'s-second');
    releaseBootstrap({stale:false});await first;assert.equal(data.session.id,'s-second');
  }finally{globalThis.document=originalDocument;globalThis.HTMLElement=originalHTMLElement;}
});

test('sensitive actions reuse password confirmation for thirty minutes, not ordinary activity',async()=>{
  const state=reauthHarness({});
  try{
    state.data.session.authenticatedAt=Date.now()-20*60_000;
    let calls=0;await state.auth.withRecentAuth(()=>{calls++;});
    assert.equal(calls,1);assert.equal(state.form(),null);
    state.data.session.authenticatedAt=Date.now()-30*60_000;
    state.data.session.lastActivityAt=Date.now();
    const pending=state.auth.withRecentAuth(()=>{calls++;});
    assert.ok(state.form());await state.cancel().click();
    await assert.rejects(pending,error=>error.code==='reauth_cancelled');assert.equal(calls,1);
  }finally{state.restore();}
});

test('both password forms require five Unicode characters without content or maximum-length rules',async()=>{
  const originalFormData=globalThis.FormData;
  globalThis.FormData=class {constructor(form){this.fields=form.fields;}get(name){return this.fields[name]??null;}};
  try{
    for(const method of ['setTemporaryPassword','changePassword']){
      const submitted=[],data=authData({id:'s1',userId:'u1',authenticatedAt:0});
      const auth=createAuthController({api:{changePassword:async(input)=>{
        submitted.push(input.newPassword);
        return {sessionId:'s1',authenticatedAt:1,user:{id:'u1',username:'owner',displayName:'Owner'},mustChangePassword:false};
      }},data,refresh:()=>{},loadBootstrap:async()=>({}),reportError:()=>{}});
      for(const password of ['', '1234', '😀😀😀😀']){
        await assert.rejects(auth[method]({fields:{cur:'current',pw:password,pw2:password}}),/at least 5 characters/);
      }
      assert.equal(submitted.length,0);
      for(const password of ['12345','😀😀😀😀😀','     ','x'.repeat(8192)]){
        await auth[method]({fields:{cur:'current',pw:password,pw2:password}});
        assert.equal(submitted.at(-1),password);
      }
      await assert.rejects(auth[method]({fields:{cur:'current',pw:'12345',pw2:'12346'}}),/Passwords do not match/);
      assert.equal(submitted.length,4);
    }
  }finally{globalThis.FormData=originalFormData;}
});

test('a rejected login address shows one safe link without redirecting or retrying credentials',async()=>{
  const previousDocument=globalThis.document;const document=fakeDocument();globalThis.document=document;
  try{
    const {form}=authForm(document),reported=[];let requests=0;
    const error={code:'invalid_origin',status:403,message:'Open the configured address.',details:{canonicalUrl:'http://127.0.0.1:8080/'}};
    const auth=createAuthController({api:{login:async()=>{requests++;throw error;}},data:authData(),loadBootstrap:async()=>{},refresh:()=>{},reportError:err=>reported.push(err)});
    await auth.login({username:'admin',password:'secret'},form);
    await auth.login({username:'admin',password:'secret'},form);
    assert.equal(requests,2);assert.equal(reported.length,0);assert.equal(form.hidden,false);
    assert.equal(form.querySelectorAll('.auth-address-error').length,1);
    const link=form.querySelector('.auth-address-error').querySelector('a');
    assert.equal(link.href,'http://127.0.0.1:8080/');assert.equal(link.textContent,'http://127.0.0.1:8080');
    form.querySelector('.auth-address-error').remove();
    error.details.canonicalUrl='javascript:alert(1)';
    await auth.login({username:'admin',password:'secret'},form);
    assert.equal(form.querySelector('.auth-address-error'),null);assert.equal(reported.length,1);
  }finally{globalThis.document=previousDocument;}
});

test('incorrect login stays in the form without exposing account existence',async()=>{
  const previousDocument=globalThis.document,document=fakeDocument();globalThis.document=document;
  try{
    const {form}=authForm(document),input=new FakeElement('input');input.value='secret';form.append(input);
    const reports=[];let attempts=0;
    const auth=createAuthController({
      api:{login:async()=>{attempts++;throw {status:401,code:'invalid_credentials',message:'authentication is required'};}},
      data:authData(),refresh:()=>{},loadBootstrap:async()=>{},reportError:error=>reports.push(error),
    });
    await auth.login({username:'unknown',password:'secret'},form);
    assert.equal(attempts,1);assert.equal(reports.length,0);
    assert.equal(form.querySelector('.server-feedback')?.textContent,'Incorrect username or password.');
    assert.equal(input.value,'secret');assert.equal(input.disabled,false);
  }finally{globalThis.document=previousDocument;}
});

test('login waits for Retry-After without clearing input or automatically retrying',async()=>{
  const previousDocument=globalThis.document,document=fakeDocument();globalThis.document=document;
  mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  try{
    const {form}=authForm(document),input=new FakeElement('input'),submit=new FakeElement('button');
    input.value='secret';submit.type='submit';form.append(input,submit);
    let attempts=0;
    const auth=createAuthController({
      api:{login:async()=>{attempts++;throw {status:429,code:'rate_limited',retryAfter:'1',message:'too many attempts'};}},
      data:authData(),refresh:()=>{},loadBootstrap:async()=>{},reportError:()=>{},
    });
    await auth.login({username:'owner',password:'secret'},form);
    assert.equal(attempts,1);assert.equal(submit.disabled,true);assert.equal(input.disabled,false);
    assert.equal(form.querySelector('.server-feedback')?.textContent,'Too many attempts. Try again in 1 second.');
    await auth.login({username:'owner',password:'secret'},form);
    assert.equal(attempts,1,'submit during the wait must not reach the server');
    mock.timers.tick(999);assert.equal(submit.disabled,true);
    mock.timers.tick(1);assert.equal(submit.disabled,false);assert.equal(input.value,'secret');assert.equal(attempts,1);
  }finally{mock.timers.reset();globalThis.document=previousDocument;}
});

test('wrong current password stays in the recent-auth dialog for correction',async()=>{
  const reports=[];
  const state=reauthHarness({recentAuth:async()=>{throw {status:400,code:'incorrect_password',details:{field:'password'},message:'Incorrect current password.'};}},error=>reports.push(error));
  try{
    const pending=state.auth.withRecentAuth(async()=>{});
    const input=state.form().querySelector('input');input.value='wrong';
    await state.form().emit('submit',{preventDefault(){}});
    assert.equal(state.form().querySelector('.server-feedback')?.textContent,'Incorrect current password.');
    assert.equal(input.value,'wrong');assert.equal(reports.length,0);
    await state.cancel().click();await assert.rejects(pending,error=>error.code==='reauth_cancelled');
  }finally{state.restore();}
});


test('session-limit choices use response timezone, activity order, IP and creation date',async()=>{
  const previousDocument=globalThis.document,document=fakeDocument();globalThis.document=document;
  try{
    const {card,form}=authForm(document),requests=[];
    const older=Date.parse('2026-09-26T22:15:00Z')/1000,newer=older+3600;
    const sessions=[{id:'old',clientName:'Work browser',lastActivityAt:older,createdAt:older-86400},{id:'new',clientName:'Work browser',lastActivityAt:newer,createdAt:older,clientIp:'192.0.2.1'}];
    const data=authData();data.timeZone='UTC';
    const auth=createAuthController({api:{login:async credentials=>{requests.push(credentials);throw new ApiError('limit',{code:'session_limit',details:{sessions,timeZone:'Asia/Tashkent'}});}},data,refresh:()=>{},loadBootstrap:async()=>{},reportError:()=>{}});
    await auth.login({username:'owner',password:'secret'},form);
    const buttons=card.querySelector('.session-limit-list').querySelectorAll('button');
    assert.equal(buttons[0].textContent,'Work browser · Last active 2026-09-27 04:15 · 192.0.2.1 · Created 2026-09-27');
    assert.equal(buttons[1].textContent,'Work browser · Last active 2026-09-27 03:15 · Created 2026-09-26');
    await buttons[0].click();assert.equal(requests[1].revokeSessionId,'new');
  }finally{globalThis.document=previousDocument;}
});
