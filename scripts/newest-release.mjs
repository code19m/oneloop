// Print the tag of the newest published release: the highest version, release candidates
// included. The Docs workflow builds the documentation site from this tag. Any gh failure
// stops the script. Usage: node scripts/newest-release.mjs
// gh needs GH_TOKEN, and GH_REPO outside a clone of the repository.
import {spawnSync} from 'node:child_process';
import {compareVersions, parseTag} from './release-version.mjs';

const result = spawnSync('gh', ['release', 'list', '--exclude-drafts', '--limit', '1000', '--json', 'tagName'], {encoding: 'utf8'});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Cannot list the releases: ${result.stderr.trim()}`);

const releases = JSON.parse(result.stdout).map(({tagName}) => parseTag(tagName)).filter(Boolean);
const newest = releases.sort(compareVersions).at(-1);
if (!newest) throw new Error('No published release has a vX.Y.Z or vX.Y.Z-rc.N tag');
console.log(`v${newest.version}`);
