// Tests for scripts/release-exists.mjs: only "release not found" means a missing release.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeGitHub, inScratch, runScript} from './support.mjs';

/** Runs the script against GitHub, where only v1.2.2 is released, or with every gh call failing with `error`. */
function exists(args, error = '') {
  return inScratch(directory => {
    const github = fakeGitHub(directory, ['v1.2.2']);
    return {...runScript('release-exists.mjs', args, directory, {...github.env, TEST_ERROR: error}), calls: github.calls()};
  });
}

test('published and missing releases are told apart', () => {
  for (const [tag, expected] of [['v1.2.2', 'true\n'], ['v1.2.3', 'false\n']]) {
    const result = exists([tag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.equal(result.calls, `release view ${tag} --json tagName\n`);
  }
});

test('gh failures and bad tags stop the script instead of answering', () => {
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
