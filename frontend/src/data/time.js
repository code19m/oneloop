// @ts-check

/** API instants are Unix seconds; legacy renderer instants are milliseconds.
 * @param {number|null|undefined} seconds
 */
export function secondsToMilliseconds(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
