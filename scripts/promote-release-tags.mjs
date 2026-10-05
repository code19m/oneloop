// Promote a published stable image without moving latest or its minor tag backward.
// Run inside the release workflow's shared concurrency group; the read/write pair
// must stay serialized across releases. Usage: node scripts/promote-release-tags.mjs IMAGE X.Y.Z
// On GitHub Actions, the latest output tells whether latest now names this version.
import {appendFileSync} from 'node:fs';
import {imagetools, inspectRaw} from './imagetools.mjs';

const [image, version] = process.argv.slice(2);
function parts(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? '')) {
    throw new Error(`Expected a stable X.Y.Z version, got ${value}`);
  }
  return value.split('.').map(BigInt);
}
const candidate = parts(version);
if (!image || image.startsWith('-')) throw new Error('Expected an image name');

const minor = version.split('.').slice(0, 2).join('.');
const tags = [];
let latest = false;
for (const alias of [minor, 'latest']) {
  const reference = `${image}:${alias}`;
  // An absent alias is published for the first time.
  const published = inspectRaw(reference);
  if (published !== null) {
    const current = JSON.parse(published).annotations?.['org.opencontainers.image.version'];
    const existing = parts(current);
    if (alias !== 'latest' && current.split('.').slice(0, 2).join('.') !== minor) {
      throw new Error(`${reference} names a different minor version: ${current}`);
    }
    const difference = candidate.findIndex((part, i) => part !== existing[i]);
    if (difference === -1 || candidate[difference] < existing[difference]) {
      console.log(`Keep ${reference} at ${current}`);
      // A re-run finds latest at this version already.
      if (alias === 'latest') latest = difference === -1;
      continue;
    }
  }
  tags.push('--tag', reference);
  if (alias === 'latest') latest = true;
}

if (tags.length) {
  // A single index source preserves the version annotation and attestations.
  const result = imagetools('create', ...tags, `${image}:${version}`);
  if (result.status !== 0) throw new Error(`Cannot promote ${version}: ${result.stderr}`);
  process.stdout.write(result.stdout);
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `latest=${latest}\n`);
