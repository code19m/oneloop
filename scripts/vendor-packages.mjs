// The browser libraries that frontend/vendor/vendor.json records, each with the npm name
// and version of its tarball.
import {readFileSync} from 'node:fs';

export function vendorPackages() {
  const manifest = JSON.parse(readFileSync(new URL('../frontend/vendor/vendor.json', import.meta.url), 'utf8'));
  return manifest.packages.map(pkg => {
    const match = /^https:\/\/registry\.npmjs\.org\/(.+)\/-\/[^/]+-(\d[^/]*)\.tgz$/.exec(pkg.source);
    if (!match) throw new Error(`frontend/vendor/${pkg.directory}: the source is not an npm tarball`);
    return {...pkg, name: match[1], version: match[2]};
  });
}
