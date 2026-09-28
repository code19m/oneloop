import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionBrowserLabel, sessionDateLabel, sessionDateTimeLabel, sessionDeviceLabel, userAgentLabel } from '../../../src/auth/session-label.js';

const chromeMac='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

test('session labels summarize browsers and platforms without exposing user-agent strings',()=>{
  assert.equal(userAgentLabel(chromeMac),'Chrome on macOS');
  assert.equal(userAgentLabel('Mozilla/5.0 (Android 14; Mobile; rv:146.0) Gecko/146.0 Firefox/146.0'),'Firefox on Android');
  assert.equal(userAgentLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0'),'Edge on Windows');
  assert.equal(userAgentLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'),'Safari on iOS');
  assert.equal(sessionDeviceLabel({clientName:chromeMac,userAgent:chromeMac}),'Chrome on macOS');
  assert.equal(sessionBrowserLabel({clientName:chromeMac,userAgent:chromeMac}),null);
  assert.equal(sessionDeviceLabel({clientName:'Work Mac',userAgent:chromeMac}),'Work Mac');
  assert.equal(sessionBrowserLabel({clientName:'Work Mac',userAgent:chromeMac}),'Chrome on macOS');
  assert.equal(sessionDeviceLabel({clientName:'curl/8.0',userAgent:'curl/8.0'}),'Browser');
  assert.equal(sessionDeviceLabel({}),'Browser');
});

test('session-limit dates use the configured instance date format',()=>{
  assert.equal(sessionDateLabel(1_789_862_400,'Asia/Tashkent'),'2026-09-20');
  assert.equal(sessionDateLabel(null,'Asia/Tashkent'),'Unknown date');
  assert.equal(sessionDateLabel(undefined,'Asia/Tashkent'),'Unknown date');
});


test('session activity includes instance time across midnight and DST',()=>{
  const at=value=>Date.parse(value)/1000;
  assert.equal(sessionDateTimeLabel(at('2026-09-26T23:45:00Z'),'Asia/Tashkent'),'2026-09-27 04:45');
  assert.equal(sessionDateTimeLabel(at('2026-03-08T06:59:00Z'),'America/New_York'),'2026-03-08 01:59');
  assert.equal(sessionDateTimeLabel(at('2026-03-08T07:01:00Z'),'America/New_York'),'2026-03-08 03:01');
  assert.equal(sessionDateTimeLabel(null),'Unknown date');
});
