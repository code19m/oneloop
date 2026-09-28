// Validate a release tag against Cargo.toml and CHANGELOG.md, then write the release notes and image tags.
//
// Usage: node scripts/release-metadata.mjs vX.Y.Z[-rc.N]
// Writes target/release-notes.md and, on GitHub Actions, the version, prerelease and tags outputs.
import {readFileSync, appendFileSync, writeFileSync, mkdirSync} from 'node:fs';

const image = 'ghcr.io/code19m/oneloop';
const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/.test(tag ?? '')) throw new Error('Expected vX.Y.Z or vX.Y.Z-rc.N');

const version = tag.slice(1);
const cargoVersion = readFileSync('Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (version !== cargoVersion) throw new Error(`Tag ${tag} does not match Cargo.toml ${cargoVersion}`);

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const section = changelog.split(/^## /m).find(part => part.startsWith(`[${version}]`));
if (!section) throw new Error(`Add a dated [${version}] CHANGELOG.md section before tagging`);
const notes = section.slice(section.indexOf('\n') + 1).trim();
if (!notes) throw new Error('Release notes are empty');
mkdirSync('target', {recursive: true});
writeFileSync('target/release-notes.md', notes + '\n');

// Release candidates get only their own tag and never move X.Y or latest.
const prerelease = version.includes('-rc.');
const tags = [`${image}:${version}`];
if (!prerelease) tags.push(`${image}:${version.split('.').slice(0, 2).join('.')}`, `${image}:latest`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprerelease=${prerelease}\ntags<<TAGS\n${tags.join('\n')}\nTAGS\n`);
}
console.log(JSON.stringify({version, prerelease, tags}));
