import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';

const {JSDOM}=createRequire(import.meta.url)('../../support/dom.cjs');

const base='https://oneloop.example/#/task/WEB-1';

test('script URLs pass only into the app\'s own folders on its own origin',async()=>{
  const policies=new Map(),win={location:{href:base},trustedTypes:{createPolicy(name,rules){policies.set(name,rules);return rules;}}};
  (await import(`../../../src/app/trusted-types.js?scripts=${Date.now()}`)).installTrustedTypes(win);
  const scriptURL=url=>policies.get('default').createScriptURL(url);
  for(const url of ['/vendor/pdfjs/pdf.worker.mjs','/v/abc123/vendor/pdfjs/pdf.worker.mjs','/views/app.js','https://oneloop.example/src/app/boot.js'])
    assert.equal(scriptURL(url),new URL(url,base).href,url);
  for(const url of ['https://cdn.example/vendor/x.js','/api/tasks/1','/styles/style.css','/vendor/../api/x','data:text/javascript,alert(1)','javascript:alert(1)','//cdn.example/vendor/x.js','/v/abc/api/x'])
    assert.equal(scriptURL(url),null,url);
});

test('the policies are created once, and plain strings pass where Trusted Types are missing',async()=>{
  const created=new Map();
  const win={location:{href:base},trustedTypes:{createPolicy(name,rules){if(created.has(name))throw new TypeError(`duplicate ${name}`);const policy={createHTML:source=>({html:rules.createHTML(source)}),createScriptURL:value=>({url:rules.createScriptURL(value)})};created.set(name,rules);return policy;}}};
  const module=await import(`../../../src/app/trusted-types.js?fresh=${Date.now()}`);
  const host=new JSDOM('<div></div>').window.document.querySelector('div');
  module.setTrustedHTML(host,'<b>x</b>');
  assert.equal(host.innerHTML,'<b>x</b>','strings pass before any policy exists');
  module.installTrustedTypes(win);module.installTrustedTypes(win);
  assert.deepEqual([...created.keys()],['oneloop','default']);
  assert.equal(created.get('default').createScriptURL('/vendor/pdfjs/pdf.worker.mjs'),'https://oneloop.example/vendor/pdfjs/pdf.worker.mjs');
  assert.equal(created.get('default').createScriptURL('https://cdn.example/x.js'),null,'other scripts are refused');
  assert.equal(created.get('default').createHTML,undefined,'HTML strings get no default pass');
});

test('the views\' HTML sink writes markup through the oneloop policy as written, into an element or a template',async()=>{
  const written=[];
  const win={location:{href:base},trustedTypes:{createPolicy(name,rules){return {createHTML:source=>{written.push([name,source]);return rules.createHTML(source);},createScriptURL:value=>rules.createScriptURL(value)};}}};
  const module=await import(`../../../src/app/trusted-types.js?sink=${Date.now()}`);
  module.installTrustedTypes(win);
  const d=new JSDOM('<div id="host"><b>Old</b></div><template id="template"></template>').window.document;
  const button='<button data-action="openTask" data-args=\'["BIR-1"]\'>Open</button>';
  module.setTrustedHTML(d.getElementById('host'),button);
  module.setTrustedHTML(d.getElementById('template'),'<p>Inert</p>');
  assert.deepEqual(written,[['oneloop',button],['oneloop','<p>Inert</p>']]);
  assert.equal(d.getElementById('host').innerHTML,'<button data-action="openTask" data-args="[&quot;BIR-1&quot;]">Open</button>');
  assert.equal(d.getElementById('template').content.firstElementChild.outerHTML,'<p>Inert</p>');
  assert.equal(d.getElementById('template').childNodes.length,0);
});
