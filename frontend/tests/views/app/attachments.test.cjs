// views/app/attachments.js: attachments, their previews, retention, drag and drop and limits.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor, settle } = require('../../support/dom.cjs');
const { ApiError } = require('../../../src/data/api-client.js');
const { createReadController } = require('../../../src/data/read-controller.js');

const receipt = '<style>h1{color:blue}</style><h1>Receipt</h1><script>parent.evil=true</script><img src="https://example.invalid/pixel" onerror="alert(1)"><a href="https://example.invalid">Leave</a><iframe srcdoc="bad"></iframe><meta http-equiv="refresh" content="0;url=https://example.invalid"><form action="https://example.invalid"><input value="Visible field"><button>Submit</button></form>';

/** An attachment as the server lists it. */
const serverFile = (id, name, previewKind, overrides = {}) => ({ id, name, size: 10, mediaType: 'application/octet-stream', previewKind, isEphemeral: false, uploadedBy: 'taylorwu', uploadedAt: 1, lastAccessedAt: 1, state: 'available', revision: 1, contentUrl: `/content/${id}`, sourceUrl: `/source/${id}`, downloadUrl: `/download/${id}`, ...overrides });

/** Send the live hint of a change to the files of BIR-079 made elsewhere, as the event stream does. */
const filesChanged = t => t.events.at(-1).emit('hint', { kind: 'activity.changed', projectId: 'p1', taskId: 'bir-079', entityType: 'attachment', entityId: 'changed-file' });

/** A task page whose server lists `files`; `contents` maps a file's source address to its text. */
async function withServerFiles(files, contents = {}, options = {}) {
  const t = bootApp({ route: 'task/BIR-079', api: { attachments: async () => ({ items: files }) }, setup: w => { w.fetch = async url => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(contents[url] ?? '').buffer }); }, ...options });
  const task = t.D.tasks.find(item => item.id === 'BIR-079');
  await waitFor(() => (task.attachments || []).length === files.length, 'the server lists the files');
  return { ...t, task };
}

/** A task page with an HTML receipt and a text file. */
async function withFiles() {
  const t = await withServerFiles([serverFile('receipt', 'receipt-preview.html', 'html'), serverFile('notes', 'notes.txt', 'text')], { '/source/receipt': receipt, '/source/notes': 'notes' });
  return { ...t, file: t.task.attachments[0], other: t.task.attachments[1] };
}

/** Add an image attachment record and repaint the task. */
function withImage(t) {
  const image = { id: 'image', name: 'image.png', size: 10, type: 'image/png', previewKind: 'image', ephemeral: false, state: 'available', revision: 1, url: '/content/image', contentUrl: '/content/image', downloadUrl: '/download/image' };
  t.task.attachments.push(image); t.A.refresh();
  return image;
}
/** Settle the last waiting call of the API's `method` with `value`. */
const answerLast = (t, method, value) => { t.calls.filter(call => call.method === method && !call.settled).at(-1).resolve(value); return settle(); };

const withoutBoardAccess = t => {
  t.D.users.find(u => u.id === 'taylorwu').admin = false;
  t.D.projects[0].members.find(m => m.userId === 'taylorwu').permissions = [];
};

test('HTML attachments keep their file name and preview in an isolated sandbox with a source view', async () => {
  const { d, A, task, file } = await withFiles();
  assert.equal(file.name, 'receipt-preview.html');
  assert(task.attachments.every(f => f.ephemeral === false)); assert(!d.querySelector('[name=uploadEphemeral]'));
  assert(d.querySelector('.attachment-title').textContent === 'receipt-preview.html'); assert(d.querySelector('.attachment-thumbnail').getAttribute('aria-label').includes('Preview'));
  assert(!d.querySelector('.file-preview-action')); assert(d.querySelector('.file-download').textContent.includes('Download'));
  // The server's preview address serves the page under its sandbox policy.
  file.htmlPreviewUrl = '/api/attachments/receipt/preview/html';
  A.previewAttachment(task.id, file.id);
  await waitFor(() => d.querySelector('.html-preview'), 'the preview loads');
  let frame = d.querySelector('.html-preview');
  assert.equal(frame.getAttribute('sandbox'), ''); assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(new URL(frame.src).pathname, '/api/attachments/receipt/preview/html');
  assert(d.querySelector('.file-info').hidden);
  const detailsButton = d.querySelector('[data-file-details]');
  detailsButton.click(); assert(!d.querySelector('.file-info').hidden); assert.equal(detailsButton.getAttribute('aria-expanded'), 'true'); assert.equal(d.querySelector('.html-preview'), frame);
  detailsButton.click(); assert(d.querySelector('.file-info').hidden);
  d.querySelector('[data-html-source]').click(); assert(!frame.isConnected); assert(d.querySelector('.document-preview').hidden);
  assert(d.querySelector('.html-source').textContent.includes('<script>')); assert(!d.querySelector('.html-source script'));
  d.querySelector('[data-html-rendered]').click(); frame = d.querySelector('.html-preview'); assert(!frame.closest('.document-preview').hidden);
  assert(!d.querySelector('#attachment-display-name')); assert.equal(d.querySelector('[data-file-download]').download, 'receipt-preview.html'); assert.equal(d.querySelector('#file-preview-title').textContent, 'receipt-preview.html');
});

test('retention switches change one file and keep focus and an open reply', async () => {
  const t = await withFiles();
  const { d, A, task, file, other } = t;
  const retentionSaves = () => JSON.parse(JSON.stringify(t.calls.filter(call => call.method === 'updateAttachment').map(call => call.args)));
  A.previewAttachment(task.id, file.id);
  A.setAttachmentTemporary(task.id, file.id, true); assert(file.ephemeral); assert.equal(other.ephemeral, false); assert.equal(d.querySelector('[data-file-ephemeral]').getAttribute('aria-checked'), 'true');
  assert.deepEqual(retentionSaves(), [['receipt', { isEphemeral: true, expectedRevision: 1 }]]);
  await answerLast(t, 'updateAttachment', serverFile('receipt', 'receipt-preview.html', 'html', { isEphemeral: true, revision: 2 }));
  d.querySelector('[data-file-close]').click();
  const image = withImage(t);
  const retention = d.querySelector(`[data-attachment-id="${image.id}"] .retention-switch`); retention.focus();
  A.setAttachmentTemporary(task.id, image.id, true);
  assert.strictEqual(d.querySelector(`[data-attachment-id="${image.id}"] .retention-switch`), retention); assert.equal(d.activeElement, retention); assert.equal(retention.getAttribute('aria-checked'), 'true');
  await answerLast(t, 'updateAttachment', serverFile('image', 'image.png', 'image', { isEphemeral: true, revision: 2 }));
  A.setAttachmentTemporary(task.id, image.id, false); assert.equal(d.querySelector(`[data-attachment-id="${image.id}"] .retention-switch`).getAttribute('aria-checked'), 'false');
  await answerLast(t, 'updateAttachment', serverFile('image', 'image.png', 'image', { revision: 3 }));
  (task.comments ||= []).push({ id: 'retention-reply-root', who: 'taylorwu', ts: Date.now(), text: 'Keep this conversation', mentions: [], parentId: null }); A.refresh();
  A.replyComment(task.id, 'retention-reply-root');
  const replyInput = d.getElementById('cmtIn'); replyInput.value = 'Unsent reply stays here'; replyInput.focus();
  A.setAttachmentTemporary(task.id, image.id, true);
  assert.strictEqual(d.getElementById('cmtIn'), replyInput); assert.equal(replyInput.value, 'Unsent reply stays here'); assert.equal(d.activeElement, replyInput);
});

test('each click on an attachment row\'s Temporary switch changes it once', async () => {
  const t = await withServerFiles([serverFile('notes', 'notes.txt', 'text')], {}, { actions: true });
  const retention = () => t.d.querySelector('[data-attachment-id="notes"] .retention-switch'), saves = () => t.calls.filter(call => call.method === 'updateAttachment');
  for (const [index, expected] of [true, false, true].entries()) {
    retention().click();
    assert.equal(saves().length, index + 1); assert.equal(saves().at(-1).args[1].isEphemeral, expected); assert.equal(retention().getAttribute('aria-checked'), String(expected));
    await answerLast(t, 'updateAttachment', serverFile('notes', 'notes.txt', 'text', { isEphemeral: expected, revision: index + 2 }));
  }
});

test('Office and binary files are download-only and images show a thumbnail', async () => {
  const t = await withFiles();
  const { w, d, A, task } = t;
  const downloads = []; w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  for (const ext of ['docx', 'xlsx', 'pptx', 'zip', 'exe']) {
    const office = { id: ext, name: 'report.' + ext, size: 4, url: 'blob:sample' }; task.attachments.push(office);
    A.previewAttachment(task.id, office.id); assert(!d.querySelector('.file-dialog')); assert.equal(downloads.at(-1), office.name);
  }
  withImage(t);
  assert(d.querySelector('.attachment-thumbnail img'));
});

test('file details show the upload time and a positioned retention tooltip that dismisses', async () => {
  const t = await withFiles();
  const { w, d, A, task } = t;
  const image = withImage(t);
  image.uploadedAt = new Date('2025-06-06T23:00:21Z').getTime(); A.previewAttachment(task.id, image.id);
  assert.match(d.querySelector('.file-info').textContent, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/); assert(!d.querySelector('.file-retention-note'));
  d.querySelector('[data-file-details]').click();
  const help = d.querySelector('.retention-help button');
  help.getBoundingClientRect = () => ({ left: 940, right: 968, top: 600, bottom: 628, width: 28, height: 28 });
  d.querySelector('.file-info').getBoundingClientRect = () => ({ top: 100, bottom: 750, height: 650 });
  Object.defineProperties(d.querySelector('#retention-help-text'), { offsetWidth: { value: 240 }, offsetHeight: { value: 61 } });
  help.click(); assert.equal(help.getAttribute('aria-expanded'), 'true'); assert(d.querySelector('[role=tooltip]').textContent.includes('storage is low'));
  const tip = d.querySelector('#retention-help-text'); assert(!tip.closest('.file-info')); assert.equal(tip.style.left, '728px'); assert.equal(tip.style.top, '636px');
  help.getBoundingClientRect = () => ({ left: 940, right: 968, top: 720, bottom: 748, width: 28, height: 28 }); w.dispatchEvent(new w.Event('resize')); assert.equal(tip.style.top, '651px');
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert(tip.hidden); assert(d.querySelector('.file-dialog'));
  help.click(); d.querySelector('[data-file-retention]').dispatchEvent(new w.Event('pointerdown', { bubbles: true })); assert(tip.hidden);
  help.click(); d.querySelector('[data-file-details]').click(); assert(tip.hidden);
  d.querySelector('[data-file-close]').click(); assert(!tip.isConnected);
});

test('image previews fit every size without upscaling and zoom only on modified wheel or buttons', async () => {
  const t = await withFiles();
  const { w, d, A, task } = t;
  const image = withImage(t);
  A.previewAttachment(task.id, image.id);
  const stage = d.querySelector('.image-stage'), img = stage.querySelector('img');
  Object.defineProperties(stage, { clientWidth: { value: 800, configurable: true }, clientHeight: { value: 500, configurable: true } });
  for (const [width, height] of [[16, 16], [12000, 8000], [100, 12000], [12000, 100]]) {
    Object.defineProperties(img, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true } }); img.onload();
    assert(parseFloat(img.style.width) <= 752); assert(parseFloat(img.style.height) <= 452); assert(parseFloat(img.style.width) <= width); assert(!d.querySelector('.image-canvas').hidden);
  }
  const wheel = (target, options = {}) => { const event = new w.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true, ...options }); target.dispatchEvent(event); return event; };
  const fitted = parseFloat(img.style.width);
  assert(!wheel(stage).defaultPrevented); assert.equal(parseFloat(img.style.width), fitted);
  assert(wheel(stage, { ctrlKey: true }).defaultPrevented); assert(parseFloat(img.style.width) > fitted);
  assert(wheel(stage, { metaKey: true, deltaY: 100 }).defaultPrevented); assert.equal(parseFloat(img.style.width), fitted);
  assert(!wheel(stage, { ctrlKey: true, deltaY: 0, deltaX: 100 }).defaultPrevented); assert(!wheel(d.querySelector('.file-info'), { ctrlKey: true }).defaultPrevented);
  assert(wheel(stage, { metaKey: true, deltaMode: 1, deltaY: -3 }).defaultPrevented); assert(parseFloat(img.style.width) > fitted); d.querySelector('[data-image-fit]').click();
  for (let i = 0; i < 30; i++) wheel(stage, { ctrlKey: true, deltaY: -10000 });
  assert(d.querySelector('[data-image-in]').disabled); assert(wheel(stage, { ctrlKey: true }).defaultPrevented);
  for (let i = 0; i < 30; i++) wheel(stage, { metaKey: true, deltaMode: 2, deltaY: 1 });
  assert(d.querySelector('[data-image-out]').disabled); d.querySelector('[data-image-fit]').click();
  for (let i = 0; i < 20; i++) d.querySelector('[data-image-in]').click();
  assert(d.querySelector('[data-image-in]').disabled); d.querySelector('[data-image-fit]').click(); assert(!d.querySelector('[data-image-in]').disabled);
  img.onerror(); assert(stage.textContent.includes('could not be displayed')); assert(d.querySelector('[data-image-in]').disabled); assert(d.querySelector('[data-file-download]'));
  d.querySelector('[data-file-close]').click(); assert(!d.querySelector('#app').inert); assert(!wheel(stage, { ctrlKey: true }).defaultPrevented);
});

test('retention changes require board access while previews stay readable', async () => {
  const t = await withFiles();
  const { d, A, task, file } = t;
  withoutBoardAccess(t);
  assert.equal(A.setAttachmentTemporary(task.id, file.id, true), false);
  file.htmlPreviewUrl = '/api/attachments/receipt/preview/html';
  A.previewAttachment(task.id, file.id); assert(!d.querySelector('#attachment-display-name')); assert(!d.querySelector('[data-file-ephemeral]')); await waitFor(() => d.querySelector('.html-preview'), 'the preview loads');
  assert(!d.querySelector('.attachment-count')); assert(!d.querySelector('.file-history'));
});

test('a file cleaned up for space keeps its place as a disabled tombstone', async () => {
  const { d, A, task, other } = await withFiles();
  const order = task.attachments.map(f => f.id).join(',');
  // As the server lists a temporary file that storage cleanup removed.
  other.state = 'cleaned'; A.refresh();
  assert.equal(task.attachments.map(f => f.id).join(','), order);
  const cleaned = d.querySelector(`[data-attachment-id="${other.id}"]`);
  assert(cleaned.textContent.includes('Cleaned up')); assert(!cleaned.querySelector('a')); assert(cleaned.querySelector('.file-download').disabled); assert(!cleaned.querySelector('[role=switch]'));
  A.previewAttachment(task.id, other.id); assert(!d.querySelector('.file-dialog'));
});

test('legacy bidirectional file names are isolated in rows and activity', () => {
  const { d, A, D } = bootApp({ route: 'task/BIR-079' });
  const task = D.tasks.find(item => item.id === 'BIR-079');
  const legacy = { id: 'legacy-bidi', name: 'Invoice‮fdp.exe', size: 4, url: 'blob:legacy', state: 'available' };
  (task.attachments ||= []).push(legacy); (task.activity ||= []).push({ id: 'legacy-bidi-activity', who: 'taylorwu', ts: Date.now(), text: 'attached ' + legacy.name }); A.refresh();
  const row = d.querySelector('[data-attachment-id="legacy-bidi"]');
  assert(row); assert.equal(row.querySelector('.attachment-title').dataset.tip, 'Invoicefdp.exe'); assert(row.querySelector('bdi.attachment-name-base'));
  assert(!row.outerHTML.includes('‮')); assert(!d.querySelector('.timeline').textContent.includes('‮'));
});

test('files with duplicate names stay separate attachments with download links', async () => {
  const t = await withServerFiles([serverFile('first', 'example.csv', 'text'), serverFile('second', 'example.csv', 'text')]);
  assert.deepEqual([...t.d.querySelectorAll('a.file-download[download="example.csv"]')].map(link => link.getAttribute('href')), ['/download/first', '/download/second']);
});

test('a task holds at most 25 files, uploads them as permanent and previews text safely', async () => {
  const t = await withServerFiles(Array.from({ length: 24 }, (_, i) => serverFile('existing' + i, 'existing.txt', null)), { '/source/sample': 'name,value\n"hello, world",<script>' });
  const { w, d, A, task } = t;
  A.attachFiles(task.id, { files: [new w.File(['name,value\n"hello, world",<script>'], 'sample.txt', { type: 'text/plain' })], value: '' });
  const upload = t.calls.find(call => call.method === 'uploadAttachment'); assert.equal(upload.args[1].ephemeral, false);
  upload.resolve(serverFile('sample', 'sample.txt', 'text')); await settle();
  assert.equal(d.querySelectorAll('.attachment-card').length, 25);
  A.previewAttachment(task.id, 'sample');
  await waitFor(() => d.querySelector('.file-preview-content pre'), 'the text loads');
  assert(d.querySelector('.file-preview-content pre').textContent.includes('hello, world')); assert(!d.querySelector('.file-preview-content script'));
  d.querySelector('[data-file-close]').click();
  A.attachFiles(task.id, { files: [new w.File(['x'], 'overflow.txt', { type: 'text/plain' })], value: '' });
  assert(d.querySelector('.upload-state').textContent.includes('25 available')); assert.equal(t.calls.filter(call => call.method === 'uploadAttachment').length, 1);
});

/** Dispatch a drag event with a synthetic DataTransfer. */
function drag(w, type, target, files = [], items = [], types = ['Files']) {
  const event = new w.Event(type, { bubbles: true, cancelable: true }), transfer = { types, files, items, dropEffect: '' };
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  target.dispatchEvent(event);
  return { event, transfer };
}

test('file drops, drag targets, folders, access, limits and overlays share one upload path', async () => {
  const t = await withServerFiles([]), { w, d, A, D, task } = t, notices = []; A.toast = (text, kind) => notices.push({ text, kind });
  const uploads = () => t.calls.filter(call => call.method === 'uploadAttachment');
  /** The server stores every upload still on its way. */
  const store = async () => { for (const call of uploads().filter(item => !item.settled)) { const name = call.args[1].file.name; call.resolve(serverFile(`${name}-${uploads().indexOf(call)}`, name, 'text')); } await settle(); };
  const zone = () => d.querySelector('.task-attachments');
  assert.equal(zone().dataset.uploadTask, task.id); assert(zone().querySelector(':scope > button.attachment-dropzone')); assert.equal(zone().querySelectorAll('button.attachment-dropzone').length, 1);
  assert(!zone().querySelector('h2 button')); assert(!zone().querySelector('.attachment-empty')); assert(!zone().querySelector('.attachment-dropzone.is-compact'));
  const uploaderMarkup = zone().querySelector('.attachment-dropzone').innerHTML;
  const over = drag(w, 'dragover', zone().querySelector('h2'));
  assert(over.event.defaultPrevented); assert.equal(over.transfer.dropEffect, 'copy'); assert(zone().classList.contains('is-file-dragover')); assert(zone().querySelector('.attachment-drop-title').textContent.includes('Release'));
  const a = new w.File(['hello'], 'hello.txt'), b = new w.File(['world'], 'world.md');
  const drop = drag(w, 'drop', zone().querySelector('h2'), [a, b]);
  assert(drop.event.defaultPrevented); assert(!zone().classList.contains('is-file-dragover'));
  assert.deepEqual(uploads().map(call => [call.args[1].file.name, call.args[1].ephemeral]), [['hello.txt', false], ['world.md', false]]);
  await store(); assert.equal(task.attachments.length, 2);
  assert(zone().querySelector('.attachment-dropzone.is-compact')); assert.equal(zone().querySelector('.attachment-dropzone').innerHTML, uploaderMarkup);
  drag(w, 'dragover', zone()); assert(zone().classList.contains('is-file-dragover')); drag(w, 'dragover', d.querySelector('.tp-title')); assert(!zone().classList.contains('is-file-dragover'));
  const count = task.attachments.length; drag(w, 'drop', d.querySelector('.tp-title'), [a]); assert.equal(uploads().length, 2); assert(notices.at(-1).text.includes('attachment section'));
  assert(!drag(w, 'dragover', zone(), [], [], ['text/plain']).event.defaultPrevented); assert(!drag(w, 'drop', zone(), [], [], ['text/plain']).event.defaultPrevented);
  const folder = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => new w.File([], 'folder') }, file = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => a };
  drag(w, 'drop', zone(), [a], [folder, file]);
  await waitFor(() => uploads().length === 3, 'only the file inside the drop is sent');
  assert(notices.some(n => n.text.includes('Folders are not supported'))); await store(); assert.equal(task.attachments.length, count + 1);
  drag(w, 'drop', zone(), [new w.File([new Uint8Array(26 * 1024 * 1024)], 'too-large.zip')]);
  await waitFor(() => d.querySelector('.upload-state')?.textContent.includes('exceeds 25 MB'), 'the size limit is reported');
  assert.equal(uploads().length, 3);
  drag(w, 'dragover', zone()); D.users.find(u => u.id === 'taylorwu').admin = false; D.projects[0].members.find(m => m.userId === 'taylorwu').permissions = [];
  drag(w, 'drop', zone(), [a]); assert(!zone().classList.contains('is-file-dragover')); assert.equal(uploads().length, 3); assert(notices.at(-1).text.includes('permission'));
  assert.equal(drag(w, 'dragover', zone()).transfer.dropEffect, 'none');
  const protectedOrder = task.attachments.map(f => f.id);
  assert.equal(A.reorderAttachment(task.id, protectedOrder[0], protectedOrder[1], true), false); assert.deepEqual(task.attachments.map(f => f.id), protectedOrder);
  D.users.find(u => u.id === 'taylorwu').admin = true; A.openModal('task'); drag(w, 'drop', zone(), [a]); assert.equal(uploads().length, 3); A.closeOverlays();
  task.attachments = Array.from({ length: 24 }, (_, i) => ({ id: 'existing' + i, name: 'existing.txt', size: 1, state: 'available' })); A.refresh();
  drag(w, 'drop', zone(), [a, b]);
  await waitFor(() => uploads().length === 4, 'the drop fills the last slot');
  assert([...d.querySelectorAll('.upload-state')].some(el => el.textContent.includes('25 available')));
  task.attachments = []; A.refresh(); assert(!zone().querySelector('.attachment-dropzone.is-compact'));
  A.nav('board'); assert(drag(w, 'drop', d.body, [a]).event.defaultPrevented); assert(notices.at(-1).text.includes('Open a task'));
});

test('attachment order is shared by keyboard and pointer moves, which Escape and leaving cancel', async () => {
  const t = await withServerFiles([serverFile('hello', 'hello.txt', 'text'), serverFile('world', 'world.md', 'markdown'), serverFile('third', 'third.txt', 'text')]);
  const { w, d, A, task } = t;
  const order = () => task.attachments.map(f => f.id), moves = () => t.calls.filter(call => call.method === 'reorderAttachment');
  /** The server keeps the order the page sent. */
  const keep = () => answerLast(t, 'reorderAttachment', { items: order().map(id => serverFile(id, task.attachments.find(f => f.id === id).name, 'text')) });
  const zone = () => d.querySelector('.task-attachments');
  const original = order(), grip = () => d.querySelector(`[data-reorder-file="${original[0]}"]`);
  grip().focus(); grip().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); assert.equal(task.attachments.at(-1).id, original[0]); assert.equal(d.activeElement.dataset.reorderFile, original[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(moves()[0].args)), ['bir-079', { attachmentId: 'hello', targetId: 'third', after: true, expectedRevision: 1, idempotencyKey: moves()[0].args[1].idempotencyKey }]); await keep();
  assert.equal(d.activeElement, grip(), 'the moved file keeps focus once the server confirms its place, so the arrow keys go on moving it');
  grip().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })); assert.deepEqual(order(), original); await keep();
  const pointer = (type, target, x, y) => { const event = new w.Event(type, { bubbles: true, cancelable: true }); for (const [key, value] of Object.entries({ button: 0, pointerId: 1, clientX: x, clientY: y })) Object.defineProperty(event, key, { value }); target.dispatchEvent(event); };
  const geometry = () => { zone().getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 500 }); [...zone().querySelectorAll('[data-attachment-id]')].forEach((row, i) => row.getBoundingClientRect = () => ({ left: 0, right: 600, top: 100 + i * 100, bottom: 190 + i * 100, width: 600, height: 90 })); };
  geometry(); pointer('pointerdown', grip(), 20, 120); pointer('pointermove', d, 20, 370); assert(d.querySelector('.sort-marker')); pointer('pointerup', d, 20, 370);
  assert.equal(task.attachments.at(-1).id, original[0]); assert(!d.querySelector('.sort-marker')); assert(!d.body.classList.contains('list-sorting')); await keep();
  const reordered = order(), sent = moves().length;
  geometry(); pointer('pointerdown', grip(), 20, 320); pointer('pointermove', d, 20, 110); d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); pointer('pointerup', d, 20, 110);
  assert.deepEqual(order(), reordered);
  geometry(); pointer('pointerdown', grip(), 20, 320); pointer('pointermove', d, 700, 110); pointer('pointerup', d, 700, 110); assert.deepEqual(order(), reordered);
  assert.equal(A.reorderAttachment(task.id, original[0], original[0]), false); assert.equal(moves().length, sent);
});

test('an upload counts as unsaved work until it settles', async () => {
  const t = bootApp({ route: 'task/BIR-079', api: { attachments: async () => ({ items: [] }) } });
  assert.equal(t.w.Recovery.hasUnsavedInput(), false);
  t.A.attachFiles('BIR-079', { files: [new t.w.File(['notes'], 'notes.txt', { type: 'text/plain' })], value: '' });
  await waitFor(() => t.calls.some(call => call.method === 'uploadAttachment'), 'the upload was sent');
  assert.equal(t.w.Recovery.hasUnsavedInput(), true, 'leaving now would lose the file');
  t.answer('uploadAttachment', { id: 'f1', name: 'notes.txt', size: 5, mediaType: 'text/plain', previewKind: 'text', isEphemeral: false, uploadedBy: 'taylorwu', uploadedAt: 1, lastAccessedAt: 1, state: 'available', revision: 1 });
  await waitFor(() => !t.w.Recovery.hasUnsavedInput(), 'the settled upload no longer counts');
});

test('an upload, retention change and delete still finish after a live update replaced the task', async () => {
  const file = (overrides = {}) => ({ id: 'f1', name: 'notes.txt', size: 5, mediaType: 'text/plain', previewKind: 'text', isEphemeral: false, uploadedBy: 'taylorwu', uploadedAt: 1, lastAccessedAt: 1, state: 'available', revision: 1, contentUrl: '/content', downloadUrl: '/download', ...overrides });
  const t = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').internalId = 'bir-079'; }, api: { attachments: async () => ({ items: [] }) } });
  const replace = () => { const current = t.D.tasks.find(item => item.id === 'BIR-079'), copy = { ...current, attachments: [...(current.attachments || [])].map(item => ({ ...item })) }; t.D.tasks.splice(t.D.tasks.indexOf(current), 1, copy); return copy; };
  const answer = async (method, value) => { await waitFor(() => t.calls.some(call => call.method === method && !call.settled), `${method} was sent`); replace(); t.answer(method, value); };
  const notices = []; const toast = t.A.toast; t.A.toast = (text, kind) => { notices.push(text); return toast(text, kind); };
  t.A.attachFiles('BIR-079', { files: [new t.w.File(['notes'], 'notes.txt', { type: 'text/plain' })], value: '' });
  await answer('uploadAttachment', file());
  await waitFor(() => notices.includes('Attachment added'), 'the upload completes');
  assert.equal(t.D.tasks.find(item => item.id === 'BIR-079').attachments.filter(item => item.id === 'f1').length, 1);
  assert.equal(t.d.querySelector('.upload-row'), null, 'no failed upload row offers Retry');
  t.A.setAttachmentTemporary('BIR-079', 'f1', true);
  await answer('updateAttachment', file({ isEphemeral: true, revision: 2 }));
  await waitFor(() => notices.includes('Attachment marked temporary'), 'the retention change completes');
  assert.equal(t.D.tasks.find(item => item.id === 'BIR-079').attachments[0].ephemeral, true);
  t.A.delAttachment('BIR-079', 0); t.d.querySelector('[data-confirm-accept]').click();
  await answer('deleteAttachment', {});
  await waitFor(() => notices.includes('Attachment deleted'), 'the delete completes');
  assert.deepEqual(t.D.tasks.find(item => item.id === 'BIR-079').attachments, []);
});

test('live updates read attachments and storage usage again passively', async () => {
  const reads = [];
  const t = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').internalId = 'bir-079'; }, api: {
    attachments: async (_id, options = {}) => { reads.push(['attachments', !!options.background]); return { items: [] }; },
    storageUsage: async (options = {}) => { reads.push(['storage', !!options.background]); return { budgetBytes: 100, highWatermarkBytes: 90, lowWatermarkBytes: 80, usedBytes: 1, permanentBytes: 1, temporaryBytes: 0, cleanedRecords: 0, reservedBytes: 0, projects: [], recentCleanup: [] }; },
  } });
  const listener = change => t.runtime.publish(change);
  // Each read answers at once; let its reply land before the next step.
  const answered = async (count, message) => { await waitFor(() => reads.length === count, message); await settle(); };
  await answered(1, 'the task page reads its attachments');
  filesChanged(t);
  await answered(2, 'a live update reads them again');
  const current = t.D.tasks.find(item => item.id === 'BIR-079');
  t.D.tasks.splice(t.D.tasks.indexOf(current), 1, { ...current, attachments: [] }); t.A.refresh();
  await answered(3, 'a replaced task reads them again');
  t.A.nav('storage');
  await answered(4, 'Storage reads usage');
  listener({ type: 'sse', kind: 'activity.changed' });
  await answered(5, 'a live update reads usage again');
  listener({ type: 'bootstrap' }); t.A.refresh();
  await answered(6, 'a refresh reads usage again');
  assert.deepEqual(reads, [['attachments', false], ['attachments', true], ['attachments', true], ['storage', false], ['storage', true], ['storage', true]]);
});

test('a task page reads its attachments once each time it opens, and keeps them when a live read replaces the task', async () => {
  let reads = 0, taskReads;
  // The task as the server sends it. Reading it replaces the task's object, as the projection does.
  const view = (revision, title) => ({ id: 'bir-079', taskKey: 'BIR-079', projectId: 'p1', trackId: 't1', epicId: 'e2', title, description: '', status: 'planning', position: 1, createdAt: 1, updatedAt: revision, assigneeIds: [], activeBlock: null, revision });
  let latest = view(1, 'Flexible reading schedule');
  const t = bootApp({ route: 'board', api: {
    attachments: async () => { reads++; return { items: [serverFile('notes', 'notes.txt', 'text')] }; },
    task: async () => latest,
  }, reads: { task: id => taskReads.task(id) } });
  // The route loader's task read draws the page again, as boot.js wires it.
  taskReads = createReadController({ api: t.api, data: t.D, onTask: task => { const context = t.A.context(); if (context.view === 'task' && context.taskId === task.id) t.A.refresh(); } });
  const open = async () => { t.A.openTask('BIR-079'); await settle(); await t.bridge.loadCurrentRoute(); await settle(); };
  await open();
  assert.equal(reads, 1, 'the task opens');
  // Another person changes the task: its live read replaces the task, which keeps its files.
  latest = view(2, 'Changed elsewhere');
  t.events.at(-1).emit('hint', { kind: 'activity.changed', projectId: 'p1', taskId: 'bir-079', entityType: 'task', entityId: 'bir-079', entityRevision: 2 });
  await waitFor(() => t.d.querySelector('.tp-title').value === 'Changed elsewhere', 'the live read draws the changed task'); await settle();
  assert.equal(reads, 1, 'a change to the task reads no files');
  assert.equal(t.d.querySelector('.attachment-title').textContent, 'notes.txt');
  t.A.nav('board'); await open();
  assert.equal(reads, 2, 'the task opens again');
  assert.equal(t.d.querySelector('.attachment-title').textContent, 'notes.txt');
});

test('a live reload of the files waits for a press on the page to end, so its click lands', async () => {
  let reads = 0;
  const files = [serverFile('notes', 'notes.txt', 'text')];
  const t = await withServerFiles(files, {}, { api: { attachments: async () => { reads++; return { items: files }; } } });
  const card = () => t.d.querySelector('[data-attachment-id="notes"]'), pressed = card();
  const pointer = type => pressed.dispatchEvent(new t.w.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  pointer('pointerdown');
  filesChanged(t);
  await waitFor(() => reads === 2, 'the live change reads the files'); await settle();
  assert.equal(card(), pressed, 'the file stays under the pressed button');
  pointer('pointerup'); pressed.dispatchEvent(new t.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await waitFor(() => card() !== pressed, 'the files are drawn again once the press ends');
});

test('a live re-read of attachments that lost access stays quiet', async () => {
  let reads = 0;
  const t = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').internalId = 'bir-079'; }, api: { attachments: async () => { if (++reads > 1) throw new ApiError('task not found', { status: 404, code: 'not_found' }); return { items: [] }; } } });
  const notices = []; t.A.toast = (text, kind) => notices.push([text, kind]);
  await waitFor(() => reads === 1, 'the page reads its attachments'); await settle();
  filesChanged(t);
  await waitFor(() => reads === 2, 'a live update reads them again'); await settle();
  assert.deepEqual(notices, [], 'leaving the project explains the change, not a failed read');
});

test('image files show their thumbnail, or the original when there is none', async () => {
  const image = (id, overrides) => ({ id, name: `${id}.png`, size: 5, mediaType: 'image/png', previewKind: 'image', isEphemeral: false, uploadedBy: 'taylorwu', uploadedAt: 1, lastAccessedAt: 1, state: 'available', revision: 1, contentUrl: `/content/${id}`, downloadUrl: `/download/${id}`, ...overrides });
  const t = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').internalId = 'bir-079'; }, api: { attachments: async () => ({ items: [image('photo', { thumbnailUrl: '/thumbnail/photo' }), image('spinner', { mediaType: 'image/gif' })] }) } });
  await waitFor(() => t.d.querySelectorAll('.attachment-thumbnail img').length === 2, 'both images render');
  assert.deepEqual([...t.d.querySelectorAll('.attachment-thumbnail img')].map(img => img.getAttribute('src')), ['/thumbnail/photo', '/content/spinner']);
});

test('a file Undo that meets a busy server offers Undo again, with the same key', async () => {
  const file = { id: 'f1', name: 'notes.txt', size: 5, mediaType: 'text/plain', previewKind: 'text', isEphemeral: false, uploadedBy: 'taylorwu', uploadedAt: 1, lastAccessedAt: 1, state: 'available', revision: 3, contentUrl: '/content', downloadUrl: '/download' };
  let listed = [file];
  const restores = [];
  const t = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').internalId = 'bir-079'; }, api: {
    attachments: async () => ({ items: listed }),
    deleteAttachment: async () => { listed = []; return {}; },
    restoreAttachment: async (_id, input) => { restores.push(input.idempotencyKey); if (restores.length === 1) throw new ApiError('Busy', { status: 503, code: 'unavailable', uncertain: true }); listed = [{ ...file, revision: 5 }]; return listed[0]; },
  } });
  const notices = []; t.A.toast = (text, kind, options) => notices.push({ text, kind, options });
  await waitFor(() => (t.D.tasks.find(item => item.id === 'BIR-079').attachments || []).length === 1, 'the file is listed');
  t.A.delAttachment('BIR-079', 0); t.d.querySelector('[data-confirm-accept]').click();
  await waitFor(() => notices.some(notice => notice.text === 'Attachment deleted'), 'the delete completes');
  notices.find(notice => notice.text === 'Attachment deleted').options.action.run();
  await waitFor(() => notices.at(-1).kind === 'error', 'the restore fails');
  assert.equal(notices.at(-1).options.action.label, 'Undo');
  notices.at(-1).options.action.run();
  await waitFor(() => notices.some(notice => notice.text === 'Attachment restored'), 'the second try restores it');
  assert.equal(restores.length, 2); assert.equal(restores[1], restores[0]);
});

test('a deleted file offers Undo, which restores it at the revision its deletion left', async () => {
  const file = { id: 'f1', name: 'notes.txt', size: 5, mediaType: 'text/plain', previewKind: 'text', isEphemeral: false, uploadedBy: 'taylorwu', uploadedAt: 1, lastAccessedAt: 1, state: 'available', revision: 3, contentUrl: '/content', downloadUrl: '/download' };
  let listed = [file];
  const restores = [];
  const t = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').internalId = 'bir-079'; }, api: {
    attachments: async () => ({ items: listed }),
    deleteAttachment: async () => { listed = []; return {}; },
    restoreAttachment: async (id, input) => { restores.push([id, input.expectedRevision, typeof input.idempotencyKey]); listed = [{ ...file, revision: 5 }]; return listed[0]; },
  } });
  const notices = []; t.A.toast = (text, kind, options) => notices.push({ text, kind, options });
  await waitFor(() => (t.D.tasks.find(item => item.id === 'BIR-079').attachments || []).length === 1, 'the file is listed');
  t.A.delAttachment('BIR-079', 0);
  assert.match(t.d.querySelector('#confirmation-description').textContent, /undo this right after/);
  t.d.querySelector('[data-confirm-accept]').click();
  await waitFor(() => notices.some(notice => notice.text === 'Attachment deleted'), 'the delete completes');
  const deleted = notices.find(notice => notice.text === 'Attachment deleted');
  assert.equal(deleted.options.action.label, 'Undo');
  deleted.options.action.run();
  await waitFor(() => notices.some(notice => notice.text === 'Attachment restored'), 'the restore completes');
  assert.deepEqual(restores, [['f1', 4, 'string']]);
  await waitFor(() => t.D.tasks.find(item => item.id === 'BIR-079').attachments?.[0]?.revision === 5, 'the list is read again');
});

test('a text preview read from the server names the person the page shows', async () => {
  const file = { id: 'f1', name: 'notes.txt', size: 5, mediaType: 'text/plain', previewKind: 'text', isEphemeral: false, uploadedBy: 'taylorwu', uploadedAt: 1, lastAccessedAt: 1, state: 'available', revision: 1, contentUrl: '/content', sourceUrl: '/source', downloadUrl: '/download' };
  const reads = [];
  const t = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').internalId = 'bir-079'; }, api: { attachments: async () => ({ items: [file] }) }, setup: w => {
    w.fetch = async (url, options) => { reads.push([url, new w.Headers(options.headers).get('X-Oneloop-User')]); return { ok: true, arrayBuffer: async () => new TextEncoder().encode('notes').buffer }; };
  } });
  await waitFor(() => (t.D.tasks.find(item => item.id === 'BIR-079').attachments || []).length === 1, 'the file is listed');
  t.A.previewAttachment('BIR-079', 'f1');
  await waitFor(() => reads.length === 1, 'the preview reads the text');
  assert.deepEqual(reads, [['/source', t.D.session.userId]]);
});

test('the Temporary switch in a file preview changes the file', async () => {
  const file = { id: 'f1', name: 'notes.txt', size: 5, mediaType: 'text/plain', previewKind: 'text', isEphemeral: false, uploadedBy: 'taylorwu', uploadedAt: 1, lastAccessedAt: 1, state: 'available', revision: 1, contentUrl: '/content', sourceUrl: '/source', downloadUrl: '/download' };
  const t = bootApp({ route: 'task/BIR-079', actions: true, api: { attachments: async () => ({ items: [file] }) }, setup: w => { w.fetch = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('notes').buffer }); } });
  await waitFor(() => (t.D.tasks.find(item => item.id === 'BIR-079').attachments || []).length === 1, 'the file is listed');
  t.A.previewAttachment('BIR-079', 'f1');
  t.d.querySelector('.file-dialog [data-file-ephemeral]').click();
  const sent = t.calls.filter(call => call.method === 'updateAttachment').map(call => call.args);
  assert.equal(JSON.stringify(sent), JSON.stringify([['f1', { isEphemeral: true, expectedRevision: 1 }]]));
});

test('closing a preview gives focus back to its file name after a live update drew the list again', async () => {
  const t = await withServerFiles([serverFile('notes', 'notes.txt', 'text')], { '/source/notes': 'notes' });
  const opener = t.d.querySelector('.attachment-title');
  opener.focus(); t.A.previewAttachment('BIR-079', 'notes');
  filesChanged(t);
  await waitFor(() => !opener.isConnected, 'the live read draws the list again');
  t.d.querySelector('[data-file-close]').click();
  assert.equal(t.d.activeElement, t.d.querySelector('.attachment-title'));
});

test('each control of a file, and the drop area, keeps focus when a change from elsewhere draws the files again', async context => {
  const files = [serverFile('hello', 'hello.txt', 'text'), serverFile('world', 'world.md', 'markdown')];
  // A live read waits for the page's feed and reads the activity too, so both land before the next change reads again.
  const feed = async () => ({ items: [], nextCursor: null });
  const t = await withServerFiles(files, {}, { api: { attachments: async () => ({ items: files }), comments: feed, activity: feed } });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const control of ['[data-attachment-id="world"] .attachment-grip', '[data-attachment-id="world"] .attachment-thumbnail', '[data-attachment-id="world"] .attachment-title', '[data-attachment-id="world"] .retention-switch', '[data-attachment-id="world"] .file-download', '[data-attachment-id="world"] .file-remove', '.attachment-dropzone']) {
    const old = t.d.querySelector(control); old.focus();
    filesChanged(t);
    // The live read waits a moment, so that changes made together read once.
    for (let step = 0; step < 3; step++) { context.mock.timers.tick(100); await settle(); }
    assert.equal(old.isConnected, false, `${control}: the live read draws the files again`);
    assert.equal(t.d.activeElement, t.d.querySelector(control), control);
  }
  context.mock.timers.reset();
});

test('focus stays on a file\'s control when the server answers a move, and goes to the file in its place when it is deleted', async () => {
  let listed = [serverFile('hello', 'hello.txt', 'text'), serverFile('world', 'world.md', 'markdown')];
  const t = await withServerFiles(listed, {}, { api: { attachments: async () => ({ items: listed }), deleteAttachment: async () => { listed = listed.filter(file => file.id !== 'world'); return {}; } } });
  const grip = t.d.querySelector('[data-reorder-file="hello"]');
  grip.focus(); grip.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  // The person moves on to the file's name before the server answers.
  t.d.querySelector('[data-attachment-id="hello"] .attachment-title').focus();
  await answerLast(t, 'reorderAttachment', { items: [listed[1], listed[0]] });
  assert.equal(t.d.activeElement, t.d.querySelector('[data-attachment-id="hello"] .attachment-title'));
  // World is first now.
  t.d.querySelector('[data-attachment-id="world"] .file-remove').focus();
  t.A.delAttachment('BIR-079', t.task.attachments.findIndex(file => file.id === 'world'));
  t.d.querySelector('[data-confirm-accept]').click();
  await waitFor(() => !t.d.querySelector('[data-attachment-id="world"]'), 'the file is deleted');
  assert.equal(t.d.activeElement, t.d.querySelector('[data-attachment-id="hello"] .file-remove'));
});

test('a control that an upload\'s new state hides gives its focus to the row\'s next one: Cancel to Retry, and Retry to Cancel', async () => {
  const t = bootApp({ route: 'task/BIR-079', api: { attachments: async () => ({ items: [] }) } });
  const control = action => t.d.querySelector(`[data-upload-action="${action}"]`);
  t.A.attachFiles('BIR-079', { files: [new t.w.File(['notes'], 'notes.txt', { type: 'text/plain' })], value: '' });
  await waitFor(() => t.calls.some(call => call.method === 'uploadAttachment' && !call.settled), 'the upload was sent');
  control('cancel').focus();
  t.calls.filter(call => call.method === 'uploadAttachment').at(-1).reject(new ApiError('The server is busy', { status: 503, code: 'unavailable' }));
  await waitFor(() => control('cancel').hidden, 'the upload fails');
  assert.equal(t.d.activeElement, control('retry'), 'Cancel of an upload that failed');
  control('retry').click();
  await waitFor(() => !control('cancel').hidden, 'the upload starts again');
  assert.equal(t.d.activeElement, control('cancel'), 'Retry of an upload that starts again');
});

test('when an upload ends or is dismissed, focus on its controls goes to the drop area', async () => {
  const t = bootApp({ route: 'task/BIR-079', api: { attachments: async () => ({ items: [] }) } });
  const send = async () => {
    t.A.attachFiles('BIR-079', { files: [new t.w.File(['notes'], 'notes.txt', { type: 'text/plain' })], value: '' });
    await waitFor(() => t.calls.some(call => call.method === 'uploadAttachment' && !call.settled), 'the upload was sent');
  };
  await send();
  t.d.querySelector('[data-upload-action="cancel"]').focus();
  t.answer('uploadAttachment', serverFile('f1', 'notes.txt', 'text'));
  await waitFor(() => !t.d.querySelector('.upload-row'), 'the upload ends');
  assert.equal(t.d.activeElement, t.d.querySelector('.attachment-dropzone'), 'Cancel of an upload that ended');
  await send();
  t.calls.filter(call => call.method === 'uploadAttachment').at(-1).reject(new ApiError('The server is busy', { status: 503, code: 'unavailable' }));
  await waitFor(() => !t.d.querySelector('[data-upload-action="remove"]').hidden, 'the failed upload offers Dismiss');
  t.d.querySelector('[data-upload-action="remove"]').focus(); t.d.querySelector('[data-upload-action="remove"]').click();
  assert.equal(t.d.querySelector('.upload-row'), null);
  assert.equal(t.d.activeElement, t.d.querySelector('.attachment-dropzone'), 'Dismiss');
});
