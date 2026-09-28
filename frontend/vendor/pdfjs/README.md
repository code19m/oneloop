# PDF.js

Vendored from the official `pdfjs-dist` npm package, version **6.3.289**.
Distribution: the upstream **legacy** browser build, minified without local edits.
This preserves compatibility with browsers missing newly introduced Map methods.
Browser tests use Playwright's Chromium, Firefox and WebKit (see `e2e/package.json`);
that test matrix is not a minimum browser version.
Source: https://github.com/mozilla/pdf.js
Usage: https://mozilla.github.io/pdf.js/examples/
License: Apache-2.0; see LICENSE and the bundled font/character-map licenses.

Only the browser library, worker, standard fonts and packed character maps are
included. No external CDN or document URL is used. The viewer passes copied
upload bytes to a dedicated worker and renders page canvases without annotations,
XFA or document actions. Eval, WASM and system-font fallback are disabled. Keep
this dependency updated as part of the production security/maintenance process.

Reproduction: download `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz`
and verify `sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw==`.
Copy `legacy/build/pdf.min.mjs` to `pdf.mjs` and
`legacy/build/pdf.worker.min.mjs` to `pdf.worker.mjs`. Fonts, character maps,
version and licenses are unchanged. The compatibility code is supplied upstream;
oneloop does not patch browser globals or vendor internals itself.

Audit-only `package.json` and `package-lock.json` record the exact bundled versions.
Regenerate with `node scripts/vendor-audit.mjs`; do not install these inventories.
Source and local-byte integrity are checked by `node scripts/vendor-verify.mjs`.
