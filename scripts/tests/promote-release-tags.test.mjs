import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const script = fileURLToPath(new URL('../promote-release-tags.mjs', import.meta.url));
const image = 'ghcr.io/example/oneloop';
const manifest = version => ({schemaVersion: 2, annotations: {'org.opencontainers.image.version': version}});

function fixture(registry, run) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-tags-'));
  try {
    const state = join(cwd, 'registry.json');
    writeFileSync(state, JSON.stringify(registry));
    // Model only the registry's inspect/copy operations. The real script makes
    // every version comparison; neither Docker nor a network is involved.
    writeFileSync(join(cwd, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(process.env.TEST_REGISTRY, 'utf8'));
if (args[0] !== 'buildx' || args[1] !== 'imagetools') process.exit(2);
if (args[2] === 'inspect') {
  const reference = args.at(-1);
  const error = reference.endsWith(':latest') && process.env.TEST_INSPECT_ERROR;
  if (error || !registry[reference]) {
    console.error(error || ('ERROR: ' + reference + ': not found'));
    process.exit(1);
  }
  console.log(JSON.stringify(registry[reference]));
} else if (args[2] === 'create') {
  const source = registry[args.at(-1)];
  if (!source) process.exit(2);
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--tag') registry[args[++i]] = source;
  }
  fs.writeFileSync(process.env.TEST_REGISTRY, JSON.stringify(registry));
} else process.exit(2);
`, {mode: 0o700});
    const outputs = join(cwd, 'outputs');
    run((version, error = '') => {
      writeFileSync(outputs, '');
      return spawnSync(process.execPath, [script, image, version], {
        cwd, encoding: 'utf8', timeout: 10000,
        env: {...process.env, PATH: `${cwd}:${process.env.PATH}`, TEST_REGISTRY: state, TEST_INSPECT_ERROR: error, GITHUB_OUTPUT: outputs},
      });
    }, () => JSON.parse(readFileSync(state, 'utf8')), () => readFileSync(outputs, 'utf8'));
  } finally { rmSync(cwd, {recursive: true, force: true}); }
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
  fixture(registry, (promote, state) => {
    for (const [version, latest, minorVersion] of releases) {
      const result = promote(version);
      assert.equal(result.status, 0, result.stderr);
      const current = state(), minor = version.split('.').slice(0, 2).join('.');
      assert.deepEqual(current[`${image}:latest`], manifest(latest));
      assert.deepEqual(current[`${image}:${minor}`], manifest(minorVersion));
      for (const [tag, original] of Object.entries(registry)) assert.deepEqual(current[tag], original);
    }
  });
});

test('the latest output says whether latest names the release, also on a re-run', () => {
  fixture(published(), (promote, state, outputs) => {
    for (const [version, latest] of [...releases, ['2.0.0', '2.0.0'], ['1.2.11', '2.0.0']]) {
      assert.equal(promote(version).status, 0);
      assert.equal(outputs(), `latest=${latest === version}\n`, version);
    }
  });
});

test('unreadable or unknown alias versions stop promotion before any tags move', () => {
  for (const [current, error] of [
    [undefined, 'ERROR: unauthorized'],
    [undefined, 'ERROR: connection reset by peer'],
    [undefined, 'ERROR: executable not found'],
    [undefined, ''],
    ['1.2.4-rc.1', ''],
  ]) {
    const registry = {[`${image}:1.2.3`]: manifest('1.2.3'), [`${image}:latest`]: manifest(current)};
    fixture(registry, (promote, state) => {
      const result = promote('1.2.3', error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Cannot inspect|Expected a stable/);
      assert.deepEqual(state(), JSON.parse(JSON.stringify(registry)));
    });
  }
});

test('release candidates cannot promote stable aliases', () => {
  const registry = {[`${image}:1.2.3-rc.1`]: manifest('1.2.3-rc.1')};
  fixture(registry, (promote, state) => {
    const result = promote('1.2.3-rc.1');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected a stable/);
    assert.deepEqual(state(), registry);
  });
});
