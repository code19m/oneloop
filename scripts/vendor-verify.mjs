// Verify vendored browser files byte for byte against their pinned npm archives; --local checks local hashes only.
// No package code runs and no archive path is extracted.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile, mkdir, mkdtemp, rm, readdir} from 'node:fs/promises';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'frontend/vendor');
const manifest = JSON.parse(await readFile(join(vendor, 'vendor.json'), 'utf8'));
assert.deepEqual(manifest.packages.map(pkg => pkg.directory).sort(),
  (await readdir(vendor, {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(),
  'Unmapped or missing vendor package');
const localOnly = process.argv.includes('--local');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = value => typeof value === 'string' && value.split('/').every(part => /^[\w.@+-]+$/.test(part) && part !== '.' && part !== '..');
async function download(url) {
  assert.equal(new URL(url).protocol, 'https:');
  const response = await fetch(url, {signal: AbortSignal.timeout(60_000)});
  assert(response.ok, `${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
await mkdir(join(root, 'target'), {recursive: true});
const scratch = await mkdtemp(join(root, 'target/vendor-verify-'));
try {
  for (const pkg of manifest.packages) {
    assert(safePath(pkg.directory));
    const base = join(vendor, pkg.directory);
    const records = {...pkg.files, ...pkg.derived};
    const assets = (await readdir(base, {recursive: true, withFileTypes: true}))
      .filter(entry => entry.isFile() && !['README.md', 'REBUILD.md', 'package.json', 'package-lock.json', 'AUDIT.md'].includes(entry.name))
      .map(entry => join(entry.parentPath, entry.name).slice(base.length + 1)).sort();
    assert.deepEqual(Object.keys(records).sort(), assets, `${pkg.directory}: unmapped or missing files`);
    let archive;
    if (!localOnly) {
      const bytes = await download(pkg.source);
      assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, pkg.integrity, `${pkg.directory}: archive integrity`);
      archive = join(scratch, `${pkg.directory}.tar`);
      await writeFile(archive, gunzipSync(bytes));
    }
    for (const [dest, record] of Object.entries(records)) {
      assert(safePath(dest), `Unsafe destination: ${dest}`);
      const local = await readFile(join(base, dest));
      assert.equal(sha256(local), record.sha256, `${pkg.directory}/${dest}: local hash`);
      if (record.src && archive) {
        assert(safePath(record.src), `Unsafe archive member: ${record.src}`);
        const upstream = execFileSync('tar', ['-xOf', archive, record.src], {maxBuffer: 100 * 1024 * 1024});
        assert.equal(sha256(upstream), record.sha256, `${pkg.directory}/${dest}: upstream hash`);
      } else if (record.source && !localOnly) {
        assert.equal(sha256(await download(record.source)), record.sha256, `${pkg.directory}/${dest}: source hash`);
      } else if (!record.src) {
        assert(record.recipe, `${pkg.directory}/${dest}: missing derivation record`);
      }
    }
    console.log(`${pkg.directory}: ${assets.length} files verified${localOnly ? ' (local)' : ''}`);
  }
} finally {
  await rm(scratch, {recursive: true, force: true});
}
