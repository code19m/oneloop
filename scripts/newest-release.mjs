// Print the tag of the newest published release: the highest version, release candidates
// included. The Docs workflow builds the documentation site from this tag. Any gh failure
// stops the script. Usage: node scripts/newest-release.mjs
// gh needs GH_TOKEN, and GH_REPO outside a clone of the repository.
import {spawnSync} from 'node:child_process';

const result = spawnSync('gh', ['release', 'list', '--exclude-drafts', '--limit', '1000', '--json', 'tagName'], {encoding: 'utf8'});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Cannot list the releases: ${result.stderr.trim()}`);

/** The parts of a release tag in sort order, or null for other tags. A final release follows its candidates. */
function version(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.([1-9]\d*))?$/.exec(tag);
  if (!match) return null;
  const [, major, minor, patch, candidate] = match;
  return [BigInt(major), BigInt(minor), BigInt(patch), candidate ? 0n : 1n, BigInt(candidate ?? 0)];
}
function newer(parts, than) {
  const difference = parts.findIndex((part, i) => part !== than[i]);
  return difference !== -1 && parts[difference] > than[difference];
}

let newest = null;
for (const {tagName} of JSON.parse(result.stdout)) {
  const parts = version(tagName);
  if (parts && (!newest || newer(parts, newest.parts))) newest = {tagName, parts};
}
if (!newest) throw new Error('No published release has a vX.Y.Z or vX.Y.Z-rc.N tag');
console.log(newest.tagName);
