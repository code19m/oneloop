// Tests for deploy/launchd/oneloop-launchd.sh. launchd starts the job again
// after a non-zero exit, so the launcher exits 0 when a restart can't help.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const launcher = fileURLToPath(new URL('../../deploy/launchd/oneloop-launchd.sh', import.meta.url));
const ready = 'configuration and schema are valid (schema 3, data /data)';
const uninitialized = 'configuration is valid; database is not initialized (data /data)';

/** Runs the launcher with a fake oneloop: `serve --check` prints `output` and exits with `check`. */
function launch({check = 0, output = ready, serve = 0, binary} = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'launchd-test-'));
  try {
    const fake = join(scratch, 'fake oneloop'), calls = join(scratch, 'calls');
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LAUNCHER_TEST_CALLS"\nif [ "$2" = "--check" ]; then printf "%s\\n" "$LAUNCHER_TEST_OUTPUT"; exit "$LAUNCHER_TEST_CHECK"; fi\nexit "$LAUNCHER_TEST_SERVE"\n', {mode: 0o700});
    const result = spawnSync('/bin/sh', [launcher, binary ?? fake], {
      env: {...process.env, LAUNCHER_TEST_CALLS: calls, LAUNCHER_TEST_OUTPUT: output, LAUNCHER_TEST_CHECK: String(check), LAUNCHER_TEST_SERVE: String(serve)},
      encoding: 'utf8', timeout: 5000,
    });
    const invoked = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
    return {status: result.status, stdout: result.stdout, stderr: result.stderr, invoked};
  } finally { rmSync(scratch, {recursive: true, force: true}); }
}

test('launcher stops the job when a restart cannot help', () => {
  for (const [name, options, message, invoked] of [
    ['missing binary', {binary: '/Users/REPLACE_ME/.cargo/bin/oneloop'}, /REPLACE_ME\/\.cargo\/bin\/oneloop/, []],
    ['invalid setting', {check: 2}, /configuration check failed/, ['serve --check']],
    ['no database', {output: uninitialized}, /no database/, ['serve --check']],
  ]) {
    const result = launch(options);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stderr, message, name);
    // launchctl bootstrap fails while the stopped job is still loaded.
    assert.match(result.stderr, /unload the job with launchctl bootout and load it again with launchctl bootstrap/, name);
    assert.deepEqual(result.invoked, invoked, name);
  }
});

test('launcher leaves other failures to launchd and starts the server after a passing check', () => {
  for (const [options, status, invoked] of [
    [{check: 1}, 1, ['serve --check']],
    [{serve: 1}, 1, ['serve --check', 'serve']],
    [{serve: 0}, 0, ['serve --check', 'serve']],
  ]) {
    const result = launch(options);
    assert.equal(result.status, status, result.stderr);
    assert.deepEqual(result.invoked, invoked);
    if (invoked.length === 2) assert.ok(result.stdout.includes(ready), 'the check output reaches the log');
  }
});
