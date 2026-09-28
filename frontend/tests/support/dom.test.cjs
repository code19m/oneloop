// The jsdom harness itself: view errors must not pass silently.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('./dom.cjs');

test('handler and timer exceptions in a view are recorded and fail the run', async () => {
  const dom = new JSDOM('<button></button>', { runScripts: 'outside-only' });
  const button = dom.window.document.querySelector('button');
  button.onclick = () => { throw Error('handler boom'); };
  const log = console.error;
  console.error = () => {};
  try {
    button.click();
    await new Promise(resolve => { dom.window.setTimeout(() => { setImmediate(resolve); throw Error('timer boom'); }, 0); });
  } finally { console.error = log; }
  assert.match(dom.errors.join('\n'), /handler boom/);
  assert.match(dom.errors.join('\n'), /timer boom/);
  assert.equal(process.exitCode, 1);
  // The errors were expected here; clear them so the harness does not fail this test.
  dom.errors.length = 0;
  process.exitCode = 0;
});
