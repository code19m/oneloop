// The test helpers: a global that a test points elsewhere comes back when it ends.
const test = require('node:test');
const assert = require('node:assert/strict');
const { useGlobals } = require('./helpers.cjs');

test('globals a test replaces, even twice or where none existed, come back when it ends', async (t) => {
  globalThis.helperProbe = 'original';
  t.after(() => { delete globalThis.helperProbe; });
  await t.test('a test that replaces them', (inner) => {
    useGlobals(inner, { helperProbe: 'first', helperAbsent: 1 });
    useGlobals(inner, { helperProbe: 'second' });
    assert.equal(globalThis.helperProbe, 'second');
  });
  assert.equal(globalThis.helperProbe, 'original');
  assert.equal('helperAbsent' in globalThis, false);
});
