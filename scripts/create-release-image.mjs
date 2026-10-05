// Create the multi-architecture image IMAGE:VERSION from this run's two platform images.
// A published version never moves: when the tag exists already, it must name exactly these
// images (a re-run of failed jobs), or the script stops before it pushes anything.
// Usage: node scripts/create-release-image.mjs IMAGE VERSION DIGEST DIGEST
import {imagetools, inspectRaw} from './imagetools.mjs';

const [image, version, ...digests] = process.argv.slice(2);
if (!image || image.startsWith('-')) throw new Error('Expected an image name');
if (!/^\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/.test(version ?? '')) throw new Error(`Expected X.Y.Z or X.Y.Z-rc.N, got ${version}`);
if (digests.length !== 2 || !digests.every(digest => /^[0-9a-f]{64}$/.test(digest))) {
  throw new Error('Expected two platform digests');
}

const reference = `${image}:${version}`;
const index = ['--tag', reference,
  '--annotation', 'index:org.opencontainers.image.source=https://github.com/code19m/oneloop',
  '--annotation', 'index:org.opencontainers.image.description=Lightweight, self-hosted task management for small teams, in a single binary',
  '--annotation', 'index:org.opencontainers.image.licenses=MIT',
  '--annotation', `index:org.opencontainers.image.version=${version}`,
  ...digests.map(digest => `${image}@sha256:${digest}`)];

const published = inspectRaw(reference);
if (published === null) {
  const result = imagetools('create', ...index);
  if (result.status !== 0) throw new Error(`Cannot create ${reference}: ${result.stderr}`);
  process.stdout.write(result.stdout);
} else {
  // Compare the platform and attestation manifests, which identify the bits; the index
  // around them can differ in formatting between buildx versions.
  const planned = imagetools('create', '--dry-run', ...index);
  if (planned.status !== 0) throw new Error(`Cannot prepare ${reference}: ${planned.stderr}`);
  const manifests = index => JSON.stringify((JSON.parse(index).manifests ?? []).map(entry => entry.digest).sort());
  if (manifests(published) !== manifests(planned.stdout)) {
    throw new Error(`${reference} already exists with other images, and a published version never moves. `
      + 'Re-run only the failed jobs to retry with the same images, or release a new version.');
  }
  console.log(`${reference} already names these images`);
}
