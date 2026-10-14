// Checks the copies of the release version and of the Rust version against their
// sources, Cargo.toml and rust-toolchain.toml. When one of those changes, this test
// lists every other place to update.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** Checks that each match of each pattern in `files` names `expected`, and that `required` files have one. */
function check(files, patterns, expected, required = files) {
  const found = files.flatMap(file => read(file).split('\n').flatMap((line, index) => patterns.flatMap(pattern =>
    [...line.matchAll(pattern)].map(match => ({file, place: `${file}:${index + 1}`, value: match[1]})))));
  const missing = required.filter(file => !found.some(match => match.file === file));
  assert.deepEqual(missing, [], 'Files without the version; did the pattern go stale?');
  const other = found.filter(match => match.value !== expected).map(match => `${match.place}: ${match.value}`);
  assert.deepEqual(other, [], `Expected ${expected}`);
}

test('the install and upgrade steps name the version in Cargo.toml', () => {
  const release = read('Cargo.toml').match(/^version = "(.+)"/m)[1];
  const pages = readdirSync(new URL('../../docs/src/', import.meta.url)).filter(name => name.endsWith('.md'));
  const version = String.raw`(\d+\.\d+\.\d+(?:-rc\.\d+)?)`;
  check(['README.md', 'deploy/compose.yaml', ...pages.map(name => `docs/src/${name}`)], [
    String.raw`ghcr\.io/code19m/oneloop:${version}`,
    String.raw`--tag v${version}`,
    String.raw`github(?:usercontent)?\.com/code19m/oneloop/(?:blob/|tree/)?v${version}/`,
    String.raw`"version":"${version}"`,
  ].map(source => new RegExp(source, 'g')), release, ['README.md', 'deploy/compose.yaml', 'docs/src/install.md']);
});

test('the Docker image, the dependency audit and the docs use the Rust in rust-toolchain.toml', () => {
  const channel = read('rust-toolchain.toml').match(/^channel = "(.+)"/m)[1];
  check(['Dockerfile', '.github/workflows/dependencies.yml'], [/^FROM rust:([^\s-]+)-/g, /rust-version: (\S+)/g], channel);
  // Older compilers refuse to build; the toolchain is also the minimum supported version.
  const minimum = channel.split('.').slice(0, 2).join('.');
  check(['Cargo.toml', 'docs/src/install.md'], [/^rust-version = "(.+)"/g, /Rust (\S+) or newer/g], minimum);
});
