// Tests for scripts/create-release-image.mjs: a published version tag never moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const script = fileURLToPath(new URL('../create-release-image.mjs', import.meta.url));
const image = 'ghcr.io/example/oneloop';
const digest = character => character.repeat(64);
// Each platform build pushes an index with its image and its attestation manifest.
const platform = character => ({schemaVersion: 2, manifests: [
  {digest: `sha256:${digest(character)}1`}, {digest: `sha256:${digest(character)}2`},
]});
const combined = (...characters) => ({schemaVersion: 2, manifests: characters.flatMap(c => platform(c).manifests)});

function fixture(registry, run) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-image-'));
  try {
    const state = join(cwd, 'registry.json');
    writeFileSync(state, JSON.stringify(registry));
    // Model only the registry: inspect, and create with or without --dry-run.
    writeFileSync(join(cwd, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(process.env.TEST_REGISTRY, 'utf8'));
if (args[0] !== 'buildx' || args[1] !== 'imagetools') process.exit(2);
if (args[2] === 'inspect' && args[3] === '--raw') {
  const reference = args[4];
  if (process.env.TEST_INSPECT_ERROR) { console.error(process.env.TEST_INSPECT_ERROR); process.exit(1); }
  if (!registry[reference]) { console.error('ERROR: ' + reference + ': not found'); process.exit(1); }
  console.log(JSON.stringify(registry[reference], null, 2));
} else if (args[2] === 'create') {
  let tag, dryRun = false, index = {schemaVersion: 2, manifests: [], annotations: {}};
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--tag') tag = args[++i];
    else if (args[i] === '--annotation') {
      const [key, value] = args[++i].replace(/^index:/, '').split(/=(.*)/s);
      index.annotations[key] = value;
    } else if (registry[args[i]]) index.manifests.push(...registry[args[i]].manifests);
    else process.exit(2);
  }
  if (dryRun) console.log(JSON.stringify(index, null, 2));
  else { registry[tag] = index; fs.writeFileSync(process.env.TEST_REGISTRY, JSON.stringify(registry)); }
} else process.exit(2);
`, {mode: 0o700});
    run((version, digests, error = '') => spawnSync(process.execPath, [script, image, version, ...digests], {
      cwd, encoding: 'utf8', timeout: 10000,
      env: {...process.env, PATH: `${cwd}:${process.env.PATH}`, TEST_REGISTRY: state, TEST_INSPECT_ERROR: error},
    }), () => JSON.parse(readFileSync(state, 'utf8')));
  } finally { rmSync(cwd, {recursive: true, force: true}); }
}

const sources = {[`${image}@sha256:${digest('a')}`]: platform('a'), [`${image}@sha256:${digest('b')}`]: platform('b')};

test('a new version combines both platform images under its version tag', () => {
  fixture(sources, (create, state) => {
    const result = create('1.2.3-rc.1', [digest('a'), digest('b')]);
    assert.equal(result.status, 0, result.stderr);
    const index = state()[`${image}:1.2.3-rc.1`];
    assert.deepEqual(index.manifests, combined('a', 'b').manifests);
    assert.equal(index.annotations['org.opencontainers.image.version'], '1.2.3-rc.1');
  });
});

test('a re-run with the same platform images keeps the published version', () => {
  // Published by an earlier attempt, in another order and with other index annotations.
  const registry = {...sources, [`${image}:1.2.3`]: {...combined('b', 'a'), annotations: {note: 'earlier'}}};
  fixture(registry, (create, state) => {
    const result = create('1.2.3', [digest('a'), digest('b')]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already names these images/);
    assert.deepEqual(state(), registry);
  });
});

test('a version published with other images stops the run before any push', () => {
  for (const published of [combined('a', 'c'), combined('a'), platform('a').manifests[0]]) {
    const registry = {...sources, [`${image}:1.2.3`]: published};
    fixture(registry, (create, state) => {
      const result = create('1.2.3', [digest('a'), digest('b')]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /already exists with other images/);
      assert.deepEqual(state(), registry);
    });
  }
});

test('unreadable version tags and bad input stop the run before any push', () => {
  fixture(sources, (create, state) => {
    for (const [version, digests, error, message] of [
      ['1.2.3', [digest('a'), digest('b')], 'ERROR: unauthorized', /Cannot inspect/],
      ['1.2.3', [digest('a'), digest('b')], 'ERROR: connection reset by peer', /Cannot inspect/],
      ['1.2.3', [digest('a')], '', /two platform digests/],
      ['latest', [digest('a'), digest('b')], '', /Expected X\.Y\.Z/],
    ]) {
      const result = create(version, digests, error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      assert.deepEqual(state(), sources);
    }
  });
});
