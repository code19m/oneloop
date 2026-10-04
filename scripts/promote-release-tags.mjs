// Promote a published stable image without moving latest or its minor tag backward.
// Run inside the release workflow's shared concurrency group; the read/write pair
// must stay serialized across releases. Usage: node scripts/promote-release-tags.mjs IMAGE X.Y.Z
import {spawnSync} from 'node:child_process';

const [image, version] = process.argv.slice(2);
function parts(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? '')) {
    throw new Error(`Expected a stable X.Y.Z version, got ${value}`);
  }
  return value.split('.').map(BigInt);
}
const candidate = parts(version);
if (!image || image.startsWith('-')) throw new Error('Expected an image name');

function imagetools(...args) {
  const result = spawnSync('docker', ['buildx', 'imagetools', ...args], {encoding: 'utf8'});
  if (result.error) throw result.error;
  return result;
}

const minor = version.split('.').slice(0, 2).join('.');
const tags = [];
for (const alias of [minor, 'latest']) {
  const reference = `${image}:${alias}`;
  const result = imagetools('inspect', '--raw', reference);
  if (result.status !== 0) {
    // Only an absent manifest allows first publication. Auth/network failures
    // must not be mistaken for an alias that is safe to overwrite.
    if (!result.stderr.trim().endsWith(`${reference}: not found`)
        && !/\bMANIFEST_UNKNOWN\b|\bmanifest unknown\b/.test(result.stderr)) {
      throw new Error(`Cannot inspect ${reference}: ${result.stderr}`);
    }
  } else {
    const current = JSON.parse(result.stdout).annotations?.['org.opencontainers.image.version'];
    const existing = parts(current);
    if (alias !== 'latest' && current.split('.').slice(0, 2).join('.') !== minor) {
      throw new Error(`${reference} names a different minor version: ${current}`);
    }
    const difference = candidate.findIndex((part, i) => part !== existing[i]);
    if (difference === -1 || candidate[difference] < existing[difference]) {
      console.log(`Keep ${reference} at ${current}`);
      continue;
    }
  }
  tags.push('--tag', reference);
}

if (tags.length) {
  // A single index source preserves the version annotation and attestations.
  const result = imagetools('create', ...tags, `${image}:${version}`);
  if (result.status !== 0) throw new Error(`Cannot promote ${version}: ${result.stderr}`);
  process.stdout.write(result.stdout);
}
