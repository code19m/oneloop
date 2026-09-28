// @ts-check

const REQUIRED_PARAMETERS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'resource',
];
const OPTIONAL_PARAMETERS = new Set(['scope', 'state']);

/**
 * Accept only the internal OAuth authorization route produced by the server.
 * The nested client redirect_uri remains data for that route; it is never used
 * as the browser destination here.
 * @param {{search:string,origin:string}} location
 * @returns {string|null}
 */
export function authorizationReturnTarget(location) {
  const outer = new URLSearchParams(location.search);
  const values = outer.getAll('oauth_return');
  if (values.length !== 1 || [...outer.keys()].some((key) => key !== 'oauth_return')) return null;
  const raw = values[0];
  if (!raw.startsWith('/oauth/authorize?')) return null;

  let target;
  try { target = new URL(raw, location.origin); }
  catch { return null; }
  if (target.origin !== location.origin || target.username || target.password || target.pathname !== '/oauth/authorize' || target.hash) return null;

  const allowed = new Set([...REQUIRED_PARAMETERS, ...OPTIONAL_PARAMETERS]);
  for (const key of target.searchParams.keys()) {
    if (!allowed.has(key) || target.searchParams.getAll(key).length !== 1) return null;
  }
  if (REQUIRED_PARAMETERS.some((key) => target.searchParams.getAll(key).length !== 1 || !target.searchParams.get(key))) return null;
  return `${target.pathname}${target.search}`;
}
