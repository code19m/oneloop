import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiError} from '../../../src/data/api-client.js';
import {presentFormError} from '../../../src/app/form-feedback.js';

test('a concurrent project-prefix conflict stays beside its editable field',()=>{
  const field={name:'key',value:'ONE'};
  const form={isConnected:true,querySelector:(selector)=>selector==='[name="key"]'?field:null,querySelectorAll:()=>[]};
  const calls=[];
  const app={fieldError:(target,name,message)=>calls.push({target,name,message})};
  const error=new ApiError('task prefix is reserved by another project or its history',{status:409,code:'conflict'});
  assert.equal(presentFormError(form,error,app),true);
  assert.deepEqual(calls,[{target:form,name:'key',message:'This task prefix is already in use. Choose another.'}]);
  assert.equal(field.value,'ONE');
});

test('unknown errors use one local notice and preserve a safe reference',()=>{
  const previousDocument=globalThis.document;
  globalThis.document={createElement:()=>({className:'',isConnected:true,setAttribute(){},textContent:''})};
  const form={isConnected:true,notice:null,querySelector(selector){return selector==='.server-feedback'?this.notice:null;},append(node){this.notice=node;}};
  try{
    const error=new ApiError('internal error: /private/path (reference: 01234567-abcd)',{status:500,code:'internal_error'});
    assert.equal(presentFormError(form,error),true);
    assert.equal(form.notice.textContent,'The request could not be completed. Reference: 01234567-abcd.');
    assert.equal(presentFormError(form,error),true);
    assert.equal(form.notice.textContent,'The request could not be completed. Reference: 01234567-abcd.');
  }finally{globalThis.document=previousDocument;}
});
