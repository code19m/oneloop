# Mermaid vendor rebuild

This tree deliberately ships the Mermaid 12.0.0 browser API with a patched
bundled DOMPurify and lodash-es. The published Mermaid tarball embeds DOMPurify 3.4.12; do not
edit minified code to change it.

The checked-in `mermaid.min.js` was built from the official
[`mermaid@12.0.0` Git tag](https://github.com/mermaid-js/mermaid/tree/mermaid%4012.0.0),
commit `98a0945418c76238f15df2afaddbba4272656c3b`, using Node 22.23.2 and
pnpm 10.30.3. It has SHA-256
`ff2944c72867afbd2048b72cc87f5c58fa66eeeb8bc5ca24b10a2077a6b87984`.

To reproduce in a disposable directory:

Download the [source archive](https://github.com/mermaid-js/mermaid/archive/98a0945418c76238f15df2afaddbba4272656c3b.tar.gz)
and extract it into a disposable directory. Set `pnpm.overrides.dompurify` to
`3.4.16` and `pnpm.overrides.lodash-es` to `4.18.1` in its root `package.json`.
Copy the [reviewed lockfile](../../../scripts/vendor/mermaid/pnpm-lock.yaml) into
the source root, then run there with Node 22.23.2 on PATH:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm build:mermaid
shasum -a 256 packages/mermaid/dist/mermaid.min.js
```

The expected built output contains `DOMPurify 3.4.16` and the SHA-256 above.
Copy `packages/mermaid/dist/mermaid.min.js` and retain the Mermaid license
and dependency notices, then run the Markdown/Mermaid preview tests. When changing
versions, obtain the source tag and release integrity from the Mermaid project,
review advisories for Mermaid and every bundled dependency, and update this
record before committing.

## Dependency notices

Before replacing the bundle, run `corepack pnpm licenses list --prod --long` in
that source checkout. Inspect the generated source map too: generated parser code
can include dependencies declared as development dependencies (notably Langium).
Retain the pinned source lockfile and both dependency overrides when resolving versions.

`notice-inventory.json` records the conservative source-lock production closure,
parser runtime dependencies, archive URLs and verified npm integrity hashes for
the current bundle. `THIRD_PARTY_NOTICES.md` includes complete upstream LICENSE,
NOTICE and copyright files, including nested notices. Keep elkjs's versioned
source link and full EPL-2.0 text. The inventory includes some type/build packages
that may be eliminated from the output; it does not claim each package executes
in the browser. Review changes against the rebuilt source map before distribution.

Regenerate the distribution copy with `node scripts/third-party-notices.mjs`.
Do not replace the bundle without updating and reviewing its inventory/notices.

The integration rebuild fixes the [lodash template advisory](https://github.com/advisories/GHSA-r5fr-rjxr-66jc)
and [array-path advisory](https://github.com/advisories/GHSA-f23m-r3pf-42rh) by replacing
the actual bundled dependency. The generated `mermaid.min.js.map` contains only
`lodash-es@4.18.1` and `dompurify@3.4.16` paths for those libraries. The conservative
production/parser closure changes only those dependencies. No audit suppression
or manual minified-code patch is used.
