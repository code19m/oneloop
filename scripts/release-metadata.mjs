// Validate a release tag against Cargo.toml and CHANGELOG.md, then write the release notes.
//
// Usage: node scripts/release-metadata.mjs vX.Y.Z[-rc.N]
// Writes target/release-notes.md and, on GitHub Actions, the version and prerelease outputs.
import {readFileSync, appendFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';

const {parse} = createRequire(import.meta.url)('../frontend/vendor/marked/marked.js');

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/.test(tag ?? '')) throw new Error('Expected vX.Y.Z or vX.Y.Z-rc.N');

const version = tag.slice(1);
const cargoVersion = readFileSync('Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (version !== cargoVersion) throw new Error(`Tag ${tag} does not match Cargo.toml ${cargoVersion}`);

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const section = changelog.split(/^## /m).find(part => part.startsWith(`[${version}]`));
if (!section) throw new Error(`Add a dated [${version}] CHANGELOG.md section before tagging`);
const notes = section.slice(section.indexOf('\n') + 1).trim();
// Link reference definitions and HTML comments do not render visible notes.
if (!parse(notes).replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim()) throw new Error('Release notes are empty');
mkdirSync('target', {recursive: true});
writeFileSync('target/release-notes.md', notes + '\n');

const prerelease = version.includes('-rc.');

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprerelease=${prerelease}\n`);
}
console.log(JSON.stringify({version, prerelease}));
