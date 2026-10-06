// Tests for scripts/release-exists.mjs: only "release not found" means a missing release.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const script = fileURLToPath(new URL('../release-exists.mjs', import.meta.url));

function fixture(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-exists-'));
  try {
    // Answer like gh: a known tag succeeds, an unknown one fails with gh's message.
    writeFileSync(join(cwd, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, args.join(' ') + '\\n');
if (process.env.TEST_ERROR) { console.error(process.env.TEST_ERROR); process.exit(1); }
if (args[2] !== 'v1.2.2') { console.error('release not found'); process.exit(1); }
console.log(JSON.stringify({tagName: args[2]}));
`, {mode: 0o700});
    const calls = join(cwd, 'calls');
    writeFileSync(calls, '');
    run((args, error = '') => spawnSync(process.execPath, [script, ...args], {
      cwd, encoding: 'utf8', timeout: 10000,
      env: {...process.env, PATH: `${cwd}:${process.env.PATH}`, TEST_CALLS: calls, TEST_ERROR: error},
    }), () => readFileSync(calls, 'utf8'));
  } finally { rmSync(cwd, {recursive: true, force: true}); }
}

test('published and missing releases are told apart', () => {
  fixture((exists, calls) => {
    for (const [args, expected] of [[['v1.2.2'], 'true\n'], [['v1.2.3'], 'false\n']]) {
      const result = exists(args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected);
    }
    assert.equal(calls(), 'release view v1.2.2 --json tagName\nrelease view v1.2.3 --json tagName\n');
  });
});

test('gh failures and bad tags stop the script instead of answering', () => {
  fixture(exists => {
    for (const [args, error, message] of [
      [['v1.2.2'], 'HTTP 401: Bad credentials (https://api.github.com/repos/example/oneloop/releases/tags/v1.2.2)', /Bad credentials/],
      [['v1.2.3'], 'error connecting to api.github.com', /error connecting/],
      [['main'], '', /Expected vX\.Y\.Z/],
      [[], '', /Expected vX\.Y\.Z/],
    ]) {
      const result = exists(args, error);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, message);
    }
  });
});
