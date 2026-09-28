// Generate THIRD_PARTY_NOTICES.md from the locked Cargo graph and frontend/vendor; --check fails when it is stale.
// Uses only Node built-ins. cargo metadata may fill Cargo's package cache; no package code runs.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const destination = 'THIRD_PARTY_NOTICES.md';
const read = path => readFileSync(path, 'utf8');
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cargo = args => execFileSync('cargo', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Components by name@version; each keeps its license expression and the license texts that ship with it. */
const components = new Map();
function addComponent(name, version, license, texts, origin) {
  const key = `${name}@${version}`;
  if (!texts.length) throw new Error(`No license text found for ${key} (${origin}); review its exact upstream source first.`);
  const existing = components.get(key);
  if (existing) existing.texts.push(...texts);
  else components.set(key, { key, license, texts: [...texts] });
}
const noticeName = /^(licen[sc]e|copying|notice|copyright|unlicense)([._-]|$)/i;
function licenseFiles(directory, recursive = false) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => byText(a.name, b.name)).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && recursive) return licenseFiles(path, true);
    return entry.isFile() && noticeName.test(entry.name) ? [path] : [];
  });
}

// Rust crates: the union of normal and build dependencies for the supported build hosts.
const metadata = JSON.parse(cargo(['metadata', '--locked', '--format-version', '1']));
const included = new Set();
for (const target of ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu', 'aarch64-apple-darwin']) {
  const tree = cargo(['tree', '--locked', '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}', '--target', target]);
  for (const line of tree.split('\n')) {
    const match = line.match(/^(\S+) v(\S+)/);
    if (match) included.add(`${match[1]}@${match[2]}`);
  }
}
// The rmcp crates omit their workspace-root license. This copy comes from the published crates' VCS
// revision 9427a929959e665e0d12e9395f674026baf4bd48 of github.com/modelcontextprotocol/rust-sdk.
const crateOverrides = {
  'rmcp@3.4.1': ['scripts/licenses/rmcp-Apache-2.0.txt'],
  'rmcp-macros@3.4.1': ['scripts/licenses/rmcp-Apache-2.0.txt'],
};
let crateCount = 0;
for (const pkg of metadata.packages) {
  const key = `${pkg.name}@${pkg.version}`;
  if (!pkg.source || !included.has(key)) continue;
  const directory = dirname(pkg.manifest_path), files = licenseFiles(directory);
  if (pkg.license_file && !files.includes(join(directory, pkg.license_file))) files.push(join(directory, pkg.license_file));
  files.push(...(crateOverrides[key] ?? []));
  addComponent(pkg.name, pkg.version, pkg.license ?? 'see its license text', files.map(read), 'Rust crate');
  crateCount++;
}

// Browser libraries vendored in frontend/vendor, identified by their pinned npm tarballs. A new
// library must be added here after its license has been reviewed.
const browserLicenses = {
  'cdn-assets': 'BSD-3-Clause',
  dompurify: 'MPL-2.0 OR Apache-2.0',
  'github-markdown-css': 'MIT',
  'js-sha256': 'MIT',
  katex: 'MIT',
  marked: 'MIT',
  'marked-alert': 'MIT',
  'marked-footnote': 'MIT',
  'marked-katex-extension': 'MIT',
  mermaid: 'MIT',
  pdfjs: 'Apache-2.0; bundled fonts and CMaps under their own licenses',
};
const vendor = JSON.parse(read('frontend/vendor/vendor.json'));
for (const pkg of vendor.packages) {
  const [, name, version] = pkg.source.match(/^https:\/\/registry\.npmjs\.org\/(.+)\/-\/[^/]+-(\d[^/]*)\.tgz$/);
  const license = browserLicenses[pkg.directory];
  if (!license) throw new Error(`Review the license of frontend/vendor/${pkg.directory} and add it to browserLicenses.`);
  const files = licenseFiles(join('frontend/vendor', pkg.directory), true).filter(path => !path.endsWith('.json'));
  addComponent(name, version, license, files.map(read), 'frontend/vendor');
}

// Packages bundled into the rebuilt Mermaid, from its reviewed notice inventory.
const mermaidPreamble = [];
let mermaidCount = 0, entry = null, fence = null, block = [];
for (const line of read('frontend/vendor/mermaid/THIRD_PARTY_NOTICES.md').replace(/\r\n?/g, '\n').split('\n')) {
  if (fence) {
    if (line === fence) { entry.texts.push(block.join('\n')); fence = null; } else block.push(line);
  } else if (/^`{3,}text$/.test(line)) {
    if (!entry) throw new Error('Mermaid notice text before its package heading');
    fence = line.slice(0, -4); block = [];
  } else if (/^## \S+@\d\S*$/.test(line)) {
    if (entry) addComponent(entry.name, entry.version, entry.license, entry.texts, 'Mermaid bundle');
    const [, name, version] = line.match(/^## (\S+)@(\S+)$/);
    entry = { name, version, license: 'see its license text', texts: [] };
    mermaidCount++;
  } else if (entry) {
    entry.license = line.match(/^License: (.+)$/)?.[1] ?? entry.license;
  } else if (!line.startsWith('# ') && !line.startsWith('Original upstream notices follow')) {
    mermaidPreamble.push(line.replace(/^## /, '### ').replace('in the elkjs entry below', 'under License texts below'));
  }
}
if (fence || !entry) throw new Error('Unexpected structure in frontend/vendor/mermaid/THIRD_PARTY_NOTICES.md');
addComponent(entry.name, entry.version, entry.license, entry.texts, 'Mermaid bundle');

const kinds = [
  [/Apache License\s+Version 2\.0/i, 'Apache License 2.0'],
  [/Eclipse Public License - v 2\.0/i, 'Eclipse Public License 2.0'],
  [/Mozilla Public License,? v(?:ersion)?\.? 2\.0/i, 'Mozilla Public License 2.0'],
  [/Boost Software License/i, 'Boost Software License 1.0'],
  [/UNICODE LICENSE V3/i, 'Unicode License v3'],
  [/This is free and unencumbered software/i, 'The Unlicense'],
  [/SIL OPEN FONT LICENSE/i, 'SIL Open Font License 1.1'],
  [/Permission is hereby granted, free of charge/i, 'MIT License'],
  [/Redistribution and use in source and binary forms/i, 'BSD License'],
  [/Permission to use, copy, modify, and\/or distribute/i, 'ISC License'],
  [/This software is provided 'as-is'/i, 'zlib License'],
];
const kindOf = text => kinds.find(([pattern]) => pattern.test(text))?.[1] ?? 'Other license';
// Only these templates are split into copyright lines and shared terms; other texts stay whole.
const templates = new Set(['Apache License 2.0', 'Boost Software License 1.0', 'BSD License', 'ISC License', 'MIT License',
  'The Unlicense', 'Unicode License v3', 'zlib License']);

// Split each text into its copyright notices and the license terms, so a license shared by many
// components appears once, followed by each component's own copyright lines.
const copyrightLine = /^\s*(?:copyright\s*(?:\(c\)|©|\d{4})|\(c\)\s*\d{4}|©\s*\d{4})/i;
const titleLine = /^(?:the )?mit license(?: \(mit\))?:?$/i;
const apacheAppendix = /\n\s*APPENDIX: How to apply the Apache License to your work\.[\s\S]*limitations under the License\.$/;
const normalize = text => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd())
  .join('\n').replace(/^\n+|\n+$/g, '');
function split(original) {
  if (!templates.has(kindOf(original))) return { notices: [], text: original };
  const lines = original.split('\n');
  const notices = [], body = [];
  for (let i = 0; i < lines.length; i++) {
    if (!copyrightLine.test(lines[i]) || /[[{<]yyyy[\]}>]|<year>/i.test(lines[i])) { body.push(lines[i]); continue; }
    let notice = lines[i].trim();
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^\s*all rights reserved\.?$/i.test(lines[i + 1]))
      && !copyrightLine.test(lines[i + 1])) notice += ' ' + lines[++i].trim();
    notices.push(notice.replace(/\s+/g, ' '));
  }
  let text = body.join('\n').replace(/^\n+|\n+$/g, '');
  const first = text.split('\n', 1)[0].trim();
  if (titleLine.test(first)) text = text.slice(text.indexOf('\n') + 1 || text.length).replace(/^\n+/, '');
  if (/^\s*Apache License\s+Version 2\.0/.test(text)) text = text.replace(apacheAppendix, '');
  return { notices, text: text.replace(/\n{3,}/g, '\n\n') };
}

const groups = new Map();
for (const component of components.values()) {
  for (const original of component.texts.map(normalize)) {
    const { notices, text } = split(original), key = text.replace(/\s+/g, ' ').trim();
    if (!groups.has(key)) groups.set(key, { variants: new Map(), originals: new Set(), members: new Map() });
    const group = groups.get(key);
    group.variants.set(text, (group.variants.get(text) ?? 0) + 1);
    group.originals.add(original);
    const known = group.members.get(component.key) ?? [];
    group.members.set(component.key, [...new Set([...known, ...notices])]);
  }
}
const licenseTexts = [...groups.values()].filter(group => [...group.variants.keys()][0]).map(group => {
  // A text used by one component is reproduced as it ships. A shared text shows its most common
  // spelling (ties go to the first in sort order), and each component lists its copyright lines.
  if (group.members.size === 1 && group.originals.size === 1) {
    const [text] = group.originals, [[key]] = group.members;
    return { kind: kindOf(text), text, members: [[key, []]] };
  }
  const text = [...group.variants].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0][0];
  return { kind: kindOf(text), text, members: [...group.members].sort((a, b) => byText(a[0], b[0])) };
}).sort((a, b) => byText(a.kind, b.kind) || b.members.length - a.members.length || byText(a.members[0][0], b.members[0][0]));
// A text that was nothing but copyright lines still has to be reproduced.
const bareNotices = [...(groups.get('')?.members ?? [])].filter(([, notices]) => notices.length).sort((a, b) => byText(a[0], b[0]));

const fenced = text => {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`{3,}/g)].map(match => match[0].length + 1)));
  return `${fence}text\n${text}\n${fence}`;
};
const memberLine = ([key, notices]) => `- ${key}${notices.length ? `: ${notices.join('; ')}` : ''}`;
const sections = [`# Third-party notices

oneloop is released under the MIT license; see [LICENSE](LICENSE). The oneloop
binary and Docker image include the third-party components listed here. Each
component keeps its own license, and those licenses apply to that component,
not to oneloop as a whole. A running oneloop server serves this file at
\`/THIRD_PARTY_NOTICES.md\`.

This file is generated by \`node scripts/third-party-notices.mjs\`; do not edit
it by hand. It covers ${components.size} components:

- ${crateCount} Rust crates: the normal and build dependencies in \`Cargo.lock\` for
  Linux x86_64, Linux arm64 and macOS arm64. Build-only crates are included
  conservatively.
- ${vendor.packages.length} browser libraries vendored in \`frontend/vendor/\`.
- ${mermaidCount} packages bundled into the rebuilt Mermaid.

Each license text appears once, followed by the components it covers and their
copyright lines. Texts that differ only in whitespace, a leading "MIT License"
title or the Apache License's "How to apply" appendix are shown once. A
component with an "OR" license expression may be used under either license.`,
`## Mermaid bundle
${mermaidPreamble.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}`,
`## Components

| Component | License |
| --- | --- |
${[...components.values()].sort((a, b) => byText(a.key, b.key)).map(c => `| ${c.key} | ${c.license} |`).join('\n')}`,
'## License texts',
...licenseTexts.map((group, index) => `### ${index + 1}. ${group.kind}

${group.members.map(memberLine).join('\n')}

${fenced(group.text)}`),
];
if (bareNotices.length) sections.push(`## Copyright notices without license terms

These files contain only copyright lines; the license terms are listed above.

${bareNotices.map(memberLine).join('\n')}`);
const output = sections.join('\n\n') + '\n';

if (process.argv.includes('--check')) {
  let existing = '';
  try { existing = read(destination); } catch {}
  if (existing !== output) {
    console.error(`${destination} is stale. Run node scripts/third-party-notices.mjs and review the changes.`);
    process.exit(1);
  }
} else writeFileSync(destination, output);
console.log(`${process.argv.includes('--check') ? 'Verified' : 'Wrote'} ${destination}: ${components.size} components, `
  + `${licenseTexts.length} license texts, ${Math.round(Buffer.byteLength(output) / 1024)} KiB.`);
