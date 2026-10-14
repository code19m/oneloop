# Mermaid

`mermaid.min.js` is a rebuild of Mermaid from its source, with newer bundled
copies of DOMPurify, lodash-es and KaTeX that fix security advisories. It keeps
Mermaid's browser API, and the app loads it only when a page shows a diagram.
[REBUILD.md](REBUILD.md) records the source commit, the versions, the expected
hash and how to rebuild it.

Mermaid is MIT licensed; see `LICENSE`. The bundle also contains code under
other licenses. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) keeps their
full notices, including the EPL-2.0 source link for elkjs.
