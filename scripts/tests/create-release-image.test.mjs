// Tests for scripts/create-release-image.mjs: a published version tag never moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeRegistry, inScratch, runScript} from './support.mjs';

const image = 'ghcr.io/example/oneloop';
const digest = character => character.repeat(64);
// Each platform build pushes an index with its image and its attestation manifest.
const platform = character => ({schemaVersion: 2, manifests: [
  {digest: `sha256:${digest(character)}1`}, {digest: `sha256:${digest(character)}2`},
]});
const combined = (...characters) => ({schemaVersion: 2, manifests: characters.flatMap(c => platform(c).manifests)});
const sources = {[`${image}@sha256:${digest('a')}`]: platform('a'), [`${image}@sha256:${digest('b')}`]: platform('b')};

/** Runs the script against a registry that holds `registry`, and returns the result and the registry afterwards. */
function create(registry, version, digests = [digest('a'), digest('b')]) {
  return inScratch(directory => {
    const fake = fakeRegistry(directory, registry);
    const result = runScript('create-release-image.mjs', [image, version, ...digests], directory, fake.env);
    return {...result, registry: fake.state()};
  });
}

test('a new version combines both platform images under its version tag', () => {
  const result = create(sources, '1.2.3-rc.1');
  assert.equal(result.status, 0, result.stderr);
  const index = result.registry[`${image}:1.2.3-rc.1`];
  assert.deepEqual(index.manifests, combined('a', 'b').manifests);
  assert.equal(index.annotations['org.opencontainers.image.version'], '1.2.3-rc.1');
});

test('a re-run with the same platform images keeps the published version', () => {
  // Published by an earlier attempt, in another order and with other index annotations.
  const registry = {...sources, [`${image}:1.2.3`]: {...combined('b', 'a'), annotations: {note: 'earlier'}}};
  const result = create(registry, '1.2.3');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already names these images/);
  assert.deepEqual(result.registry, registry);
});

test('a version published with other images stops the run before any push', () => {
  for (const published of [combined('a', 'c'), combined('a'), platform('a').manifests[0]]) {
    const registry = {...sources, [`${image}:1.2.3`]: published};
    const result = create(registry, '1.2.3');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists with other images/);
    assert.deepEqual(result.registry, registry);
  }
});

test('unreadable version tags and bad input stop the run before any push', () => {
  const unreadable = error => ({...sources, [`${image}:1.2.3`]: {error}});
  for (const [registry, version, digests, message] of [
    [unreadable('ERROR: unauthorized'), '1.2.3', undefined, /Cannot inspect/],
    [unreadable('ERROR: connection reset by peer'), '1.2.3', undefined, /Cannot inspect/],
    [sources, '1.2.3', [digest('a')], /two platform digests/],
    [sources, 'latest', undefined, /Expected X\.Y\.Z/],
  ]) {
    const result = create(registry, version, digests);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.deepEqual(result.registry, registry);
  }
});
