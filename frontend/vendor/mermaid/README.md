# Mermaid 12.0.0

The source release is
[`mermaid@12.0.0`](https://registry.npmjs.org/mermaid/-/mermaid-12.0.0.tgz),
whose official npm tarball integrity is
`sha512-/wQXC9iBxoGV8p3erbvaXs9h77VyLDBH6GdayVjj3hEcSQhFU4N1WUhUppotCEqlIxI2pRMwjwBSwTB1MfZBgQ==`.

`mermaid.min.js` is a reproducible security rebuild of the official source tag
`mermaid@12.0.0` at commit
`98a0945418c76238f15df2afaddbba4272656c3b`, retaining Mermaid 12's public
browser API while pinning its bundled DOMPurify to **3.4.16**, lodash-es to **4.18.1** and
KaTeX to **0.18.9**. The output SHA-256 is
`424994cafb13de86c186fa48354720061f610e3812b9f6ba6231b302a8375957`.
Mermaid itself is MIT licensed (see LICENSE). The bundle also contains code
under other licenses; [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) retains
their full notices, including EPL-2.0 source availability for elkjs. Rebuild steps and the exact overrides are in
[REBUILD.md](REBUILD.md).

Lazy-loaded locally; no runtime CDN dependency.

Audit-only `package.json` and `package-lock.json` record the exact bundled versions.
Regenerate with `node scripts/vendor-audit.mjs`; do not install these inventories.
Source and local-byte integrity are checked by `node scripts/vendor-verify.mjs`.
