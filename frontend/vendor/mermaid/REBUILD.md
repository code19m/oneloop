# Mermaid vendor rebuild

This tree deliberately ships the Mermaid 12.0.0 browser API with a patched
bundled DOMPurify, lodash-es and KaTeX. The published Mermaid tarball embeds DOMPurify 3.4.12
and KaTeX 0.16.47; do not edit minified code to change them.

The checked-in `mermaid.min.js` was built from the official
[`mermaid@12.0.0` Git tag](https://github.com/mermaid-js/mermaid/tree/mermaid%4012.0.0),
commit `98a0945418c76238f15df2afaddbba4272656c3b`, using Node 22.23.2 and
pnpm 10.30.3. It has SHA-256
`424994cafb13de86c186fa48354720061f610e3812b9f6ba6231b302a8375957`.

To reproduce in a disposable directory:

Download the [source archive](https://github.com/mermaid-js/mermaid/archive/98a0945418c76238f15df2afaddbba4272656c3b.tar.gz)
and extract it into a disposable directory. Set `pnpm.overrides.dompurify` to
`3.4.16`, `pnpm.overrides.lodash-es` to `4.18.1` and `pnpm.overrides.katex` to
`0.18.9` in its root `package.json`.
Copy the [reviewed lockfile](../../../scripts/vendor/mermaid/pnpm-lock.yaml) into
the source root, then run there with Node 22.23.2 on PATH:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm build:mermaid
shasum -a 256 packages/mermaid/dist/mermaid.min.js
```

The expected built output contains `DOMPurify 3.4.16`, KaTeX's version string
`"0.18.9"` and the SHA-256 above.
Copy `packages/mermaid/dist/mermaid.min.js` and retain the Mermaid license
and dependency notices, then run the Markdown/Mermaid preview tests. When changing
versions, obtain the source tag and release integrity from the Mermaid project,
review advisories for Mermaid and every bundled dependency, and update this
record before committing.

To change an override, set it in `package.json` as above, copy in the reviewed
lockfile and run `corepack pnpm install --lockfile-only --ignore-scripts`. Check
that the lockfile diff changes only the overridden packages and their own
dependencies, then copy the lockfile back to `scripts/vendor/mermaid/`.

Mermaid 12.0.0 asks for KaTeX `^0.16.47`; the override moves it to 0.18.9, the
version in `frontend/vendor/katex`. Mermaid only calls `katex.renderToString`
with `throwOnError`, `displayMode` and `output` (`mathml`, or `htmlAndMathml` for
`legacyMathML`), and its styles target only the `katex` class. The breaking
changes in KaTeX 0.17 and 0.18 are in parts Mermaid doesn't use: the internal
`__defineFunction` API and the names of internal HTML classes, such as `base`
to `katex-base`. Those names matter only to a page that loads KaTeX's
stylesheet for `legacyMathML`, which oneloop doesn't use. The MathML that
Mermaid shows keeps the same structure.

## Dependency notices

Before replacing the bundle, run `corepack pnpm licenses list --prod --long` in
that source checkout. Inspect the generated source map too: generated parser code
can include dependencies declared as development dependencies (notably Langium).
Retain the pinned source lockfile and all three dependency overrides when resolving versions.

`notice-inventory.json` records the conservative source-lock production closure,
parser runtime dependencies, archive URLs and verified npm integrity hashes for
the current bundle. `THIRD_PARTY_NOTICES.md` includes complete upstream LICENSE,
NOTICE and copyright files, including nested notices. Keep elkjs's versioned
source link and full EPL-2.0 text. The inventory includes some type/build packages
that may be eliminated from the output; it does not claim each package executes
in the browser. Review changes against the rebuilt source map before distribution.

Regenerate the distribution copy with `node scripts/third-party-notices.mjs`.
Do not replace the bundle without updating and reviewing its inventory/notices.

The integration rebuild fixes the [lodash template advisory](https://github.com/advisories/GHSA-r5fr-rjxr-66jc),
the [array-path advisory](https://github.com/advisories/GHSA-f23m-r3pf-42rh) and the
[KaTeX trust advisory](https://github.com/advisories/GHSA-238p-pmpm-9mq7) by replacing
the actual bundled dependency. The generated `mermaid.min.js.map` contains only
`lodash-es@4.18.1`, `dompurify@3.4.16` and `katex@0.18.9` paths for those libraries. The
conservative production/parser closure changes only those dependencies and KaTeX's
command-line dependency, commander 15.0.0 instead of 8.3.0, which is not in the bundle.
No audit suppression or manual minified-code patch is used.
