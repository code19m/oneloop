// Tests for scripts/promote-release-tags.mjs: latest and the minor tags only move forward.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fakeRegistry, inScratch, runScript} from './support.mjs';

const image = 'ghcr.io/example/oneloop';
const manifest = version => ({schemaVersion: 2, annotations: {'org.opencontainers.image.version': version}});

/** Calls `run` with a function that promotes a version in one registry, which starts as `registry`. */
function withRegistry(registry, run) {
  inScratch(directory => {
    const fake = fakeRegistry(directory, registry);
    const outputs = join(directory, 'outputs');
    run(version => {
      writeFileSync(outputs, '');
      const result = runScript('promote-release-tags.mjs', [image, version], directory, {...fake.env, GITHUB_OUTPUT: outputs});
      return {...result, registry: fake.state(), outputs: readFileSync(outputs, 'utf8')};
    });
  });
}

// Each release with the latest and minor tags expected after it, published in this order.
const releases = [
  ['1.2.10', '1.2.10', '1.2.10'],
  ['1.2.9', '1.2.10', '1.2.10'],
  ['1.10.0', '1.10.0', '1.10.0'],
  ['1.9.1', '1.10.0', '1.9.1'],
  ['2.0.0', '2.0.0', '2.0.0'],
  ['1.2.11', '2.0.0', '1.2.11'],
];
const published = () => Object.fromEntries(releases.map(([version]) => [`${image}:${version}`, manifest(version)]));

test('out-of-order releases only advance latest and each minor series numerically', () => {
  const registry = published();
  withRegistry(registry, promote => {
    for (const [version, latest, minorVersion] of releases) {
      const result = promote(version);
      assert.equal(result.status, 0, result.stderr);
      const minor = version.split('.').slice(0, 2).join('.');
      assert.deepEqual(result.registry[`${image}:latest`], manifest(latest));
      assert.deepEqual(result.registry[`${image}:${minor}`], manifest(minorVersion));
      for (const [tag, original] of Object.entries(registry)) assert.deepEqual(result.registry[tag], original);
    }
  });
});

test('the latest output says whether latest names the release, also on a re-run', () => {
  withRegistry(published(), promote => {
    for (const [version, latest] of [...releases, ['2.0.0', '2.0.0'], ['1.2.11', '2.0.0']]) {
      const result = promote(version);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.outputs, `latest=${latest === version}\n`, version);
    }
  });
});

// The minor tag is missing, so it would be published; latest is read after it.
test('unreadable or unknown alias versions stop promotion before any tags move', () => {
  for (const latest of [
    {error: 'ERROR: unauthorized'},
    {error: 'ERROR: connection reset by peer'},
    {error: 'ERROR: executable not found'},
    manifest(undefined),
    manifest('1.2.4-rc.1'),
  ]) {
    const registry = JSON.parse(JSON.stringify({[`${image}:1.2.3`]: manifest('1.2.3'), [`${image}:latest`]: latest}));
    withRegistry(registry, promote => {
      const result = promote('1.2.3');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Cannot inspect|Expected a stable/);
      assert.deepEqual(result.registry, registry);
    });
  }
});

test('release candidates cannot promote stable aliases', () => {
  const registry = {[`${image}:1.2.3-rc.1`]: manifest('1.2.3-rc.1')};
  withRegistry(registry, promote => {
    const result = promote('1.2.3-rc.1');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected a stable/);
    assert.deepEqual(result.registry, registry);
  });
});
