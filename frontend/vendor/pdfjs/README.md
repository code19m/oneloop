# PDF.js

These files are the upstream **legacy** browser build from the `pdfjs-dist`
npm package, minified and unchanged: `legacy/build/pdf.min.mjs` as `pdf.mjs`
and `legacy/build/pdf.worker.min.mjs` as `pdf.worker.mjs`, with the standard
fonts and the packed character maps. The legacy build also works in browsers
that lack recently added `Map` methods. oneloop doesn't patch browser globals
or PDF.js itself. The browser tests use Playwright's Chromium, Firefox and
WebKit (see `e2e/package.json`); they don't set a minimum browser version.

PDF.js is Apache-2.0 licensed; see `LICENSE`. The fonts and character maps
have their own licenses.

The viewer passes a copy of the uploaded bytes to a dedicated worker and draws
pages on canvases, without annotations, XFA forms or document actions. Eval,
WebAssembly and system fonts are off, and no CDN or document URL is used. Keep
PDF.js up to date, because it reads untrusted files.

Source: <https://github.com/mozilla/pdf.js>.
Usage: <https://mozilla.github.io/pdf.js/examples/>.
