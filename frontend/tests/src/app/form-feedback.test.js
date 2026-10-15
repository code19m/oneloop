import assert from 'node:assert/strict';
import test, {mock} from 'node:test';
import {createRequire} from 'node:module';
import {ApiError} from '../../../src/data/api-client.js';
import {presentFormError} from '../../../src/app/form-feedback.js';
import {useGlobals} from '../../support/helpers.cjs';

const {JSDOM}=createRequire(import.meta.url)('../../support/dom.cjs');

/** A form in a page whose document stands in for the global one until test `t` ends. */
function page(t,controls=''){
  const {window}=new JSDOM(`<form>${controls}</form>`);
  useGlobals(t,{document:window.document});
  return window.document.querySelector('form');
}
const notices=form=>[...form.querySelectorAll('.server-feedback')].map(notice=>notice.textContent);

test('a concurrent project-prefix conflict stays beside its editable field',(t)=>{
  const form=page(t,'<input name="key" value="ONE">');
  const calls=[];
  const app={fieldError:(target,name,message)=>calls.push({target,name,message})};
  const error=new ApiError('task prefix is reserved by another project or its history',{status:409,code:'prefix_reserved'});
  assert.equal(presentFormError(form,error,app),true);
  assert.deepEqual(calls,[{target:form,name:'key',message:'This task prefix is already in use. Choose another.'}]);
  assert.equal(form.elements.key.value,'ONE');
  assert.deepEqual(notices(form),[]);
});

test('unknown errors use one local notice and preserve a safe reference',(t)=>{
  const form=page(t);
  const error=new ApiError('internal error: /private/path (reference: 01234567-abcd)',{status:500,code:'internal_error'});
  assert.equal(presentFormError(form,error),true);
  assert.equal(presentFormError(form,error),true);
  assert.deepEqual(notices(form),['The request could not be completed. Reference: 01234567-abcd.']);
});

test('a retry wait counts down in its notice and then invites another try',(t)=>{
  const form=page(t,'<button type="submit">Save</button>'),submit=form.querySelector('button');
  mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  try{
    presentFormError(form,new ApiError('too many attempts',{status:429,code:'rate_limited',retryAfter:'3'}));
    assert.deepEqual(notices(form),['Too many attempts. Try again in 3 seconds.']);
    assert.equal(submit.disabled,true);
    mock.timers.tick(1000);assert.deepEqual(notices(form),['Too many attempts. Try again in 2 seconds.']);
    mock.timers.tick(1000);assert.deepEqual(notices(form),['Too many attempts. Try again in 1 second.']);
    mock.timers.tick(1000);assert.deepEqual(notices(form),['You can try again now.']);
    assert.equal(submit.disabled,false);
  }finally{mock.timers.reset();}
});

test('the countdown leaves a newer message in the notice alone',(t)=>{
  const form=page(t);
  mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  try{
    presentFormError(form,new ApiError('unavailable',{status:503,code:'unavailable',retryAfter:'5'}));
    assert.deepEqual(notices(form),['The service is temporarily unavailable. Try again in 5 seconds.']);
    form.querySelector('.server-feedback').textContent='Saved.';
    mock.timers.tick(2000);assert.deepEqual(notices(form),['Saved.']);
  }finally{mock.timers.reset();}
});
