// Tests for scripts/newest-release.mjs: the docs site follows the highest released version.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const script = fileURLToPath(new URL('../newest-release.mjs', import.meta.url));

/** Runs the script with a fake gh that lists `releases`, or fails with `error`. */
function newest({releases = [], error = ''} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'newest-release-'));
  try {
    writeFileSync(join(cwd, 'gh'), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.TEST_CALLS, process.argv.slice(2).join(' ') + '\\n');
if (process.env.TEST_ERROR) { console.error(process.env.TEST_ERROR); process.exit(1); }
console.log(process.env.TEST_RELEASES);
`, {mode: 0o700});
    const calls = join(cwd, 'calls');
    writeFileSync(calls, '');
    const result = spawnSync(process.execPath, [script], {
      cwd, encoding: 'utf8', timeout: 10000,
      env: {...process.env, PATH: `${cwd}:${process.env.PATH}`, TEST_CALLS: calls, TEST_ERROR: error,
        TEST_RELEASES: JSON.stringify(releases.map(tagName => ({tagName})))},
    });
    return {...result, calls: readFileSync(calls, 'utf8')};
  } finally { rmSync(cwd, {recursive: true, force: true}); }
}

test('the newest release is the highest version, and a final release follows its candidates', () => {
  for (const [releases, expected] of [
    [['v0.9.1', 'v0.10.0-rc.9', 'v0.10.0-rc.10', 'v0.2.0', 'docs-preview'], 'v0.10.0-rc.10'],
    [['v0.10.0-rc.10', 'v0.10.0', 'v0.9.1'], 'v0.10.0'],
    [['v1.0.1', 'v1.1.0-rc.1', 'v1.0.2'], 'v1.1.0-rc.1'],
  ]) {
    const result = newest({releases});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${expected}\n`, releases.join(' '));
    assert.equal(result.calls, 'release list --exclude-drafts --limit 1000 --json tagName\n');
  }
});

test('gh failures and a missing release stop the script instead of answering', () => {
  for (const [options, message] of [
    [{error: 'HTTP 401: Bad credentials (https://api.github.com/graphql)'}, /Bad credentials/],
    [{releases: []}, /No published release/],
    [{releases: ['docs-preview', 'v1.0']}, /No published release/],
  ]) {
    const result = newest(options);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
  }
});
