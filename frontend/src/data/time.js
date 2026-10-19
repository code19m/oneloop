// @ts-check

/** Server times: Unix seconds from the API, and instants shown in the instance time zone. */

/** API instants are Unix seconds; legacy renderer instants are milliseconds.
 * @param {number|null|undefined} seconds
 */
export function secondsToMilliseconds(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

const UNSUPPORTED_ZONE = 'Your browser does not support the instance time zone. Times and Today are shown in UTC. Update your browser to use the configured zone.';
/** Zones the browser doesn't know, each said once. */
const warnedZones = new Set();
/** @type {string|undefined} */ let formatterZone;
/** @type {Intl.DateTimeFormat} */ let instantFormatter;
/** @type {Intl.DateTimeFormat} */ let shortFormatter;

/**
 * The formatters of `zone`, or of UTC when the browser doesn't know it; then
 * `warn` hears so, once per zone.
 * @param {string} zone @param {(message:string)=>void} warn
 */
function formatters(zone, warn) {
  if (formatterZone !== zone) {
    const build = (/** @type {string} */ timeZone) => [
      new Intl.DateTimeFormat('en-GB', {timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'}),
      new Intl.DateTimeFormat('en-US', {timeZone, month:'short', day:'numeric'}),
    ];
    try { [instantFormatter, shortFormatter] = build(zone); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      [instantFormatter, shortFormatter] = build('UTC');
      if (!warnedZones.has(zone)) { warnedZones.add(zone); setTimeout(() => warn(UNSUPPORTED_ZONE), 0); }
    }
    formatterZone = zone;
  }
  return { instantFormatter, shortFormatter };
}

/**
 * `value`, a time, as `YYYY-MM-DD HH:MM:SS` in `zone`, the instance time
 * zone, or 'Unavailable'.
 * @param {number|string|Date} value @param {string} zone @param {(message:string)=>void} warn
 */
export function formatInstant(value, zone, warn) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unavailable';
  const formatter = formatters(zone, warn).instantFormatter, key = `${zone}|${date.getTime()}`;
  let text = formatted.get(key);
  if (text === undefined) {
    const parts = Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    // The instance time zone applies everywhere, so the label would only add noise.
    text = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    if (formatted.size > 4000) formatted.clear();
    formatted.set(key, text);
  }
  return text;
}
/** Instants formatted already, by zone and time: the Roadmap formats thousands as it draws. */
const formatted = new Map();

/**
 * `value`, a time, as a short day in `zone`, such as Jan 5.
 * @param {number|string|Date} value @param {string} zone @param {(message:string)=>void} warn
 */
export function formatShortInstant(value, zone, warn) {
  return formatters(zone, warn).shortFormatter.format(new Date(value));
}
