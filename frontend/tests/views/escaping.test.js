import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {compileLegacyHandler} from '../../src/app/view-events.js';

const source=readFileSync(new URL('../../views/motion.js',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('/** Escape'),source.indexOf('window.UIHTML=')),context);
const {UIEscape,UIArg}=context;

test('HTML and handler escaping preserve hostile quotes without extra actions',()=>{
  assert.equal(UIEscape(`'"<&>`),'&#39;&quot;&lt;&amp;&gt;');
  const value="opaque'\\\n\r\"<>&",calls=[];
  const encoded=UIArg(value);
  const decoded=encoded.replace(/&(amp|quot|#39|lt|gt);/g,(_,name)=>({amp:'&',quot:'"','#39':"'",lt:'<',gt:'>'}[name]));
  compileLegacyHandler(`App.openTask('${decoded}')`,()=>({openTask:id=>calls.push(id)})).call({},{});
  assert.deepEqual(calls,[value]);
  const attack=UIArg("');App.logout();('").replace(/&#39;/g,"'");
  assert.throws(()=>compileLegacyHandler(`App.openTask('${attack}')`),/Unsupported/);
});

test('shared templates encode handler strings, URLs and data attributes',()=>{
  const numericOrBoolean=new Set(['it.i','!!n.readAt','!filter.unread','!file.ephemeral','task.attachments.indexOf(f)']);
  for(const name of ['app','collaboration','uploads']){
    const source=readFileSync(new URL(`../../views/${name}.js`,import.meta.url),'utf8');
    for(const [attribute] of source.matchAll(/\bon\w+="[^"\n]*"/g)){
      for(const [,expression] of attribute.matchAll(/\$\{([^{}]+)\}/g))assert.ok(expression.startsWith('UIArg(')||numericOrBoolean.has(expression),`${name}: unencoded handler ${expression}`);
    }
    for(const [attribute] of source.matchAll(/\b(?:src|href|data-[\w-]+)="[^"\n]*"/g)){
      for(const [,expression] of attribute.matchAll(/\$\{([^{}]+)\}/g))assert.match(expression,/^(?:UIEscape|esc|escape|html)\(/,`${name}: unescaped attribute ${expression}`);
    }
  }
});
