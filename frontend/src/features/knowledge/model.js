// @ts-check

/** Pure Knowledge rules: routes, folder listings, file kinds, links and search shaping. */

/** @typedef {{path:string,size:number,kind:string|null,updatedAt:number,version?:string}} KnowledgeFile */
/** @typedef {{projectId:string|null,mode:'tree'|'blob',path:string,section:string,valid:boolean}} KnowledgeRoute */
/** @typedef {{name:string,path:string,folder:boolean,updatedAt:number,kind:string|null}} Entry */

/** Parse a route such as `knowledge/<projectId>/blob/guides/setup.md?section=install`. */
export function parseRoute(route) {
  const [pathPart, query = ''] = String(route ?? '').replace(/^#?\/?/, '').split('?');
  const parts = pathPart.split('/');
  /** @type {KnowledgeRoute} */
  const parsed = { projectId: null, mode: 'tree', path: '', section: '', valid: parts[0] === 'knowledge' };
  if (!parsed.valid) return parsed;
  try {
    parsed.projectId = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (parts.length > 2) {
      if (!['tree', 'blob'].includes(parts[2])) parsed.valid = false;
      parsed.mode = parts[2] === 'blob' ? 'blob' : 'tree';
      parsed.path = parts.slice(3).map(decodeURIComponent).join('/');
    }
    parsed.section = new URLSearchParams(query).get('section') ?? '';
  } catch {
    parsed.valid = false;
  }
  if (parsed.path.split('/').some((part) => part === '.' || part === '..') || (parsed.mode === 'blob' && !parsed.path)) parsed.valid = false;
  return parsed;
}

/** The hash for a folder (`tree`) or a file (`blob`), with an optional section anchor. */
export function routeHash(projectId, mode = 'tree', path = '', section = '') {
  const encoded = path ? '/' + path.split('/').map(encodeURIComponent).join('/') : '';
  const query = section ? '?' + new URLSearchParams({ section }) : '';
  return `#/knowledge/${encodeURIComponent(projectId)}/${mode}${encoded}${query}`;
}

export const baseName = (/** @type {string} */ path) => path.split('/').at(-1) ?? path;
export const parentPath = (/** @type {string} */ path) => path.split('/').slice(0, -1).join('/');

/** Files and folders directly inside `folder`. A folder's date is its newest file's. */
export function folderEntries(/** @type {KnowledgeFile[]} */ files, folder = '') {
  const prefix = folder ? folder + '/' : '';
  /** @type {Map<string,Entry>} */
  const entries = new Map();
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length), name = rest.split('/')[0], isFolder = rest.includes('/');
    const entry = entries.get(name);
    if (!entry) entries.set(name, { name, path: prefix + name, folder: isFolder, updatedAt: file.updatedAt, kind: isFolder ? null : file.kind });
    else if (file.updatedAt > entry.updatedAt) entry.updatedAt = file.updatedAt;
  }
  return [...entries.values()].sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name));
}

export const folderExists = (/** @type {KnowledgeFile[]} */ files, /** @type {string} */ path) => !path || files.some((file) => file.path.startsWith(path + '/'));
export const fileAt = (/** @type {KnowledgeFile[]} */ files, /** @type {string} */ path) => files.find((file) => file.path === path) ?? null;

/** The README.md shown below a folder's listing, in any letter case. */
export function readmeIn(/** @type {KnowledgeFile[]} */ files, folder = '') {
  const prefix = folder ? folder + '/' : '';
  return files.find((file) => file.path.startsWith(prefix) && file.path.slice(prefix.length).toLowerCase() === 'readme.md') ?? null;
}

/** The icon shape for a listing row. Color never carries the meaning. */
export function iconKind(/** @type {string} */ path, folder = false) {
  if (folder) return 'folder';
  const name = baseName(path).toLowerCase();
  if (name === 'readme.md') return 'readme';
  const extension = name.includes('.') ? name.split('.').at(-1) : '';
  return ({ md: 'markdown', markdown: 'markdown', mdx: 'markdown', json: 'config', jsonc: 'config', yaml: 'config', yml: 'config', toml: 'config', html: 'html', htm: 'html', pdf: 'pdf', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image' })[extension] ?? 'file';
}

/**
 * The Knowledge route for a relative Markdown link, or null when it leaves
 * the knowledge base or names nothing in it.
 */
export function resolveLink(/** @type {string} */ value, /** @type {string} */ fromPath, /** @type {KnowledgeFile[]} */ files, /** @type {string} */ projectId) {
  const target = relativeTarget(value, fromPath);
  if (!target) return null;
  const path = target.path || fromPath;
  if (fileAt(files, path)) return routeHash(projectId, 'blob', path, target.fragment);
  const folder = path.replace(/\/$/, '');
  if (folder && folderExists(files, folder)) return routeHash(projectId, 'tree', folder);
  return null;
}

/** A same-origin URL for a relative Markdown image that the knowledge base holds. */
export function resolveImage(/** @type {string} */ value, /** @type {string} */ fromPath, /** @type {KnowledgeFile[]} */ files, /** @type {string} */ projectId) {
  const target = relativeTarget(value, fromPath);
  const file = target?.path ? fileAt(files, target.path) : null;
  if (!file || file.kind !== 'image') return null;
  return fileUrl(projectId, 'content', file);
}

function relativeTarget(/** @type {string} */ value, /** @type {string} */ fromPath) {
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('/') || value.includes('\\')) return null;
  const [rawPath, fragment = ''] = value.split('#');
  const [pathOnly] = rawPath.split('?');
  const parts = parentPath(fromPath).split('/').filter(Boolean);
  for (const part of pathOnly.split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(part); } catch { return null; }
    if (!decoded || decoded === '.') continue;
    if (decoded === '..') { if (!parts.length) return null; parts.pop(); continue; }
    if (decoded.includes('/') || decoded.includes('\\')) return null;
    parts.push(decoded);
  }
  let section = fragment;
  try { section = decodeURIComponent(fragment); } catch {}
  return { path: pathOnly ? parts.join('/') : '', fragment: section };
}

/** API URL for one file. `content` serves images and PDFs, `text` text sources, `download` the original. */
export function fileUrl(/** @type {string} */ projectId, /** @type {'content'|'text'|'download'|'preview/html'} */ mode, /** @type {KnowledgeFile} */ file) {
  return `/api/projects/${encodeURIComponent(projectId)}/knowledge/${mode}?${new URLSearchParams({ path: file.path })}`;
}

/** The anchor the Markdown renderer gives a heading. */
export const headingSlug = (/** @type {string} */ text) => text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');

export const searchTerms = (/** @type {string} */ query) => [...new Set(String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);

const escapePattern = (/** @type {string} */ value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Escaped text with every search word marked. */
export function highlight(/** @type {string} */ value, /** @type {string[]} */ words, /** @type {(value:string)=>string} */ escape) {
  if (!words.length) return escape(value);
  const pattern = new RegExp('(' + words.map(escapePattern).join('|') + ')', 'giu');
  return String(value).split(pattern).map((part, index) => index % 2 ? `<mark>${escape(part)}</mark>` : escape(part)).join('');
}

/** What an administrator can do about a failed sync. */
export const FAILURES = Object.freeze({
  git_unavailable: 'The server can’t run Git 2.31 or later, or SSH.',
  auth_failed: 'The repository refused the access token or deploy key.',
  repository_not_found: 'The repository wasn’t found, or the credentials can’t read it.',
  branch_not_found: 'The branch wasn’t found in the repository.',
  folder_not_found: 'The folder wasn’t found on the branch.',
  host_unreachable: 'The repository host couldn’t be reached.',
  certificate_untrusted: 'The server doesn’t trust the host’s HTTPS certificate.',
  host_key_changed: 'The host’s SSH key changed since the first sync.',
  repository_moved: 'The repository moved to another address. Use its new URL.',
  too_large: 'The folder is too large to sync. Choose a smaller folder or remove large files.',
  timeout: 'The sync took too long.',
  storage_full: 'The server is low on disk space.',
  credentials_unavailable: 'The saved credentials can’t be read. Enter them again.',
  sync_failed: 'The sync failed. The server log has details.',
});

export const failureText = (/** @type {string|null|undefined} */ code) => (code && FAILURES[/** @type {keyof typeof FAILURES} */ (code)]) || FAILURES.sync_failed;

/** The scheme, host and port of an HTTPS URL, or null for other URLs. A saved token works only there. */
export function originOf(/** @type {string} */ value) {
  if (transportOf(value) !== 'https') return null;
  try { return new URL(String(value).trim()).origin; } catch { return null; }
}

/** Recognize the URL forms the server accepts, to choose the access field. */
export function transportOf(/** @type {string} */ value) {
  const url = String(value ?? '').trim();
  if (/^ssh:\/\//i.test(url) || /^[\w.-]+@[^:/\s]+:/.test(url)) return 'ssh';
  if (/^https:\/\//i.test(url)) return 'https';
  return null;
}
