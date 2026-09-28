import test from 'node:test';
import assert from 'node:assert/strict';
import {createBuildMonitor} from '../../../src/app/build-info.js';

test('build checks coalesce, keep the original identity and notify once after a reconnect detects change',async()=>{
  let resolve,calls=0;const initial=[],changed=[];
  const monitor=createBuildMonitor({fetchBuild:()=>{calls++;return new Promise(done=>resolve=done);},onInitial:value=>initial.push(value),onUpdate:value=>changed.push(value)});
  let pending=monitor.check();monitor.check();assert.equal(calls,1);resolve({version:'1',revision:'one'});await pending;
  pending=monitor.check();resolve({version:'1',revision:'one'});await pending;assert.equal(changed.length,0);
  pending=monitor.check();resolve(null);await pending;
  pending=monitor.check();resolve({version:'1',revision:'two'});await pending;
  pending=monitor.check();resolve({version:'2',revision:'three'});await pending;
  assert.deepEqual(initial,[{version:'1',revision:'one'}]);assert.deepEqual(changed,[{version:'1',revision:'two'}]);
});
