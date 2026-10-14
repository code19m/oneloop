# Vendored browser libraries

The web client loads these libraries from oneloop itself, never from a CDN.
Each folder holds files copied from one exact npm release.

## The record

`vendor.json` is the record of every library: its npm tarball (`source`), the
tarball's SHA-512 `integrity`, and the SHA-256 of every file. Paths in `files`
are relative to the library's folder, and `src` is the file's path in the
tarball. `derived` lists the files that don't come from the tarball: the
Mermaid rebuild and its notices, and licenses taken from a fixed revision of an
upstream repository.

`node scripts/vendor-audit.mjs` generates the `package.json` and
`package-lock.json` in each folder from `vendor.json`, so that `npm audit` can
check the exact versions. Never install them. README and REBUILD files are our
own notes, not upstream files.

## Checks

From the repository root:

```sh
node scripts/vendor-verify.mjs          # download the tarballs and compare every file
node scripts/vendor-verify.mjs --local  # compare the files with vendor.json, offline
node scripts/vendor-audit.mjs --check   # the audit files match vendor.json
node scripts/markdown-preview-css.mjs --check
```

The checks never run package code or unpack a tarball into the working tree.
They need Node 22 and `tar`, and they remove their temporary files from
`target/`. CI runs the offline check. The Dependencies workflow downloads the
tarballs on pull requests, on pushes to `main` and every week. For the Mermaid
bundle, the checks compare only the local hash; [mermaid/REBUILD.md](mermaid/REBUILD.md)
explains how to rebuild it.

## Update a library

1. Download the exact new release from npm and check its integrity.
2. Copy only the files that the browser needs, and the license and notice
   files.
3. Update the library's entry in `vendor.json`. Never change a hash only to
   make a mismatch pass.
4. Review the changes to its license and its security advisories.
5. Run `node scripts/vendor-audit.mjs` and `node scripts/third-party-notices.mjs`.
6. Run the checks above and the tests that cover file previews.

## Markdown preview styles

`cdn-assets` is the npm package `@highlightjs/cdn-assets`, not a CDN. Its light
and dark CSS and the original github-markdown-css themes stay here as inputs
and are not embedded in oneloop. `scripts/markdown-preview-css.mjs` builds
`frontend/styles/markdown-preview.css` from them. It scopes each GitHub theme to
the matching app theme, removes the comments of the highlight themes and scopes
each highlight selector. Then it appends `scripts/markdown-preview-overrides.css`,
which owns the preview's layout, diagrams, math, alerts and containment. Run
the script without `--check` to rebuild the file byte for byte.
