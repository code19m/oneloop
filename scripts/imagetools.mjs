// Registry access for the release scripts, through docker buildx imagetools.
import {spawnSync} from 'node:child_process';

export function imagetools(...args) {
  const result = spawnSync('docker', ['buildx', 'imagetools', ...args], {encoding: 'utf8'});
  if (result.error) throw result.error;
  return result;
}

/** The raw manifest that a reference names, or null when the registry has no such tag. */
export function inspectRaw(reference) {
  const result = imagetools('inspect', '--raw', reference);
  if (result.status === 0) return result.stdout;
  // Only an absent manifest means unpublished. Auth/network failures must not
  // be mistaken for a tag that is safe to create or overwrite.
  if (result.stderr.trim().endsWith(`${reference}: not found`)
      || /\bMANIFEST_UNKNOWN\b|\bmanifest unknown\b/.test(result.stderr)) return null;
  throw new Error(`Cannot inspect ${reference}: ${result.stderr}`);
}
