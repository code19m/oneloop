// Tests for scripts/newest-release.mjs: the docs site follows the highest stable release.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeGitHub, inScratch, runScript} from './support.mjs';

/** Runs the script against GitHub releases with the tags `releases`, or with every gh call failing with `error`. */
function newest({releases = [], error = ''} = {}) {
  return inScratch(directory => {
    const github = fakeGitHub(directory, releases);
    return {...runScript('newest-release.mjs', [], directory, {...github.env, TEST_ERROR: error}), calls: github.calls()};
  });
}

test('the newest release is the highest stable version, or the highest candidate while none is stable', () => {
  for (const [releases, expected] of [
    [['v0.1.0-rc.9', 'v0.1.0-rc.10', 'v0.0.9-rc.1', 'docs-preview'], 'v0.1.0-rc.10'],
    [['v0.9.1', 'v0.10.0-rc.9', 'v0.10.0-rc.10', 'v0.2.0', 'docs-preview'], 'v0.9.1'],
    [['v0.10.0-rc.10', 'v0.10.0', 'v0.9.1'], 'v0.10.0'],
    [['v1.0.1', 'v1.1.0-rc.1', 'v1.0.2'], 'v1.0.2'],
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
