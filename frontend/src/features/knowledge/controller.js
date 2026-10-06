// @ts-check

/**
 * Knowledge: one read-only folder of a Git repository per project. The view
 * layer calls these hooks to route, render and mount the page, the Settings
 * section and the connection dialog. Controls use data attributes and
 * delegated listeners; only `App.openModal` and `App.closeOverlays` appear
 * inline.
 */

import { actionErrorFeedback } from '../../app/action-feedback.js';
import { completeForm } from '../../app/form-feedback.js';
import {
  baseName, failureText, fileAt, fileUrl, folderEntries, folderExists, highlight,
  iconKind, originOf, parentPath, parseRoute, readmeIn, resolveImage, resolveLink, routeHash, searchTerms,
  transportOf,
} from './model.js';

/** @typedef {import('./model.js').KnowledgeFile} KnowledgeFile */
/** @typedef {{state:string,syncing:boolean,folder:string|null,checkedAt:number|null,skippedFiles:number,files:KnowledgeFile[],source?:any}} KnowledgeView */
/** @typedef {{data:KnowledgeView|null,json:string,error:unknown,promise:Promise<void>|null,unpainted:boolean,stale:boolean,refreshPending:boolean}} Cached */

const POLL_MS = 3000;
const SEARCH_DELAY_MS = 120;
const RECENT_FILES = 6;
const TEXT_LIMIT = 200 * 1024;

const esc = (/** @type {unknown} */ value) => String(value ?? '').replace(/[&<>"']/g, (c) => /** @type {Record<string,string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const svg = (/** @type {string} */ body, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = Object.freeze({
  book: '<path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Z"/><path d="M12 5v15"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  file: '<path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 12h8M8 16h6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  git: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10c0 7-12 3-12 10"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  warn: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v.1"/>',
});
const SHAPES = Object.freeze({
  folder: '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" fill="currentColor" fill-opacity=".14"/><path d="M3 9h18"/>',
  readme: '<path d="M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Zm0 0v15"/><path d="M6 8h3m-3 4h3m6-4h3m-3 4h3"/>',
  markdown: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5"/><path d="M8 12h8m-8 4h4m3-1 1 2 1-2"/>',
  config: '<path d="M8 4H6v6l-2 2 2 2v6h2m8-16h2v6l2 2-2 2v6h-2"/><circle cx="10" cy="12" r=".65" fill="currentColor"/><circle cx="14" cy="12" r=".65" fill="currentColor"/>',
  html: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5"/><path d="m10 12-2 2 2 2m4-4 2 2-2 2"/>',
  pdf: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5"/><path d="M8 17v-6h3a2 2 0 1 1 0 4H8m6 2h2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-7 5 8"/>',
  file: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5"/>',
});
const icon = (/** @type {keyof typeof ICONS} */ name, size = 16) => svg(ICONS[name], size);
const fileMark = (/** @type {string} */ path, folder = false) => {
  const kind = iconKind(path, folder);
  return `<span class="knowledge-file-mark" data-file-kind="${kind}" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${SHAPES[/** @type {keyof typeof SHAPES} */ (kind)]}</svg></span>`;
};

const MOVED_TOKEN = 'The saved token is for the previous host. Enter a new token or remove it.';

/** Field errors the dialog shows, phrased for the form rather than the API. */
const FIELD_ERRORS = Object.freeze({
  url: (/** @type {string} */ message) => /password/i.test(message) ? 'Put the password in Access token, not in the URL.' : /plain HTTP/i.test(message) ? 'Use HTTPS or SSH. Plain HTTP isn’t supported.' : 'Enter an HTTPS or SSH Git URL.',
  branch: () => 'Enter a valid branch name.',
  folder: () => 'Use a folder inside the repository.',
  token: (/** @type {string} */ message) => /HTTPS/.test(message) ? 'Tokens work only with HTTPS URLs.' : /previous host/i.test(message) ? MOVED_TOKEN : /new token/i.test(message) ? 'Enter the new token.' : 'Use one line of visible characters.',
});

/**
 * @param {{
 *   runtime:any,
 *   getApp:()=>any,
 *   documentObject?:Document,
 *   windowObject?:Window,
 *   setTimer?:(callback:()=>void,delay:number)=>any,
 *   clearTimer?:(timer:any)=>void,
 *   fetchImpl?:typeof fetch,
 * }} options
 */
export function installKnowledgeController({ runtime, getApp, documentObject = document, windowObject = window, setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = (timer) => clearTimeout(timer), fetchImpl = (...args) => fetch(...args) }) {
  const api = runtime.api, view = /** @type {any} */ (windowObject);
  const isElement = (/** @type {unknown} */ value) => value instanceof view.Element;
  const S = {
    projectId: /** @type {string|null} */ (null), mode: /** @type {'tree'|'blob'} */ ('tree'), path: '', section: '', valid: true,
    finding: false, query: '', scope: /** @type {'all'|'files'|'content'} */ ('all'), searchScroll: 0, suppressFocus: false,
    results: /** @type {{query:string,data:any}|null} */ (null), searching: false,
  };
  /** @type {Map<string,Cached>} */
  const cache = new Map();
  /** @type {Map<string,string[]>} */
  const recents = new Map();
  /** @type {Map<string,{text:string,truncated:boolean}>} */
  const texts = new Map();
  /** @type {Map<Element,()=>void>} */
  const previews = new Map();
  /** @type {{key:string,node:Element,focus:Element|null,scroll:number}|null} */
  let preserved = null;
  let pollTimer = null, searchTimer = null, searchController = /** @type {AbortController|null} */ (null), searchSequence = 0;
  let pendingScroll = /** @type {number|null} */ (null), deployKeyRequest = /** @type {Promise<void>|null} */ (null);

  const app = () => getApp?.();
  const context = () => app()?.context?.() ?? {};
  const isAdmin = () => !!runtime.data?.users?.find?.((/** @type {any} */ user) => user.id === runtime.data?.session?.userId)?.admin;
  const toast = (/** @type {string} */ text, kind = 'success') => app()?.toast?.(text, kind);
  const errorText = (/** @type {unknown} */ error, fallback = 'The request could not be completed.') => view.OneloopErrorMessage?.(error, fallback) || fallback;
  const instant = (/** @type {number} */ seconds) => view.OneloopTime?.instant?.(seconds * 1000) ?? new Date(seconds * 1000).toISOString().replace('T', ' ');
  const dateOf = (/** @type {number|null|undefined} */ seconds) => seconds ? instant(seconds).slice(0, 10) : '—';
  const timeOf = (/** @type {number|null|undefined} */ seconds) => seconds ? instant(seconds).slice(0, 16) : '';
  const viewOf = (/** @type {string|null} */ projectId) => projectId ? cache.get(projectId)?.data ?? null : null;
  const setHTML = (/** @type {Element} */ element, /** @type {string} */ html) => view.UIHTML ? view.UIHTML(element, html) : (element.innerHTML = html);

  // ---------- data ----------

  /** Load (or reload) one project's Knowledge view and repaint what shows it. */
  function load(/** @type {string} */ projectId, { background = false, invalidate = false } = {}) {
    const entry = cache.get(projectId) ?? { data: null, json: '', error: null, promise: null, unpainted: false, stale: false, refreshPending: false };
    cache.set(projectId, entry);
    if (entry.promise) { if (invalidate) entry.refreshPending = true; return entry.promise; }
    entry.stale = false;
    entry.promise = api.request(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, { background })
      .then((/** @type {KnowledgeView} */ data) => {
        if (cache.get(projectId) !== entry) return;
        const json = JSON.stringify(data);
        entry.error = null;
        if (json !== entry.json) { entry.data = data; entry.json = json; entry.unpainted = true; }
        if (entry.unpainted) repaint(projectId);
      })
      .catch((/** @type {any} */ error) => {
        if (error?.code === 'aborted' || cache.get(projectId) !== entry) return;
        entry.error = error;
        if (!entry.data) repaint(projectId);
      })
      .finally(() => {
        entry.promise = null;
        if (cache.get(projectId) !== entry) return;
        if (entry.refreshPending) { entry.refreshPending = false; void load(projectId, { background: true }); }
        else schedulePoll();
      });
    return entry.promise;
  }

  function repaint(/** @type {string} */ projectId) {
    const current = context(), entry = cache.get(projectId);
    if (current.projectId !== projectId || !['knowledge', 'settings'].includes(current.view)) return;
    if (current.modal) {
      // A repaint would reset the dialog, so only fill a deploy key it waits
      // for; the page behind it repaints when the dialog closes.
      const key = viewOf(projectId)?.source?.deployKey;
      const input = /** @type {HTMLInputElement|null} */ (documentObject.querySelector('form[data-knowledge-form] #knowledge-key'));
      if (input && key && !input.value) input.value = key;
      app()?.refreshAfterDialog?.();
      return;
    }
    if (entry) entry.unpainted = false;
    app()?.refresh?.();
  }

  /** While a sync runs, read again every few seconds: an unchanged branch sends no live hint. */
  function schedulePoll() {
    clearTimer(pollTimer); pollTimer = null;
    const current = context(), data = viewOf(current.projectId);
    if (!data || !['knowledge', 'settings'].includes(current.view) || documentObject.visibilityState === 'hidden') return;
    if (data.state !== 'pending' && !data.syncing) return;
    pollTimer = setTimer(() => { pollTimer = null; const now = context(); if (now.projectId) void load(now.projectId, { background: true }); }, POLL_MS);
  }

  runtime.subscribe((/** @type {any} */ change) => {
    if (change?.type === 'sse' && change.kind === 'reconcile') {
      for (const entry of cache.values()) entry.stale = true;
      const current = context();
      if (current.projectId && ['knowledge', 'settings'].includes(current.view)) void load(current.projectId, { background: true, invalidate: true });
    }
    if (change?.type === 'sse' && change.entityType === 'knowledge_source') {
      const projectId = change.projectId ?? context().projectId;
      if (projectId && cache.has(projectId)) void load(projectId, { background: true, invalidate: true });
    }
    if (change?.type === 'auth') { cache.clear(); recents.clear(); texts.clear(); }
  });
  documentObject.addEventListener('visibilitychange', () => {
    if (documentObject.visibilityState !== 'visible') return;
    const current = context();
    if (current.projectId && ['knowledge', 'settings'].includes(current.view) && cache.has(current.projectId)) void load(current.projectId, { background: true, invalidate: true });
  });

  // ---------- page ----------

  /** Route `knowledge[/<project>/(tree|blob)/<path>][?section=]`; returns the project it names. */
  function route(/** @type {string} */ hashRoute, /** @type {string|null} */ currentProjectId) {
    const parsed = parseRoute(hashRoute);
    Object.assign(S, { mode: parsed.mode, path: parsed.path, section: parsed.section, valid: parsed.valid, finding: false, query: '', results: null });
    S.projectId = parsed.projectId ?? currentProjectId;
    closeFullView();
    if (S.projectId && S.mode === 'blob' && parsed.valid) {
      recents.set(S.projectId, [S.path, ...(recents.get(S.projectId) ?? []).filter((path) => path !== S.path)].slice(0, RECENT_FILES));
    }
    return S.projectId;
  }

  /** The workspace's markup. Previews mount into it later. */
  function workspaceHtml(/** @type {string} */ projectId) {
    const entry = cache.get(projectId), data = entry?.data ?? null;
    const ready = !!data && data.files.length > 0;
    const toolbar = ready ? toolbarHtml() : '';
    let body;
    if (!data) body = entry?.error ? errorHtml(entry.error) : '<p class="knowledge-loading" role="status">Loading knowledge…</p>';
    else body = bannerHtml(data) + readerHtml(projectId, data);
    return `${toolbar}<div class="knowledge-reader" tabindex="-1">${body}</div>`;
  }

  /**
   * Identifies what the workspace shows, so a read that changes nothing on
   * screen, such as a newer sync time, keeps the rendered previews and scroll.
   */
  const workspaceKey = (/** @type {string} */ html) => {
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let index = 0; index < html.length; index++) {
      const code = html.charCodeAt(index);
      a = Math.imul(a ^ code, 0x01000193); b = Math.imul(b ^ code, 0x85ebca6b);
    }
    return `${html.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
  };

  function render(/** @type {string} */ projectId) {
    if (S.projectId !== projectId) { S.projectId = projectId; S.mode = 'tree'; S.path = ''; S.section = ''; S.valid = true; S.finding = false; S.query = ''; S.results = null; }
    const entry = cache.get(projectId);
    if (entry) entry.unpainted = false;
    const html = workspaceHtml(projectId);
    return `<div class="knowledge-workspace" data-knowledge-key="${workspaceKey(html)}">${html}</div>`;
  }

  function readerHtml(/** @type {string} */ projectId, /** @type {KnowledgeView} */ data) {
    if (data.state === 'unconnected') {
      return emptyHtml('A home for project knowledge', 'Connect a repository folder to bring your team’s guides, product rules and decisions into the project.',
        isAdmin() ? `<button type="button" class="btn primary" data-action="openModal" data-args='["knowledge"]'>Connect repository</button>` : '<span class="knowledge-badge">Ask an admin to connect a repository</span>');
    }
    if (!data.files.length && data.state === 'failed') {
      return emptyHtml('Knowledge couldn’t sync', isAdmin() ? esc(failureText(data.source?.errorCode)) : 'Ask an admin to check the repository connection.',
        isAdmin() ? `<div class="knowledge-empty-actions">${retryButton(data)}<button type="button" class="btn" data-action="openModal" data-args='["knowledge"]'>Manage connection</button></div>` : '', 'warn');
    }
    if (!data.files.length) {
      return emptyHtml(data.state === 'pending' ? 'Bringing your knowledge together' : 'This folder is empty', data.state === 'pending' ? 'Reading the selected folder and preparing files for search.' : 'Add files to the folder in Git. They appear here after the next sync.', '', 'git');
    }
    if (!S.valid || (S.mode === 'blob' && !fileAt(data.files, S.path)) || (S.mode === 'tree' && !folderExists(data.files, S.path))) {
      return emptyHtml('This path is no longer here', 'It may have moved or been removed from the repository.', '<button type="button" class="btn primary" data-knowledge-action="home">Browse knowledge</button>', 'file');
    }
    if (S.finding) return finderHtml(projectId, data);
    return repositoryHtml(projectId, data);
  }

  const emptyHtml = (/** @type {string} */ title, /** @type {string} */ text, control = '', /** @type {keyof typeof ICONS} */ symbol = 'book') => `<div class="knowledge-empty">${icon(symbol, 32)}<h2>${esc(title)}</h2><p>${text}</p>${control}</div>`;
  const errorHtml = (/** @type {unknown} */ error) => emptyHtml('Knowledge is unavailable', esc(errorText(error, 'Knowledge could not be loaded.')), '<button type="button" class="btn" data-knowledge-action="reload">Try again</button>', 'warn');
  const retryButton = (/** @type {KnowledgeView} */ data) => data.syncing ? '<button type="button" class="btn" disabled>Syncing…</button>' : '<button type="button" class="btn" data-knowledge-action="retry">Retry sync</button>';

  function bannerHtml(/** @type {KnowledgeView} */ data) {
    if (data.state !== 'failed' || !data.files.length) return '';
    const since = data.checkedAt ? ` Showing the last successful sync from ${esc(timeOf(data.checkedAt))}.` : '';
    return `<div class="knowledge-banner" role="status">${icon('warn')}<span>Knowledge may be out of date<small>Couldn’t sync with the repository.${since}</small></span>${isAdmin() ? retryButton(data) : ''}</div>`;
  }

  const toolbarHtml = () => `<div class="knowledge-toolbar${S.finding ? ' is-searching' : ''}"><label class="knowledge-search">${icon('search')}<input type="search" aria-label="Search knowledge" placeholder="Search knowledge" value="${esc(S.query)}" autocomplete="off" spellcheck="false" ${S.finding ? 'aria-controls="knowledge-results" ' : ''}data-knowledge-search><button type="button" class="knowledge-search-clear" aria-label="Clear search" data-knowledge-action="clear-query">${icon('close', 12)}</button><kbd class="knowledge-search-kbd" aria-hidden="true">/</kbd></label><button type="button" class="btn quiet knowledge-search-cancel" data-knowledge-action="cancel-search">Cancel</button></div>`;

  function breadcrumbHtml(/** @type {string} */ projectId, /** @type {KnowledgeView} */ data) {
    const parts = S.path.split('/').filter(Boolean), root = data.folder ? baseName(data.folder) : 'Knowledge base';
    const crumbs = parts.map((part, index) => `<span aria-hidden="true">/</span>${index === parts.length - 1 ? `<strong aria-current="page">${esc(part)}</strong>` : `<a href="${esc(routeHash(projectId, 'tree', parts.slice(0, index + 1).join('/')))}">${esc(part)}</a>`}`).join('');
    return `<nav class="knowledge-breadcrumb" aria-label="File path">${parts.length ? `<a href="${esc(routeHash(projectId))}">${esc(root)}</a>` : `<strong aria-current="page">${esc(root)}</strong>`}${crumbs}</nav>`;
  }

  function listingHtml(/** @type {string} */ projectId, /** @type {KnowledgeView} */ data) {
    const rows = folderEntries(data.files, S.path).map((entry) => `<tr><td><a href="${esc(routeHash(projectId, entry.folder ? 'tree' : 'blob', entry.path))}">${fileMark(entry.path, entry.folder)}<span>${esc(entry.name)}</span></a></td><td><time>${esc(dateOf(entry.updatedAt))}</time></td></tr>`).join('');
    const parent = S.path ? `<tr><td colspan="2"><a href="${esc(routeHash(projectId, 'tree', parentPath(S.path)))}" aria-label="Parent folder">${fileMark('', true)}<span>..</span></a></td></tr>` : '';
    return `<div class="knowledge-file-list"><table aria-label="Files"><thead><tr><th scope="col">Name</th><th scope="col">Updated</th></tr></thead><tbody>${parent}${rows}</tbody></table></div>`;
  }

  function previewCardHtml(/** @type {string} */ projectId, /** @type {KnowledgeFile} */ file, readme = false) {
    const name = baseName(file.path), full = file.kind ? `<button type="button" class="btn icon" aria-label="Open full view" title="Full view" data-knowledge-action="full-view" data-path="${esc(file.path)}">${icon('expand')}</button>` : '';
    return `<section class="knowledge-preview${readme ? ' knowledge-readme' : ''}" aria-label="${readme ? 'Folder README' : 'File contents'}"><header class="knowledge-preview-head"><span class="knowledge-file-title">${fileMark(file.path)}<strong>${esc(name)}</strong></span><div class="knowledge-preview-modes"></div><div class="knowledge-preview-actions">${full}<a class="btn icon" href="${esc(fileUrl(projectId, 'download', file))}" download="${esc(name)}" aria-label="Download ${esc(name)}" title="Download">${icon('download')}</a></div></header><div class="knowledge-preview-body" data-knowledge-preview="${esc(file.path)}" data-version="${esc(file.version ?? '')}"></div></section>`;
  }

  function repositoryHtml(/** @type {string} */ projectId, /** @type {KnowledgeView} */ data) {
    const tree = S.mode === 'tree', file = tree ? readmeIn(data.files, S.path) : fileAt(data.files, S.path);
    const count = tree ? `<span class="knowledge-item-count">${folderEntries(data.files, S.path).length} items</span>` : '';
    const skipped = tree && !S.path && data.skippedFiles ? `<p class="knowledge-skipped">${data.skippedFiles === 1 ? 'One file is' : `${data.skippedFiles} files are`} larger than 10 MB and not shown.</p>` : '';
    return `<div class="knowledge-content"><div class="knowledge-path-row">${breadcrumbHtml(projectId, data)}${count}</div>${tree ? listingHtml(projectId, data) : ''}${file ? previewCardHtml(projectId, file, tree) : ''}${skipped}</div>`;
  }

  // ---------- search ----------

  const where = (/** @type {string} */ path, /** @type {KnowledgeView} */ data) => [data.folder, parentPath(path)].filter(Boolean).join('/');
  const nameHit = (/** @type {string} */ projectId, /** @type {{path:string,folder:boolean}} */ item, /** @type {string[]} */ words, /** @type {KnowledgeView} */ data) => `<a class="knowledge-hit knowledge-hit--file" href="${esc(routeHash(projectId, item.folder ? 'tree' : 'blob', item.path))}" data-knowledge-hit>${fileMark(item.path, item.folder)}<span class="knowledge-hit-name">${highlight(baseName(item.path), words, esc)}</span><span class="knowledge-hit-where">${esc(where(item.path, data))}</span></a>`;

  function documentHits(/** @type {string} */ projectId, /** @type {any} */ doc, /** @type {number} */ limit, /** @type {string[]} */ words, /** @type {KnowledgeView} */ data) {
    const shown = doc.hits.slice(0, limit), rest = doc.total - shown.length;
    const sections = shown.map((/** @type {any} */ hit) => {
      const section = hit.section ?? '';
      return `<a class="knowledge-hit knowledge-hit--text" href="${esc(routeHash(projectId, 'blob', doc.path, section))}" data-knowledge-hit><span class="knowledge-hit-heading">${highlight(hit.heading, words, esc)}</span><span class="knowledge-hit-snippet">${highlight(hit.snippet, words, esc)}</span></a>`;
    }).join('');
    const more = rest > 0 ? (S.scope === 'all' && doc.hits.length > shown.length
      ? `<button type="button" class="knowledge-finder-more" data-knowledge-action="scope" data-scope="content">${rest} more in this file</button>`
      : `<a class="knowledge-finder-more" href="${esc(routeHash(projectId, 'blob', doc.path))}" data-knowledge-hit>${rest} more in this file</a>`) : '';
    return `<div class="knowledge-hit-doc"><a class="knowledge-hit knowledge-hit--doc" href="${esc(routeHash(projectId, 'blob', doc.path))}" data-knowledge-hit>${fileMark(doc.path)}<span class="knowledge-hit-name">${esc(baseName(doc.path))}</span><span class="knowledge-hit-where">${esc(where(doc.path, data))}</span></a><div class="knowledge-hit-sections">${sections}${more}</div></div>`;
  }

  const finderFoot = '<div class="knowledge-finder-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span><span><kbd>esc</kbd> to close</span></div>';
  const group = (/** @type {string} */ title, /** @type {string} */ body) => `<section class="knowledge-finder-group" aria-label="${title}"><h3>${title}</h3>${body}</section>`;
  const noResults = (/** @type {string} */ title, /** @type {string} */ detail) => `<div class="knowledge-finder-empty"><strong>${title}</strong><span>${detail}</span></div>`;
  const finderShell = (/** @type {string} */ head, /** @type {string} */ body) => `<div class="knowledge-content"><div class="knowledge-finder" role="region" aria-label="Search results">${head ? `<div class="knowledge-finder-head">${head}</div>` : ''}<div class="knowledge-finder-body" id="knowledge-results" aria-live="polite">${body}</div>${finderFoot}</div></div>`;

  function finderHtml(/** @type {string} */ projectId, /** @type {KnowledgeView} */ data) {
    const words = searchTerms(S.query);
    if (!words.length) {
      const recent = (recents.get(projectId) ?? []).filter((path) => fileAt(data.files, path));
      const items = recent.length ? recent : data.files.map((file) => file.path).sort((a, b) => Number(a.includes('/')) - Number(b.includes('/')) || a.localeCompare(b)).slice(0, 50);
      return finderShell('', group(recent.length ? 'Recent' : 'Files', items.map((path) => nameHit(projectId, { path, folder: false }, [], data)).join('')));
    }
    const result = S.results?.query === S.query ? S.results.data : null;
    if (!result) return finderShell('', `<p class="knowledge-finder-status" role="status">${S.searching ? 'Searching…' : ''}</p>`);
    const files = result.fileCount, hits = result.hitCount, quoted = `“${esc(S.query.trim())}”`, scope = S.scope;
    const tabs = `<div class="seg knowledge-scope" role="tablist" aria-label="Search in">${[['all', 'All', files + hits], ['files', 'Files', files], ['content', 'Content', hits]].map(([id, label, count]) => `<button type="button" role="tab" aria-selected="${scope === id}" class="${scope === id ? 'on' : ''}" data-knowledge-action="scope" data-scope="${id}">${label}<span>${count}</span></button>`).join('')}</div>`;
    if (!files && !hits) return finderShell('', noResults(`No results for ${quoted}`, 'Try fewer words or a different spelling.'));
    if (scope === 'files' && !files) return finderShell(tabs, noResults(`No file or folder names match ${quoted}`, `${hits} ${hits === 1 ? 'match' : 'matches'} in document text.`));
    if (scope === 'content' && !hits) return finderShell(tabs, noResults(`No document text matches ${quoted}`, `${files} matching ${files === 1 ? 'name' : 'names'} in Files.`));
    const all = scope === 'all', fileLimit = all ? 5 : Infinity, docLimit = all ? 3 : Infinity, hitLimit = all ? 2 : Infinity;
    const fileGroup = scope !== 'content' && files ? group('Files', result.files.slice(0, fileLimit).map((/** @type {any} */ item) => nameHit(projectId, item, words, data)).join('') + (all && files > fileLimit ? `<button type="button" class="knowledge-finder-more" data-knowledge-action="scope" data-scope="files">Show all ${files} files</button>` : '')) : '';
    const textGroup = scope !== 'files' && hits ? group('In documents', result.documents.slice(0, docLimit).map((/** @type {any} */ doc) => documentHits(projectId, doc, hitLimit, words, data)).join('') + (all && (result.documents.length > docLimit || hits > result.documents.slice(0, docLimit).reduce((/** @type {number} */ total, /** @type {any} */ doc) => total + Math.min(doc.hits.length, hitLimit), 0)) ? `<button type="button" class="knowledge-finder-more" data-knowledge-action="scope" data-scope="content">Show all ${hits} matches</button>` : '')) : '';
    return finderShell(tabs, fileGroup + textGroup);
  }

  function paintFinder() {
    const reader = documentObject.querySelector('.knowledge-reader'), data = viewOf(S.projectId);
    if (!reader || !data || !S.projectId) return;
    disposePreviews(reader);
    setHTML(reader, bannerHtml(data) + readerHtml(S.projectId, data));
    documentObject.querySelector('.knowledge-toolbar')?.classList.toggle('is-searching', S.finding);
    // The results exist only while searching; the field names them only then.
    documentObject.querySelector('[data-knowledge-search]')?.toggleAttribute('aria-controls', false);
    if (S.finding) documentObject.querySelector('[data-knowledge-search]')?.setAttribute('aria-controls', 'knowledge-results');
    const workspace = documentObject.querySelector('.knowledge-workspace');
    if (workspace) workspace.setAttribute('data-knowledge-key', workspaceKey(workspaceHtml(S.projectId)));
  }

  function openFinder() {
    if (S.finding) return;
    const reader = documentObject.querySelector('.knowledge-reader');
    S.searchScroll = reader?.scrollTop ?? 0; S.scope = 'all'; S.finding = true;
    paintFinder();
    if (reader) reader.scrollTop = 0;
  }

  function search(/** @type {string} */ query) {
    S.query = query;
    if (!S.finding) openFinder();
    clearTimer(searchTimer); searchController?.abort();
    if (!searchTerms(query).length) { S.searching = false; paintFinder(); return; }
    S.searching = true;
    if (S.results?.query !== query) paintFinder();
    const projectId = S.projectId, sequence = ++searchSequence;
    searchTimer = setTimer(() => {
      const controller = new AbortController(); searchController = controller;
      api.request(`/api/projects/${encodeURIComponent(String(projectId))}/knowledge/search?${new URLSearchParams({ q: query })}`, { signal: controller.signal })
        .then((/** @type {any} */ data) => { if (sequence !== searchSequence || projectId !== S.projectId) return; S.results = { query, data }; S.searching = false; if (S.finding) paintFinder(); })
        .catch((/** @type {any} */ error) => { if (error?.code === 'aborted' || sequence !== searchSequence) return; S.searching = false; S.results = null; if (S.finding) { const body = documentObject.getElementById('knowledge-results'); if (body) setHTML(body, noResults('Search is unavailable', esc(errorText(error, 'Try again in a moment.')))); } });
    }, SEARCH_DELAY_MS);
  }

  function closeFinder(refocus = true) {
    if (!S.finding) return;
    clearTimer(searchTimer); searchController?.abort();
    S.finding = false; S.query = ''; S.results = null; S.searching = false;
    pendingScroll = S.searchScroll;
    app()?.refresh?.();
    if (!refocus) return;
    const input = /** @type {HTMLInputElement|null} */ (documentObject.querySelector('[data-knowledge-search]'));
    S.suppressFocus = true; input?.focus({ preventScroll: true }); S.suppressFocus = false;
  }

  // ---------- previews ----------

  /** The attachment viewer's file shape, read-only. */
  function viewerFile(/** @type {string} */ projectId, /** @type {KnowledgeFile} */ file) {
    const data = viewOf(projectId);
    return {
      id: `knowledge:${projectId}:${file.path}:${file.version ?? ''}`, name: baseName(file.path), path: [data?.folder, file.path].filter(Boolean).join('/'),
      size: file.size, updatedAt: file.updatedAt, previewKind: file.kind, state: 'available',
      url: fileUrl(projectId, file.kind === 'image' || file.kind === 'pdf' ? 'content' : 'download', file),
      contentUrl: file.kind === 'image' || file.kind === 'pdf' ? fileUrl(projectId, 'content', file) : null,
      sourceUrl: ['markdown', 'text', 'html'].includes(String(file.kind)) ? fileUrl(projectId, 'text', file) : null,
      htmlPreviewUrl: file.kind === 'html' ? fileUrl(projectId, 'preview/html', file) : null,
      downloadUrl: fileUrl(projectId, 'download', file),
      markdownContext: markdownContext(projectId, file.path),
    };
  }

  function markdownContext(/** @type {string} */ projectId, /** @type {string} */ fromPath) {
    const files = () => viewOf(projectId)?.files ?? [];
    return {
      resolveLink: (/** @type {string} */ href) => resolveLink(href, fromPath, files(), projectId),
      resolveImage: (/** @type {string} */ src) => resolveImage(src, fromPath, files(), projectId),
      diagramTheme,
    };
  }

  /** Mermaid draws into an isolated image, so theme tokens become opaque colors here. */
  function tokenColor(/** @type {string} */ name, over = '--surface-canvas') {
    const probe = documentObject.createElement('i'); probe.style.color = `var(${name})`; documentObject.body.append(probe);
    const [r, g, b, a = 1] = (windowObject.getComputedStyle(probe).color.match(/[\d.]+/g) ?? ['0', '0', '0']).map(Number); probe.remove();
    const base = a < 1 ? (tokenColor(over).match(/[0-9a-f]{2}/g) ?? ['00', '00', '00']).map((hex) => parseInt(hex, 16)) : [r, g, b];
    return '#' + [r, g, b].map((channel, index) => Math.round(channel * a + base[index] * (1 - a)).toString(16).padStart(2, '0')).join('');
  }

  function diagramTheme() {
    const raised = tokenColor('--surface-raised'), canvas = tokenColor('--surface-canvas'), border = tokenColor('--line-strong', '--surface-raised'), ink = tokenColor('--ink');
    return { theme: 'base', themeVariables: { darkMode: documentObject.documentElement.dataset.theme === 'dark', background: canvas, primaryColor: raised, secondaryColor: raised, tertiaryColor: canvas, primaryBorderColor: border, secondaryBorderColor: border, tertiaryBorderColor: border, lineColor: tokenColor('--ink-faint'), primaryTextColor: ink, secondaryTextColor: ink, tertiaryTextColor: ink, textColor: ink, edgeLabelBackground: canvas, clusterBkg: raised, clusterBorder: border, dropShadow: 'none', useGradient: false } };
  }

  async function textOf(/** @type {string} */ projectId, /** @type {KnowledgeFile} */ file) {
    const key = `${projectId}:${file.path}:${file.version ?? ''}`, cached = texts.get(key);
    if (cached) return cached;
    const response = await fetchImpl(fileUrl(projectId, 'text', file), { credentials: 'same-origin', cache: 'no-cache', redirect: 'error', headers: { 'X-Oneloop-Background': '1' } });
    if (!response.ok) throw new Error('Preview unavailable');
    const value = { text: new TextDecoder().decode(await response.arrayBuffer()), truncated: file.size > TEXT_LIMIT };
    if (texts.size > 64) texts.delete(texts.keys().next().value);
    texts.set(key, value);
    return value;
  }

  function mountPreview(/** @type {Element} */ host) {
    const projectId = S.projectId, data = viewOf(projectId), file = data && projectId ? fileAt(data.files, host.getAttribute('data-knowledge-preview') ?? '') : null;
    if (!file || !projectId || previews.has(host)) return;
    previews.set(host, () => {});
    const tools = host.closest('.knowledge-preview')?.querySelector('.knowledge-preview-modes');
    const moveTools = () => { const found = host.querySelector('.html-preview-tools'); if (found && tools) tools.append(found); };
    const unavailable = (/** @type {string} */ text) => setHTML(host, `<p class="preview-unavailable">${text}</p>`);
    const viewer = viewerFile(projectId, file), views = view.FileViews;
    if (file.kind === 'image' || file.kind === 'pdf') {
      host.classList.add('knowledge-media-body', 'file-preview-content'); host.setAttribute('data-inline-kind', file.kind);
      const dispose = view.Uploads?.mountInlinePreview?.(host, viewer, tools);
      if (typeof dispose === 'function') previews.set(host, dispose);
      return;
    }
    if (!file.kind || !views) { unavailable('Preview is not available for this format. Download the original file.'); return; }
    setHTML(host, '<p class="access-note" role="status">Loading preview…</p>');
    textOf(projectId, file).then(({ text, truncated }) => {
      if (!host.isConnected) return;
      host.replaceChildren();
      if (file.kind === 'markdown') { views.markdown(host, viewer, text, truncated, viewer.markdownContext); enhanceMarkdown(host); }
      else if (file.kind === 'html') views.html(host, viewer, text);
      else views.text(host, viewer, text, truncated);
      moveTools();
    }).catch(() => { if (host.isConnected) unavailable('Preview unavailable. Download the original file.'); });
  }

  /** Add copy-link anchors to section headings and scroll to a requested section once Markdown renders. */
  function enhanceMarkdown(/** @type {Element} */ host) {
    const apply = () => {
      const article = host.querySelector('.markdown-body');
      if (!article) return false;
      article.classList.add('knowledge-article');
      for (const heading of article.querySelectorAll('h2,h3')) {
        if (heading.querySelector('.knowledge-heading-link') || !heading.id.startsWith('md-')) continue;
        const button = documentObject.createElement('button');
        button.type = 'button'; button.className = 'knowledge-heading-link'; button.textContent = '#';
        button.setAttribute('aria-label', `Copy link to ${heading.textContent}`);
        button.setAttribute('data-knowledge-action', 'copy-section'); button.setAttribute('data-section', heading.id.slice(3));
        heading.append(button);
      }
      revealSection();
      return true;
    };
    if (apply()) return;
    const observer = new view.MutationObserver(() => { if (!host.isConnected || apply()) observer.disconnect(); });
    observer.observe(host, { childList: true, subtree: true });
  }

  function revealSection() {
    const reader = documentObject.querySelector('.knowledge-reader');
    if (!reader) return;
    if (S.section) {
      const target = documentObject.getElementById('md-' + S.section);
      if (!target) return;
      reader.scrollTo({ top: reader.scrollTop + target.getBoundingClientRect().top - reader.getBoundingClientRect().top - 20, behavior: 'auto' });
      S.section = '';
      pendingScroll = null;
    } else if (pendingScroll !== null) { reader.scrollTop = pendingScroll; pendingScroll = null; }
  }

  function disposePreviews(/** @type {Element|null} */ within = null) {
    for (const [host, dispose] of previews) {
      if (within && !within.contains(host)) continue;
      try { dispose(); } catch {}
      previews.delete(host);
    }
  }

  function fullView(/** @type {string} */ path) {
    const projectId = S.projectId, data = viewOf(projectId), file = data && projectId ? fileAt(data.files, path) : null;
    if (!file?.kind || !projectId || !view.Uploads?.previewCollection) return;
    const viewer = viewerFile(projectId, file);
    view.Uploads.previewCollection([viewer], viewer.id, () => context().view === 'knowledge' && context().projectId === projectId);
    documentObject.querySelector('.file-overlay:not([data-motion-exiting])')?.classList.add('knowledge-full-view');
  }

  /** A link followed inside full view shows its target here, so the dialog closes first. */
  const closeFullView = () => /** @type {HTMLElement|null} */ (documentObject.querySelector('.knowledge-full-view:not([data-motion-exiting]) [data-file-close]'))?.click();

  // ---------- lifecycle hooks ----------

  function beforeRender() {
    const node = documentObject.querySelector('.knowledge-workspace');
    preserved = null;
    if (!node) { disposePreviews(); return; }
    const active = documentObject.activeElement;
    preserved = { key: node.getAttribute('data-knowledge-key') ?? '', node, focus: active && node.contains(active) ? active : null, scroll: node.querySelector('.knowledge-reader')?.scrollTop ?? 0 };
  }

  function mount() {
    const current = context();
    const fresh = documentObject.querySelector('.knowledge-workspace');
    if (preserved && fresh && preserved.node !== fresh && preserved.key === fresh.getAttribute('data-knowledge-key')) {
      // Unchanged content keeps its rendered previews, scroll and focus across app renders.
      fresh.replaceWith(preserved.node);
      const reader = preserved.node.querySelector('.knowledge-reader');
      if (reader) reader.scrollTop = preserved.scroll;
      if (preserved.focus instanceof view.HTMLElement && documentObject.activeElement === documentObject.body) /** @type {HTMLElement} */ (preserved.focus).focus({ preventScroll: true });
    } else if (preserved?.node && preserved.node !== fresh) disposePreviews(preserved.node);
    preserved = null;
    for (const [host, dispose] of previews) if (!host.isConnected) { try { dispose(); } catch {} previews.delete(host); }
    const entry = cache.get(current.projectId);
    if (current.projectId && ['knowledge', 'settings'].includes(current.view) && (entry?.stale || !entry?.data && !entry?.error)) void load(current.projectId, { invalidate: !!entry?.stale });
    if (current.view !== 'knowledge') { schedulePoll(); return; }
    for (const host of documentObject.querySelectorAll('[data-knowledge-preview]')) mountPreview(host);
    if (!documentObject.querySelector('[data-knowledge-preview]')) revealSection();
    schedulePoll();
  }

  // ---------- Settings and the connection dialog ----------

  function statusHtml(/** @type {any} */ source) {
    const last = source.checkedAt ? timeOf(source.checkedAt) : '';
    const [tone, label] = source.syncing || source.state === 'pending' ? ['', 'Syncing…'] : source.state === 'failed' ? ['warn', last ? `Sync failed · last synced ${last}` : 'Sync failed'] : ['ok', `Synced ${last}`];
    return `<span class="knowledge-source-status ${tone}"><i aria-hidden="true"></i>${esc(label)}</span>`;
  }

  function settingsHtml(/** @type {string} */ projectId) {
    const entry = cache.get(projectId), data = entry?.data, source = data?.source;
    if (entry) entry.unpainted = false;
    let row;
    if (!data) row = entry?.error ? `<p class="access-note" role="alert">${esc(errorText(entry.error, 'Knowledge base settings could not be loaded.'))} <button type="button" class="btn quiet" data-knowledge-action="reload">Retry</button></p>` : '<p class="access-note" role="status">Loading…</p>';
    else if (!source) row = `<div class="knowledge-source-row"><span class="knowledge-source-mark" aria-hidden="true">${icon('git')}</span><span class="knowledge-source-name"><b>No repository connected</b><small>Show a folder from any Git repository as this project’s knowledge base.</small></span><button type="button" class="btn" data-action="openModal" data-args='["knowledge"]'>Connect repository</button></div>`;
    else row = `<div class="knowledge-source-row"><span class="knowledge-source-mark" aria-hidden="true">${icon('git')}</span><span class="knowledge-source-name"><b title="${esc(source.repository)}">${esc(source.repository)}</b><small class="knowledge-source-meta"><span class="mono">${esc(source.branch)} · ${esc(source.folder || '/')}</span>${statusHtml(source)}</small>${source.state === 'failed' ? `<small class="knowledge-source-error">${esc(failureText(source.errorCode))}</small>` : ''}</span><button type="button" class="btn" data-action="openModal" data-args='["knowledge"]'>Manage connection</button></div>`;
    return `<div class="section" id="knowledge-settings"><h2>Knowledge base</h2>${row}</div>`;
  }

  function modalHtml() {
    const projectId = context().projectId, source = viewOf(projectId)?.source ?? null, connected = !!source;
    const ssh = transportOf(source?.url ?? '') === 'ssh', saved = connected && source.hasToken;
    const label = (/** @type {string} */ id, /** @type {string} */ text, hint = '') => `<div class="knowledge-field-label"><label for="${id}">${text}</label>${hint ? `<span>${hint}</span>` : ''}</div>`;
    const token = saved
      ? `<div class="knowledge-secret" data-token-state="keep"><span class="knowledge-secret-value">${icon('lock', 14)}<span data-token-label>Token saved</span></span><span class="knowledge-secret-actions"><button type="button" class="btn quiet" data-knowledge-action="token" data-state="replace">Replace</button><button type="button" class="btn quiet" data-knowledge-action="token" data-state="remove">Remove</button><button type="button" class="btn quiet" data-knowledge-action="token" data-state="keep" data-token-undo hidden>Undo</button></span></div><div class="knowledge-secret-edit" hidden><input class="ctl" id="knowledge-token" name="token" type="password" autocomplete="new-password" placeholder="New token"><button type="button" class="btn quiet" data-knowledge-action="token" data-state="keep">Undo</button></div><input type="hidden" name="tokenAction" value="keep">`
      : `<input class="ctl" id="knowledge-token" name="token" type="password" autocomplete="new-password"><input type="hidden" name="tokenAction" value="set">`;
    const key = source?.deployKey ?? '';
    return `<h2>${connected ? 'Edit repository' : 'Connect repository'}</h2>
      <form novalidate class="knowledge-form" data-knowledge-form>
        <div class="field">${label('knowledge-url', 'Repository URL', 'HTTPS or SSH')}<input class="ctl" id="knowledge-url" name="url" required autocomplete="off" spellcheck="false" value="${esc(source?.url ?? '')}" placeholder="https://git.example.com/team/docs.git" autofocus></div>
        <div class="field-row"><div class="field"><label for="knowledge-branch">Branch</label><input class="ctl" id="knowledge-branch" name="branch" required autocomplete="off" spellcheck="false" value="${esc(source?.branch ?? 'main')}"></div><div class="field"><label for="knowledge-folder">Folder<span class="optional-mark">Optional</span></label><input class="ctl" id="knowledge-folder" name="folder" autocomplete="off" spellcheck="false" value="${esc(connected ? source.folder : 'docs')}" placeholder="Repository root"></div></div>
        <div class="field" data-access="https"${ssh ? ' hidden' : ''}>${label('knowledge-token', 'Access token', saved ? '' : 'Private repositories only')}${token}</div>
        <div class="field" data-access="ssh"${ssh ? '' : ' hidden'}>${label('knowledge-key', 'Deploy key', 'Add to the repository, read-only')}<div class="knowledge-key"><input class="ctl" id="knowledge-key" readonly value="${esc(key)}" placeholder="Creating key…"><button type="button" class="btn" data-knowledge-action="copy-key">Copy</button></div></div>
        <div class="modal-actions">${connected ? '<button type="button" class="btn danger knowledge-disconnect" data-knowledge-action="disconnect">Disconnect</button>' : ''}<button type="button" class="btn quiet" data-action="closeOverlays">Cancel</button><button type="submit" class="btn primary">${connected ? 'Save' : 'Connect'}</button></div>
      </form>`;
  }

  /** A saved token is never shown again: keep it, replace it with a new one, or remove it. */
  function setTokenState(/** @type {HTMLFormElement} */ form, /** @type {string} */ state) {
    const row = /** @type {HTMLElement|null} */ (form.querySelector('.knowledge-secret')), edit = /** @type {HTMLElement|null} */ (form.querySelector('.knowledge-secret-edit'));
    const input = /** @type {HTMLInputElement|null} */ (form.elements.namedItem('token')), action = /** @type {HTMLInputElement|null} */ (form.elements.namedItem('tokenAction'));
    if (!row || !edit || !input || !action) return;
    action.value = state; row.hidden = state === 'replace'; edit.hidden = state !== 'replace'; row.dataset.tokenState = state;
    const labelText = row.querySelector('[data-token-label]'); if (labelText) labelText.textContent = state === 'remove' ? 'Token will be removed' : 'Token saved';
    for (const button of row.querySelectorAll('[data-knowledge-action="token"]')) /** @type {HTMLElement} */ (button).hidden = button.hasAttribute('data-token-undo') ? state !== 'remove' : state === 'remove';
    if (state === 'replace') input.focus();
    else { input.value = ''; /** @type {HTMLElement|null} */ (row.querySelector(state === 'remove' ? '[data-token-undo]' : '[data-state="replace"]'))?.focus(); }
  }

  /** The URL decides the access method: an access token over HTTPS, a deploy key over SSH. */
  function accessFor(/** @type {HTMLFormElement} */ form) {
    const ssh = transportOf(/** @type {HTMLInputElement} */ (form.elements.namedItem('url')).value) === 'ssh';
    for (const section of form.querySelectorAll('[data-access]')) /** @type {HTMLElement} */ (section).hidden = section.getAttribute('data-access') !== (ssh ? 'ssh' : 'https');
    const keyInput = /** @type {HTMLInputElement|null} */ (form.querySelector('#knowledge-key'));
    if (ssh && keyInput && !keyInput.value) void ensureDeployKey(keyInput);
  }

  function ensureDeployKey(/** @type {HTMLInputElement} */ input) {
    const projectId = context().projectId;
    if (deployKeyRequest || !projectId) return deployKeyRequest;
    deployKeyRequest = runtime.commands.execute('knowledge.deploy-key.create', { projectId })
      .then((/** @type {any} */ result) => { const key = result?.entities?.[0]?.publicKey; if (key && input.isConnected && !input.value) input.value = key; void load(projectId, { background: true }); })
      .catch((/** @type {unknown} */ error) => { if (input.isConnected) input.placeholder = errorText(error, 'The deploy key could not be created.'); })
      .finally(() => { deployKeyRequest = null; });
    return deployKeyRequest;
  }

  function fieldError(/** @type {HTMLFormElement} */ form, /** @type {string} */ name, /** @type {string} */ message) {
    if (app()?.fieldError) app().fieldError(form, name, message);
    else { /** @type {HTMLElement|null} */ (form.querySelector(`[name="${name}"]`))?.focus(); toast(message, 'error'); }
    return false;
  }

  async function submit(/** @type {HTMLFormElement} */ form) {
    const projectId = context().projectId, source = viewOf(projectId)?.source ?? null;
    if (!projectId || !isAdmin()) return;
    const value = (/** @type {string} */ name) => String(/** @type {HTMLInputElement|null} */ (form.elements.namedItem(name))?.value ?? '').trim();
    const url = value('url'), branch = value('branch'), folder = value('folder'), token = value('token'), tokenAction = value('tokenAction') || 'set';
    const transport = transportOf(url);
    if (!transport) return fieldError(form, 'url', 'Enter an HTTPS or SSH Git URL.');
    if (!branch) return fieldError(form, 'branch', 'Enter a valid branch name.');
    if (folder.split('/').includes('..')) return fieldError(form, 'folder', 'Use a folder inside the repository.');
    if (transport === 'https' && source?.hasToken && tokenAction === 'replace' && !token) return fieldError(form, 'token', 'Enter the new token.');
    // A saved token is sent only to the host it was entered for.
    if (transport === 'https' && source?.hasToken && tokenAction === 'keep' && originOf(url) !== originOf(source.url)) { setTokenState(form, 'replace'); return fieldError(form, 'token', MOVED_TOKEN); }
    let operation, payload, options = {};
    if (!source) {
      operation = 'knowledge.connect';
      payload = { projectId, url, branch, folder, ...(transport === 'https' && token ? { token } : {}) };
    } else {
      const action = transport === 'ssh' ? 'remove' : tokenAction === 'set' ? (token ? 'replace' : 'keep') : tokenAction;
      if (url === source.url && branch === source.branch && folder.replace(/^\/+|\/+$/g, '') === source.folder && (action === 'keep' || (action === 'remove' && !source.hasToken))) { app()?.closeOverlays?.(); return; }
      operation = 'knowledge.update';
      payload = { projectId, url, branch, folder, tokenAction: action, ...(action === 'replace' ? { token } : {}) };
      options = { expectedRevision: source.revision };
    }
    const button = /** @type {HTMLButtonElement|null} */ (form.querySelector('button[type="submit"]'));
    if (button) button.disabled = true;
    try {
      await runtime.commands.execute(operation, payload, options);
    } catch (error) {
      if (button?.isConnected) button.disabled = false;
      const feedback = actionErrorFeedback(error), field = /** @type {any} */ (error)?.details?.field;
      const message = /** @type {any} */ (error)?.details?.message ?? '';
      if (/** @type {any} */ (error)?.code === 'validation_failed' && field in FIELD_ERRORS) return fieldError(form, field, FIELD_ERRORS[/** @type {keyof typeof FIELD_ERRORS} */ (field)](String(message)));
      if (/** @type {any} */ (error)?.code === 'revision_conflict') { void load(projectId, { background: true }); return toast('Someone else changed this connection. Review it and save again.', 'error'); }
      if (!feedback.silent) toast(feedback.message || errorText(error), 'error');
      return;
    }
    toast(source ? 'Knowledge base saved' : 'Repository connected');
    cache.delete(projectId);
    if (!completeForm(form, () => app()?.closeOverlays?.())) { void load(projectId, { background: true }); return; }
    S.mode = 'tree'; S.path = ''; S.section = '';
    const target = routeHash(projectId);
    if (windowObject.location.hash === target) { app()?.refresh?.(); void load(projectId); }
    else windowObject.location.hash = target;
  }

  function disconnect() {
    const projectId = context().projectId, source = viewOf(projectId)?.source;
    if (!projectId || !source || !isAdmin()) return;
    const form = documentObject.querySelector('form[data-knowledge-form]');
    app()?.confirm?.({
      title: 'Disconnect repository?',
      text: 'Knowledge will be hidden in oneloop until a repository is connected again. The repository and its history stay untouched.',
      action: 'Disconnect',
      confirm: () => runtime.commands.execute('knowledge.disconnect', { projectId }, { expectedRevision: source.revision })
        .then(() => { completeForm(form, () => app()?.closeOverlays?.()); toast('Repository disconnected'); cache.delete(projectId); void load(projectId); repaint(projectId); })
        .catch((/** @type {unknown} */ error) => toast(errorText(error), 'error')),
    });
  }

  function retry() {
    const projectId = S.projectId ?? context().projectId;
    if (!projectId || !isAdmin()) return;
    runtime.commands.execute('knowledge.sync', { projectId })
      .then(() => load(projectId, { background: true }))
      .catch((/** @type {unknown} */ error) => toast(errorText(error), 'error'));
  }

  async function copy(/** @type {string} */ text, /** @type {string} */ done) {
    try { await windowObject.navigator.clipboard.writeText(text); toast(done); }
    catch { toast('Copy failed. Select the text and copy it.', 'error'); }
  }

  // ---------- events ----------

  const inKnowledge = () => context().view === 'knowledge';

  // Capture: the app's dialogs stop clicks from bubbling out of them.
  documentObject.addEventListener('click', (event) => {
    const target = /** @type {Element|null} */ (isElement(event.target) ? event.target : null);
    const control = /** @type {HTMLElement|null} */ (target?.closest('[data-knowledge-action]') ?? null);
    if (control && !control.matches(':disabled')) {
      const action = control.getAttribute('data-knowledge-action'), form = /** @type {HTMLFormElement|null} */ (control.closest('form[data-knowledge-form]'));
      if (action === 'home') { windowObject.location.hash = routeHash(String(S.projectId)); return; }
      if (action === 'reload') { const projectId = context().projectId; if (projectId) { cache.delete(projectId); app()?.refresh?.(); void load(projectId); } return; }
      if (action === 'retry') return retry();
      if (action === 'full-view') return fullView(control.getAttribute('data-path') ?? '');
      if (action === 'copy-section') return void copy(windowObject.location.origin + windowObject.location.pathname + routeHash(String(S.projectId), S.mode, S.path, control.getAttribute('data-section') ?? ''), 'Link copied');
      if (action === 'scope') { S.scope = /** @type {any} */ (control.getAttribute('data-scope') ?? 'all'); paintFinder(); /** @type {HTMLElement|null} */ (documentObject.querySelector('.knowledge-scope [aria-selected="true"]'))?.focus(); return; }
      if (action === 'clear-query') { const input = /** @type {HTMLInputElement|null} */ (documentObject.querySelector('[data-knowledge-search]')); if (input) input.value = ''; search(''); input?.focus(); return; }
      if (action === 'cancel-search') return closeFinder(false);
      if (action === 'token' && form) return setTokenState(form, control.getAttribute('data-state') ?? 'keep');
      if (action === 'copy-key') { const key = /** @type {HTMLInputElement|null} */ (documentObject.getElementById('knowledge-key'))?.value; if (key) void copy(key, 'Deploy key copied'); return; }
      if (action === 'disconnect') return disconnect();
      return;
    }
    // A click outside the search field and results closes them.
    if (S.finding && inKnowledge() && target?.isConnected && !target.closest('.knowledge-toolbar,.knowledge-finder,.file-overlay,.modal')) closeFinder(false);
  }, true);

  documentObject.addEventListener('focusin', (event) => {
    const target = /** @type {Element|null} */ (isElement(event.target) ? event.target : null);
    if (target?.matches('[data-knowledge-search]') && !S.finding && !S.suppressFocus) openFinder();
  });

  documentObject.addEventListener('input', (event) => {
    const target = /** @type {HTMLInputElement|null} */ (event.target instanceof view.HTMLInputElement ? event.target : null);
    if (target?.matches('[data-knowledge-search]')) { search(target.value); return; }
    const form = /** @type {HTMLFormElement|null} */ (target?.closest('form[data-knowledge-form]') ?? null);
    if (form) accessFor(form);
  });

  documentObject.addEventListener('submit', (event) => {
    const candidate = /** @type {HTMLFormElement} */ (event.target);
    const form = candidate instanceof view.HTMLFormElement && candidate.matches('[data-knowledge-form]') ? candidate : null;
    if (!form) return;
    event.preventDefault();
    void submit(form);
  });

  documentObject.addEventListener('keydown', (event) => {
    const target = /** @type {Element|null} */ (isElement(event.target) ? event.target : null);
    if (event.isComposing || event.repeat) return;
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && inKnowledge() && !target?.closest('input,textarea,select,[contenteditable="true"]') && !documentObject.querySelector('.file-overlay,.modal,.confirmation-layer')) {
      const input = /** @type {HTMLInputElement|null} */ (documentObject.querySelector('[data-knowledge-search]'));
      if (input) { event.preventDefault(); input.focus(); }
      return;
    }
    if (target?.matches('[data-knowledge-search]')) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFinder(); return; }
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        event.preventDefault(); if (!S.finding) openFinder();
        const first = /** @type {HTMLElement|null} */ (documentObject.querySelector('.knowledge-finder [data-knowledge-hit]'));
        if (event.key === 'Enter' && first) first.click(); else first?.focus();
      }
      return;
    }
    if (!target?.closest('.knowledge-finder')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFinder(); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !target.matches('[data-knowledge-hit]')) return;
    event.preventDefault();
    const hits = [...documentObject.querySelectorAll('.knowledge-finder [data-knowledge-hit]')], next = hits.indexOf(target) + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) /** @type {HTMLElement|null} */ (documentObject.querySelector('[data-knowledge-search]'))?.focus();
    else /** @type {HTMLElement|undefined} */ (hits[Math.min(next, hits.length - 1)])?.focus();
  });

  const controller = Object.freeze({
    route,
    render,
    topbar: () => '<h1>Knowledge base</h1>',
    beforeRender,
    mount,
    settingsHtml,
    modalHtml,
    /** For the view bridge: invalidate cached views after access changes. */
    clear() { cache.clear(); recents.clear(); texts.clear(); },
  });
  Reflect.set(view, 'OneloopKnowledge', controller);
  return controller;
}
