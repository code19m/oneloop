// Write audit-only npm manifests for the exact vendored versions, so that npm audit can check
// them; --check fails when one is stale. They are never an install or build input.
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {vendorPackages} from './vendor-packages.mjs';

const vendor = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'frontend/vendor');
const check = process.argv.includes('--check');
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// The Mermaid bundle also contains the packages of its reviewed notice inventory.
const mermaidPackages = JSON.parse(readFileSync(join(vendor, 'mermaid/notice-inventory.json'), 'utf8'));

for (const pkg of vendorPackages()) {
  const rows = new Map(pkg.directory === 'mermaid' ? mermaidPackages.map(row => [row.package, row]) : []);
  const key = `${pkg.name}@${pkg.version}`;
  rows.set(key, {package: key, source: pkg.source, integrity: pkg.integrity});
  const dependencies = {}, packages = {};
  for (const [i, row] of [...rows.values()].sort((a, b) => byText(a.package, b.package)).entries()) {
    const split = row.package.lastIndexOf('@'), name = row.package.slice(0, split), version = row.package.slice(split + 1);
    // An alias for each version keeps several versions of one package apart without resolving ranges.
    const alias = `bundled-${i}`;
    dependencies[alias] = `npm:${name}@${version}`;
    packages[`node_modules/${alias}`] = {name, version, resolved: row.source, integrity: row.integrity};
  }
  const manifest = {
    name: 'oneloop-vendor-audit', version: '0.0.0', private: true,
    description: 'Generated audit-only inventory; do not install or independently update', dependencies,
  };
  const lock = {name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: {'': manifest, ...packages}};
  for (const [file, value] of [['package.json', manifest], ['package-lock.json', lock]]) {
    const path = join(vendor, pkg.directory, file), text = JSON.stringify(value, null, 2) + '\n';
    if (!check) writeFileSync(path, text);
    else if (readFileSync(path, 'utf8') !== text) throw new Error(`Stale ${path}; run node scripts/vendor-audit.mjs`);
  }
  console.log(`${pkg.directory}: ${rows.size} exact package versions`);
}
