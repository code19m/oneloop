// Release versions for the release scripts: X.Y.Z, or X.Y.Z-rc.N for a release
// candidate, with no leading zeros. Tags add a leading v.

/** The version, whether it is a release candidate, and its parts in sort order; null for anything else. */
export function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/.exec(version ?? '');
  if (!match) return null;
  const [, major, minor, patch, candidate] = match;
  // A final release sorts after its candidates.
  const parts = [BigInt(major), BigInt(minor), BigInt(patch), candidate ? 0n : 1n, BigInt(candidate ?? 0)];
  return {version, prerelease: candidate !== undefined, parts};
}

/** parseVersion for a vX.Y.Z or vX.Y.Z-rc.N tag. */
export function parseTag(tag) {
  return tag?.startsWith('v') ? parseVersion(tag.slice(1)) : null;
}

/** A negative number, zero or a positive number when parsed version a is lower than, equal to or higher than b. */
export function compareVersions(a, b) {
  const index = a.parts.findIndex((part, i) => part !== b.parts[i]);
  return index === -1 ? 0 : a.parts[index] < b.parts[index] ? -1 : 1;
}
