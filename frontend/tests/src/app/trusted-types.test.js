import assert from 'node:assert/strict';
import test from 'node:test';
import {appScriptURL} from '../../../src/app/trusted-types.js';

const base='https://oneloop.example/#/task/WEB-1';

test('script URLs pass only into the app\'s own folders on its own origin',()=>{
  for(const url of ['/vendor/pdfjs/pdf.worker.mjs','/v/abc123/vendor/pdfjs/pdf.worker.mjs','/views/app.js','https://oneloop.example/src/app/boot.js'])
    assert.equal(appScriptURL(url,base),new URL(url,base).href,url);
  for(const url of ['https://cdn.example/vendor/x.js','/api/tasks/1','/styles/style.css','/vendor/../api/x','data:text/javascript,alert(1)','javascript:alert(1)','//cdn.example/vendor/x.js','/v/abc/api/x'])
    assert.equal(appScriptURL(url,base),null,url);
});

test('the policies are created once, and plain strings pass where Trusted Types are missing',async()=>{
  const created=new Map();
  const win={location:{href:base},trustedTypes:{createPolicy(name,rules){if(created.has(name))throw new TypeError(`duplicate ${name}`);const policy={createHTML:source=>({html:rules.createHTML(source)}),createScriptURL:value=>({url:rules.createScriptURL(value)})};created.set(name,rules);return policy;}}};
  const module=await import(`../../../src/app/trusted-types.js?fresh=${Date.now()}`);
  assert.equal(module.trustedHTML('<b>x</b>'),'<b>x</b>','strings pass before any policy exists');
  module.installTrustedTypes(win);module.installTrustedTypes(win);
  assert.deepEqual([...created.keys()],['oneloop','default']);
  assert.deepEqual(module.trustedHTML('<b>x</b>'),{html:'<b>x</b>'});
  assert.equal(created.get('default').createScriptURL('/vendor/pdfjs/pdf.worker.mjs'),'https://oneloop.example/vendor/pdfjs/pdf.worker.mjs');
  assert.equal(created.get('default').createScriptURL('https://cdn.example/x.js'),null,'other scripts are refused');
  assert.equal(created.get('default').createHTML,undefined,'HTML strings get no default pass');
});
