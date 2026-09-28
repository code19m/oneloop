// @ts-check

/**
 * Session metadata is useful for recognition, not fingerprinting. Keep browser
 * labels short and stable instead of exposing a full user-agent string.
 * @param {unknown} value
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {string} value */
function looksLikeUserAgent(value) {
  return /\b(mozilla\/|applewebkit\/|chrome\/|safari\/|firefox\/|edg\/|opr\/|android\b|windows nt|macintosh\b)/i.test(value)
    || /(?:^|\s)[a-z][a-z0-9._-]*\/\d/i.test(value);
}

/** @param {string} userAgent */
export function userAgentLabel(userAgent) {
  const value=text(userAgent);
  if (!value) return 'Browser';
  const browser=/\bEdg(?:A|iOS)?\//i.test(value) ? 'Edge'
    : /\bOPR\//i.test(value) || /\bOpera\b/i.test(value) ? 'Opera'
    : /\bSamsungBrowser\//i.test(value) ? 'Samsung Internet'
    : /\bFirefox\//i.test(value) || /\bFxiOS\//i.test(value) ? 'Firefox'
    : /\bCriOS\//i.test(value) || /\bChrome\//i.test(value) ? 'Chrome'
    : /\bVersion\//i.test(value) && /\bSafari\//i.test(value) ? 'Safari'
    : 'Browser';
  const platform=/\b(iPhone|iPad|iPod)\b/i.test(value) ? 'iOS'
    : /\bAndroid\b/i.test(value) ? 'Android'
    : /\bWindows NT\b/i.test(value) ? 'Windows'
    : /\bCrOS\b/i.test(value) ? 'ChromeOS'
    : /\b(Macintosh|Mac OS X)\b/i.test(value) ? 'macOS'
    : /\bLinux\b/i.test(value) ? 'Linux'
    : '';
  return platform ? `${browser} on ${platform}` : browser;
}

/** @param {{clientName?:unknown,userAgent?:unknown,device?:unknown}} session */
export function sessionDeviceLabel(session) {
  const clientName=text(session?.clientName ?? session?.device);
  if (clientName && !looksLikeUserAgent(clientName) && !/^browser$/i.test(clientName)) return clientName;
  return userAgentLabel(text(session?.userAgent) || clientName);
}

/**
 * Keep browser/OS as a second line only when an explicit device name is shown.
 * @param {{clientName?:unknown,userAgent?:unknown,device?:unknown}} session
 */
export function sessionBrowserLabel(session) {
  const clientName=text(session?.clientName ?? session?.device);
  if (!clientName || looksLikeUserAgent(clientName) || /^browser$/i.test(clientName)) return null;
  const label=userAgentLabel(text(session?.userAgent));
  return label === 'Browser' ? null : label;
}

/** @param {number|undefined|null} seconds @param {string} timeZone */
export function sessionDateLabel(seconds, timeZone = 'UTC') {
  if (seconds == null) return 'Unknown date';
  const value=Number(seconds);
  if (!Number.isFinite(value)) return 'Unknown date';
  const date=new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) return 'Unknown date';
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const read=(type)=>parts.find((part)=>part.type===type)?.value;
  const year=read('year'),month=read('month'),day=read('day');
  return year&&month&&day ? `${year}-${month}-${day}` : 'Unknown date';
}

/** @param {number|undefined|null} seconds @param {string} timeZone */
export function sessionDateTimeLabel(seconds, timeZone = 'UTC') {
  const day=sessionDateLabel(seconds,timeZone);
  if(day==='Unknown date')return day;
  const time=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(Number(seconds)*1000));
  return `${day} ${time}`;
}
