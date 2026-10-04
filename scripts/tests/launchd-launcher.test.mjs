// Tests for deploy/launchd/oneloop-launchd.sh: configuration errors stop launchd retries.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('launchd preflight stops configuration retries and preserves runtime failures', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), 'launchd-test-'));
  try {
    const binary = join(scratch, 'fake oneloop'), calls = join(scratch, 'calls');
    writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LAUNCHER_TEST_CALLS"\nif [ "$2" = "--check" ]; then exit "$LAUNCHER_TEST_CHECK"; fi\nexit "$LAUNCHER_TEST_SERVE"\n', {mode: 0o700});
    for (const [check, serve, expected, invoked] of [[2, 1, 0, false], [1, 0, 1, false], [0, 1, 1, true], [0, 0, 0, true]]) {
      writeFileSync(calls, '');
      const result = spawnSync('/bin/sh', [join(root, 'deploy/launchd/oneloop-launchd.sh'), binary], {
        env: {...process.env, LAUNCHER_TEST_CALLS: calls, LAUNCHER_TEST_CHECK: String(check), LAUNCHER_TEST_SERVE: String(serve)},
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, expected, result.stderr);
      assert.equal(readFileSync(calls, 'utf8'), `serve --check\n${invoked ? 'serve\n' : ''}`);
      if (check === 2) assert.match(result.stderr, /configuration check failed/);
    }
  } finally { rmSync(scratch, {recursive: true, force: true}); }
});
