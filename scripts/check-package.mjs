// Check that the crate package contains only build inputs and license notices; pass --allow-dirty for a dirty tree.
import {execFileSync} from 'node:child_process';

const args = ['package', '--locked', '--list'];
if (process.argv.includes('--allow-dirty')) args.push('--allow-dirty');
const files = execFileSync('cargo', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']}).trim().split('\n');

const rootFiles = new Set(['.cargo_vcs_info.json', 'Cargo.toml', 'Cargo.toml.orig', 'Cargo.lock', 'build.rs', 'README.md',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'frontend/index.html']);
const prefixes = ['src/', 'migrations/', 'frontend/src/', 'frontend/views/', 'frontend/styles/', 'frontend/icons/', 'frontend/vendor/'];
const excluded = [
  /(^|\/)tests\.rs$/,
  /^frontend\/vendor\/.*\.(?:md|json)$/,
  /^frontend\/vendor\/katex\/fonts\/.*\.(?:ttf|woff)$/,
  /^frontend\/vendor\/(?:github-markdown-css|cdn-assets)\/.*\.css$/,
  /node_modules\//,
  /\.DS_Store$/,
];
for (const file of files) {
  const expected = rootFiles.has(file) || prefixes.some(prefix => file.startsWith(prefix));
  if (!expected || excluded.some(pattern => pattern.test(file))) throw new Error(`Unexpected crate file: ${file}`);
}
for (const required of ['src/main.rs', 'build.rs', 'Cargo.lock', 'THIRD_PARTY_NOTICES.md', 'frontend/index.html',
  'frontend/vendor/pdfjs/LICENSE']) {
  if (!files.includes(required)) throw new Error(`Missing crate file: ${required}`);
}
console.log(`Verified ${files.length} package paths: only build inputs and license notices.`);
