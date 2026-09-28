# Vendored browser assets

`vendor.json` records each immutable npm tarball, its SHA-512 integrity and the
source member and SHA-256 for every copied file. Paths in `files` are relative
to that package's local directory; `src` is the full tar member name. `derived`
records cover the Mermaid security rebuild/notices and licenses fetched from an
immutable upstream repository revision. Package README/REBUILD files are local
instructions, not copied upstream assets.

From the repository root:

```sh
node scripts/vendor-verify.mjs          # download, verify archives and compare bytes
node scripts/vendor-verify.mjs --local  # check inventory and local hashes offline
node scripts/markdown-preview-css.mjs --check
```

Verification never runs package code or extracts archive paths into the working
tree. It needs Node 22 and `tar`; scratch archives are removed from `target/` on
exit. CI checks local hashes and the weekly Dependencies workflow also compares
upstream archives. The Mermaid bundle's local hash is checked; rebuilding it is
separate and follows [its rebuild record](mermaid/REBUILD.md).

For an update, fetch the exact new package and verify its registry integrity,
copy only required browser assets and notices, then update the package README
and manifest source mappings/hashes. Review license/advisory changes and run
verification plus preview regression tests. Do not silently refresh manifest
hashes merely to accept a mismatch. Regenerate the distribution notices and
vendor audit inventory using the scripts in `scripts/`.

`cdn-assets` is the upstream package name `@highlightjs/cdn-assets`, not a runtime
CDN. Its light/dark CSS and the original github-markdown-css themes remain here
as reproducible inputs; they are excluded from the embedded server and crate.
`scripts/markdown-preview-css.mjs` scopes each GitHub theme to the corresponding
app theme, strips highlight theme comments and scopes each highlight selector,
then appends `scripts/markdown-preview-overrides.css`. The latter owns the app's
preview layout, diagrams, math, alerts and containment. Running that script
without `--check` rebuilds `frontend/styles/markdown-preview.css` byte-for-byte.
