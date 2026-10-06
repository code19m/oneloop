// Print true when the GitHub release for a tag exists and false when it doesn't. Any other
// gh failure stops the script, so an outage is never taken for a missing release.
// Usage: node scripts/release-exists.mjs vX.Y.Z
// gh needs GH_TOKEN, and GH_REPO outside a clone of the repository.
import {spawnSync} from 'node:child_process';

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/.test(tag ?? '')) throw new Error(`Expected vX.Y.Z or vX.Y.Z-rc.N, got ${tag}`);

const result = spawnSync('gh', ['release', 'view', tag, '--json', 'tagName'], {encoding: 'utf8'});
if (result.error) throw result.error;
if (result.status !== 0 && result.stderr.trim() !== 'release not found') {
  throw new Error(`Cannot look up the ${tag} release: ${result.stderr.trim()}`);
}
console.log(result.status === 0);
