// Shared set-up for the script tests: a scratch directory, fake commands on PATH,
// and fakes of the image registry and of GitHub releases.
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Calls `run` with a new temporary directory and removes the directory afterwards. */
export function inScratch(run) {
  const directory = mkdtempSync(join(tmpdir(), 'oneloop-script-test-'));
  try { return run(directory); } finally { rmSync(directory, {recursive: true, force: true}); }
}

/** Writes the Node program `source` as the executable `name` in `directory`. */
export function fakeCommand(directory, name, source) {
  writeFileSync(join(directory, name), `#!${process.execPath}\n${source}`, {mode: 0o700});
}

/** Runs scripts/`script` in `directory`, which comes first on PATH so that its fake commands run. */
export function runScript(script, args, directory, env = {}) {
  return spawnSync(process.execPath, [fileURLToPath(new URL(`../${script}`, import.meta.url)), ...args], {
    cwd: directory, encoding: 'utf8', timeout: 10000,
    env: {...process.env, PATH: `${directory}:${process.env.PATH}`, ...env},
  });
}

/**
 * Installs a fake `docker buildx imagetools` in `directory` over `registry`, which maps image
 * references to manifests. `inspect --raw` fails as the registry does for a missing reference,
 * and with the `error` of an entry that has one. `create` combines its sources and annotations
 * into a new index, but copies a single source unchanged, as buildx does. It prints the index
 * with --dry-run, and stores it under each --tag otherwise.
 */
export function fakeRegistry(directory, registry) {
  const file = join(directory, 'registry.json');
  writeFileSync(file, JSON.stringify(registry));
  fakeCommand(directory, 'docker', `
const fs = require('node:fs');
const args = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(process.env.TEST_REGISTRY, 'utf8'));
if (args[0] !== 'buildx' || args[1] !== 'imagetools') process.exit(2);
if (args[2] === 'inspect' && args[3] === '--raw') {
  const entry = registry[args[4]];
  if (!entry || entry.error) { console.error(entry?.error ?? 'ERROR: ' + args[4] + ': not found'); process.exit(1); }
  console.log(JSON.stringify(entry, null, 2));
} else if (args[2] === 'create') {
  const tags = [], sources = [], annotations = {};
  let dryRun = false;
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--tag') tags.push(args[++i]);
    else if (args[i] === '--annotation') {
      const [key, value] = args[++i].replace(/^index:/, '').split(/=(.*)/s);
      annotations[key] = value;
    } else if (registry[args[i]]) sources.push(registry[args[i]]);
    else process.exit(2);
  }
  const index = sources.length === 1 && !Object.keys(annotations).length ? sources[0]
    : {schemaVersion: 2, manifests: sources.flatMap(source => source.manifests), annotations};
  if (dryRun) console.log(JSON.stringify(index, null, 2));
  else {
    for (const tag of tags) registry[tag] = index;
    fs.writeFileSync(process.env.TEST_REGISTRY, JSON.stringify(registry));
  }
} else process.exit(2);
`);
  return {env: {TEST_REGISTRY: file}, state: () => JSON.parse(readFileSync(file, 'utf8'))};
}

/**
 * Installs a fake `gh` in `directory` that knows the release tags in `releases`, and records
 * each call. Every call fails with TEST_ERROR when it is set.
 */
export function fakeGitHub(directory, releases) {
  const calls = join(directory, 'calls');
  writeFileSync(calls, '');
  fakeCommand(directory, 'gh', `
const args = process.argv.slice(2);
require('node:fs').appendFileSync(process.env.TEST_CALLS, args.join(' ') + '\\n');
if (process.env.TEST_ERROR) { console.error(process.env.TEST_ERROR); process.exit(1); }
const releases = JSON.parse(process.env.TEST_RELEASES);
if (args[0] !== 'release') process.exit(2);
if (args[1] === 'list') console.log(JSON.stringify(releases.map(tagName => ({tagName}))));
else if (args[1] !== 'view') process.exit(2);
else if (releases.includes(args[2])) console.log(JSON.stringify({tagName: args[2]}));
else { console.error('release not found'); process.exit(1); }
`);
  return {env: {TEST_CALLS: calls, TEST_RELEASES: JSON.stringify(releases)}, calls: () => readFileSync(calls, 'utf8')};
}
