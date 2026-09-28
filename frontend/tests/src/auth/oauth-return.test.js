import assert from 'node:assert/strict';
import test from 'node:test';
import {authorizationReturnTarget} from '../../../src/auth/oauth-return.js';

const origin='https://tasks.example.test';
const valid='/oauth/authorize?response_type=code&client_id=olc_1&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&code_challenge_method=S256&resource=https%3A%2F%2Ftasks.example.test%2Fmcp&scope=project_read&state=opaque';
const outer=(value)=>`?${new URLSearchParams({oauth_return:value})}`;

test('accepts only the same-origin internal OAuth authorization target',()=>{
  assert.equal(authorizationReturnTarget({origin,search:outer(valid)}),valid);
});

test('rejects external, credentialed, fragmented, malformed, and nested return targets',()=>{
  for(const value of [
    'https://evil.example/oauth/authorize?response_type=code',
    '//evil.example/oauth/authorize?response_type=code',
    '/oauth/authorize/../other?response_type=code',
    `${valid}#fragment`,
    '/oauth/authorize?response_type=code',
    `${valid}&client_id=second`,
    `${valid}&next=https%3A%2F%2Fevil.example`,
  ]) assert.equal(authorizationReturnTarget({origin,search:outer(value)}),null,value);
  assert.equal(authorizationReturnTarget({origin,search:`${outer(valid)}&extra=1`}),null);
  assert.equal(authorizationReturnTarget({origin,search:`${outer(valid)}&oauth_return=${encodeURIComponent(valid)}`}),null);
});
