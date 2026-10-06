import assert from 'node:assert/strict';
import test from 'node:test';
import { compileLegacyHandler } from '../../../src/app/view-events.js';

function event(overrides={}){return {key:'',isComposing:false,keyCode:0,repeat:false,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...overrides};}

test('compatibility handlers parse literals and invoke only allowlisted App methods', () => {
  const calls=[];
  const element={value:'New title',checked:true,blurred:false,blur(){this.blurred=true;}};
  const handler=compileLegacyHandler("event.stopPropagation();App.updTask('BIR-001','title',this.value)",()=>({updTask:(...args)=>calls.push(args)}));
  const input=event(); handler.call(element,input);
  assert.equal(input.stopped,true);
  assert.deepEqual(calls,[['BIR-001','title','New title']]);
});

test('explicit Enter adapter preserves composition and repeat guards without eval', () => {
  let saves=0;
  const handler=compileLegacyHandler("if(event.key==='Enter' && !event.isComposing && event.keyCode!==229 && !event.repeat){event.preventDefault();App.updateProjectField(this);this.blur()}",()=>({updateProjectField:()=>saves++}));
  const element={blurred:false,blur(){this.blurred=true;}};
  handler.call(element,event({key:'Enter',isComposing:true}));
  assert.equal(saves,0);
  const accepted=event({key:'Enter'});handler.call(element,accepted);
  assert.equal(saves,1);assert.equal(accepted.prevented,true);assert.equal(element.blurred,true);
});

test('unknown calls and expressions fail closed', () => {
  assert.throws(()=>compileLegacyHandler("App.constructor('alert(1)')()"),/Unsupported/);
  assert.throws(()=>compileLegacyHandler('window.location="https://example.com"'),/Unsupported/);
  assert.throws(()=>compileLegacyHandler('App.openTask(location.href)'),/Unsupported inline argument/);
});

test('recovery banners expose only their three bounded actions',()=>{
  const calls=[],previous=globalThis.Recovery;globalThis.Recovery={reconnect:()=>calls.push('reconnect')};
  try{compileLegacyHandler('Recovery.reconnect()')({});assert.deepEqual(calls,['reconnect']);assert.throws(()=>compileLegacyHandler('Recovery.sessionExpired()'),/Unsupported Recovery handler/);}
  finally{if(previous===undefined)delete globalThis.Recovery;else globalThis.Recovery=previous;}
});

test('migrating refreshed handlers replaces the old listener and rejects stale fallback handlers',async()=>{
  const {installViewEventOwner}=await import('../../../src/app/view-events.js');
  const previous={MutationObserver:globalThis.MutationObserver,App:globalThis.App};
  let observe;const errors=[],calls=[],attrs=new Map(),listeners=new Map();
  const element={nodeType:1,querySelectorAll:()=>[],getAttribute:name=>attrs.get(name)??null,setAttribute:(name,value)=>attrs.set(name,value),removeAttribute:name=>attrs.delete(name),addEventListener:(name,handler)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(handler);},removeEventListener:(name,handler)=>listeners.get(name)?.delete(handler)};
  globalThis.MutationObserver=class{constructor(callback){observe=callback;}observe(){}disconnect(){}};
  globalThis.App={inboxFilter:(...args)=>calls.push(args)};
  try{
    element.setAttribute('onclick',"App.inboxFilter('unread',false)");
    const dispose=installViewEventOwner(element,{onError:error=>errors.push(error)});
    for(let i=0;i<12;i++){
      element.setAttribute('onclick',`App.inboxFilter('unread',${i%2===0})`);observe([{type:'attributes',target:element}]);
      assert.equal(listeners.get('click').size,1);for(const handler of listeners.get('click'))handler.call(element,event());
    }
    assert.equal(calls.length,12);assert.deepEqual(calls.at(-1),['unread',false]);
    element.setAttribute('onclick','App.constructor()');observe([{type:'attributes',target:element}]);
    assert.equal(listeners.get('click').size,0);assert.equal(errors.length,1);dispose();
  }finally{
    Object.assign(globalThis,previous);
    for(const name of ['OneloopSetHTML','OneloopMigrateEvents','OneloopEventAttribute'])delete globalThis[name];
  }
});


test('handler parser rejects partial matches, quoted gadgets and altered keyboard guards',()=>{
  for(const source of ["App.toast('App.logout()')", "foo();App.toast('x')", "App.toast('x');foo()", "App.toast('x')garbage", "App.toast('x' + 'y')", "if(event.key==='Enter'||true){App.logout()}", "App.toast('unterminated)", "App.toast(,)"]){
    assert.throws(()=>compileLegacyHandler(source),/Unsupported/,source);
  }
  const provider=()=>({toast(){}});
  assert.equal(compileLegacyHandler("App.toast('cached')",provider),compileLegacyHandler("App.toast('cached')",provider));
  const calls=[];
  compileLegacyHandler("App.toast('hello, world');this.blur();App.toast('last')",()=>({toast:value=>calls.push(value)})).call({blur:()=>calls.push('blur')},event());
  assert.deepEqual(calls,['hello, world','blur','last']);
});

test('inert migration never binds actions in untrusted preview content',async()=>{
  const {createRequire}=await import('node:module');
  const require=createRequire(new URL('../../../package.json',import.meta.url));
  const {JSDOM}=require('jsdom');
  const {installViewEventOwner}=await import('../../../src/app/view-events.js');
  const dom=new JSDOM('<main id="app"></main>');
  const previous=globalThis.MutationObserver;globalThis.MutationObserver=dom.window.MutationObserver;
  try{
    const dispose=installViewEventOwner(dom.window.document.documentElement);
    const root=dom.window.document.getElementById('app');
    globalThis.OneloopSetHTML(root,`<button onclick="App.toast('trusted')">Trusted</button><div class="markdown-body"><button onclick="App.logout()">Untrusted</button></div>`);
    assert.equal(root.querySelector('button').hasAttribute('onclick'),false);
    assert.equal(root.querySelector('.markdown-body button').hasAttribute('data-oneloop-onclick'),false);
    assert.equal(root.querySelector('.markdown-body button').hasAttribute('onclick'),false);
    globalThis.OneloopSetHTML(root.querySelector('.markdown-body'),'<button onclick="App.logout()">Nested injection</button>');
    assert.equal(root.querySelector('.markdown-body button').hasAttribute('data-oneloop-onclick'),false);
    assert.equal(root.querySelector('.markdown-body button').hasAttribute('onclick'),false);
    const injected=dom.window.document.createElement('button');injected.setAttribute('onclick','App.logout()');root.append(injected);
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(injected.hasAttribute('onclick'),false);assert.equal(injected.hasAttribute('data-oneloop-onclick'),false);
    dispose();
  }finally{globalThis.MutationObserver=previous;dom.window.close();for(const name of ['OneloopSetHTML','OneloopMigrateEvents','OneloopEventAttribute'])delete globalThis[name];}
});
