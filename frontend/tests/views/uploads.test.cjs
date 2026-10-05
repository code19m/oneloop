// views/uploads.js: attachments, previews, retention, drag and drop, limits and PDFs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, bootApp, source, waitFor } = require('../support/dom.cjs');

const receipt = '<style>h1{color:blue}</style><h1>Receipt</h1><script>parent.evil=true</script><img src="https://example.invalid/pixel" onerror="alert(1)"><a href="https://example.invalid">Leave</a><iframe srcdoc="bad"></iframe><meta http-equiv="refresh" content="0;url=https://example.invalid"><form action="https://example.invalid"><input value="Visible field"><button>Submit</button></form>';

/** A task page with an HTML receipt and a text file attached through the view. */
async function withFiles() {
  const revoked = [];
  const t = bootApp({ route: 'task/BIR-079', setup: w => { w.URL.createObjectURL = () => 'blob:attachment'; w.URL.revokeObjectURL = url => revoked.push(url); } });
  const task = t.D.tasks.find(item => item.id === 'BIR-079');
  t.A.attachFiles(task.id, { files: [new t.w.File([receipt], 'receipt-preview.html', { type: 'text/html' }), new t.w.File(['notes'], 'notes.txt', { type: 'text/plain' })], value: '' });
  await waitFor(() => (task.attachments || []).length === 2, 'both files are attached');
  return { ...t, task, file: task.attachments[0], other: task.attachments[1], revoked };
}

/** Add an image attachment record and repaint the task. */
function withImage(t) {
  const image = { id: 'image', name: 'image.png', size: 10, url: 'blob:sample' };
  t.task.attachments.push(image); t.A.refresh();
  return image;
}

const withoutBoardAccess = t => {
  t.D.users.find(u => u.id === 'taylorwu').admin = false;
  t.D.projects[0].members.find(m => m.userId === 'taylorwu').permissions = [];
};

test('HTML attachments keep their file name and preview in an isolated sandbox with a source view', async () => {
  const { d, A, task, file } = await withFiles();
  assert.equal(file.name, 'receipt-preview.html'); assert.equal(file.displayName, undefined);
  assert(task.attachments.every(f => f.ephemeral === false)); assert(!d.querySelector('[name=uploadEphemeral]'));
  assert(d.querySelector('.attachment-title').textContent === 'receipt-preview.html'); assert(d.querySelector('.attachment-thumbnail').getAttribute('aria-label').includes('Preview'));
  assert(!d.querySelector('.file-preview-action')); assert(d.querySelector('.file-download').textContent.includes('Download'));
  A.previewAttachment(task.id, file.id);
  let frame = d.querySelector('.html-preview');
  assert(frame); assert.equal(frame.getAttribute('sandbox'), 'allow-scripts'); assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert(frame.srcdoc.includes("default-src 'none'")); assert(frame.srcdoc.includes('<script>')); assert(frame.srcdoc.includes('onerror=')); assert(frame.srcdoc.includes('https://example.invalid'));
  assert(!frame.srcdoc.includes('<iframe')); assert(frame.srcdoc.includes('Visible field')); assert(!frame.srcdoc.includes('disabled'));
  assert(d.querySelector('.file-info').hidden);
  const detailsButton = d.querySelector('[data-file-details]');
  detailsButton.click(); assert(!d.querySelector('.file-info').hidden); assert.equal(detailsButton.getAttribute('aria-expanded'), 'true'); assert.equal(d.querySelector('.html-preview'), frame);
  detailsButton.click(); assert(d.querySelector('.file-info').hidden);
  d.querySelector('[data-html-source]').click(); assert(!frame.isConnected); assert(d.querySelector('.document-preview').hidden);
  assert(d.querySelector('.html-source').textContent.includes('<script>')); assert(!d.querySelector('.html-source script'));
  d.querySelector('[data-html-rendered]').click(); frame = d.querySelector('.html-preview'); assert(!frame.closest('.document-preview').hidden);
  assert(!d.querySelector('#attachment-display-name')); assert.equal(d.querySelector('[data-file-download]').download, 'receipt-preview.html'); assert.equal(d.querySelector('#file-preview-title').textContent, 'receipt-preview.html');
});

test('retention switches change one file, suppress reverted activity and keep focus and an open reply', async () => {
  const t = await withFiles();
  const { w, d, A, task, file, other } = t;
  A.previewAttachment(task.id, file.id);
  A.setAttachmentTemporary(task.id, file.id, true); assert(file.ephemeral); assert.equal(other.ephemeral, false); assert.equal(d.querySelector('[data-file-ephemeral]').getAttribute('aria-checked'), 'true');
  A.setAttachmentTemporary(task.id, file.id, false); assert(!file.ephemeral); assert(!w.Activity.visible(task.activity).some(a => a.change?.field === 'attachment-retention:' + file.id));
  d.querySelector('[data-file-close]').click();
  const image = withImage(t);
  const retention = d.querySelector(`[data-attachment-id="${image.id}"] .retention-switch`); retention.focus();
  A.setAttachmentTemporary(task.id, image.id, true);
  assert.strictEqual(d.querySelector(`[data-attachment-id="${image.id}"] .retention-switch`), retention); assert.equal(d.activeElement, retention); assert.equal(retention.getAttribute('aria-checked'), 'true');
  assert(d.querySelector('.timeline').textContent.includes('temporary'));
  A.setAttachmentTemporary(task.id, image.id, false); assert.equal(retention.getAttribute('aria-checked'), 'false');
  (task.comments ||= []).push({ id: 'retention-reply-root', who: 'taylorwu', ts: Date.now(), text: 'Keep this conversation', parentId: null }); A.refresh();
  A.replyComment(task.id, 'retention-reply-root');
  const replyInput = d.getElementById('cmtIn'); replyInput.value = 'Unsent reply stays here'; replyInput.focus();
  A.setAttachmentTemporary(task.id, image.id, true);
  assert.strictEqual(d.getElementById('cmtIn'), replyInput); assert.equal(replyInput.value, 'Unsent reply stays here'); assert.equal(d.activeElement, replyInput);
});

test('Office and binary files are download-only and images drop old custom labels', async () => {
  const t = await withFiles();
  const { w, d, A, task } = t;
  const downloads = []; w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  for (const ext of ['docx', 'xlsx', 'pptx', 'zip', 'exe']) {
    const office = { id: ext, name: 'report.' + ext, size: 4, url: 'blob:sample' }; task.attachments.push(office);
    assert.equal(w.Uploads.canPreview(office), false); A.previewAttachment(task.id, office.id); assert(!d.querySelector('.file-dialog')); assert.equal(downloads.at(-1), office.name);
  }
  const image = { id: 'image', name: 'image.png', size: 10, url: 'blob:sample', displayName: 'Old custom label' };
  task.attachments.push(image); A.refresh();
  assert(d.querySelector('.attachment-thumbnail img')); assert(!d.querySelector('.task-attachments').textContent.includes('Old custom label')); assert.equal(image.displayName, undefined);
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
  d.querySelector('#retention-help-text').getBoundingClientRect = () => ({ width: 240, height: 61 });
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
  A.previewAttachment(task.id, file.id); assert(!d.querySelector('#attachment-display-name')); assert(!d.querySelector('[data-file-ephemeral]')); assert(d.querySelector('.html-preview'));
  assert(!d.querySelector('.attachment-count')); assert(!d.querySelector('.file-history'));
});

test('storage cleanup keeps order and leaves a disabled tombstone for cleaned files', async () => {
  const { w, d, A, D, task, other } = await withFiles();
  other.ephemeral = true; other.uploadedAt = Date.now() - 3 * 864e5; other.lastAccessAt = Date.now() - 3 * 864e5;
  D.storageConfig = { budgetBytes: w.Uploads.usage(), high: .99, low: .9 };
  const order = task.attachments.map(f => f.id).join(',');
  w.Uploads.cleanup(); assert.equal(other.state, 'cleaned'); assert.equal(other.url, null); assert.equal(task.attachments.map(f => f.id).join(','), order);
  const cleaned = d.querySelector(`[data-attachment-id="${other.id}"]`);
  assert(cleaned.textContent.includes('Cleaned up')); assert(!cleaned.querySelector('a')); assert(cleaned.querySelector('.file-download').disabled); assert(!cleaned.querySelector('[role=switch]'));
  A.previewAttachment(task.id, other.id); assert(!d.querySelector('.file-dialog'));
});

test('deleting a file revokes its URL, frees usage and clears comment references', async () => {
  const { w, d, A, task, file, other, revoked } = await withFiles();
  (task.comments ||= []).push({ id: 'file-ref', who: 'taylorwu', ts: Date.now(), text: 'Reference', attachments: [file.id], mentions: [] });
  const before = w.Uploads.usage(), url = file.url;
  A.delAttachment(task.id, task.attachments.indexOf(file)); d.querySelector('[data-confirm-accept]').click();
  assert(!task.attachments.some(f => f.id === file.id)); assert(revoked.includes(url)); assert.equal(w.Uploads.usage(), before - file.size);
  assert.equal(task.comments.at(-1).attachments, undefined); assert(!d.querySelector(`[data-attachment-id="${file.id}"]`)); assert(!d.querySelector('.file-history'));
  A.delAttachment(task.id, task.attachments.indexOf(other)); d.querySelector('[data-confirm-accept]').click(); assert(!task.attachments.includes(other));
});

test('legacy bidirectional file names are isolated in rows and activity', () => {
  const { d, A, D } = bootApp({ route: 'task/BIR-079' });
  const task = D.tasks.find(item => item.id === 'BIR-079');
  const legacy = { id: 'legacy-bidi', name: 'Invoice‮fdp.exe', size: 4, url: 'blob:legacy', state: 'available' };
  (task.attachments ||= []).push(legacy); (task.activity ||= []).push({ id: 'legacy-bidi-activity', who: 'taylorwu', ts: Date.now(), text: 'attached ' + legacy.name }); A.refresh();
  const row = d.querySelector('[data-attachment-id="legacy-bidi"]');
  assert(row); assert.equal(row.querySelector('.attachment-title').title, 'Invoicefdp.exe'); assert(row.querySelector('bdi.attachment-name-base'));
  assert(!row.outerHTML.includes('‮')); assert(!d.querySelector('.timeline').textContent.includes('‮'));
});

test('files with duplicate names stay separate attachments with download links', async () => {
const t=bootApp({route:'task/BIR-079'});t.A.attachFiles('BIR-079',{files:[new t.w.File(['name,status\nExample,planning\n'],'example.csv',{type:'text/csv'})],value:''});await waitFor(()=>t.D.tasks.find(x=>x.id==='BIR-079').attachments?.length===1,'the first file is attached');const task=t.D.tasks.find(x=>x.id==='BIR-079');assert.equal(task.attachments.length,1);t.A.attachFiles('BIR-079',{files:[new t.w.File(['name,status\nSecond,planning\n'],'example.csv',{type:'text/csv'})],value:''});await waitFor(()=>task.attachments?.length===2,'the duplicate name is attached separately');assert.equal(task.attachments.length,2);assert.notEqual(task.attachments[0].id,task.attachments[1].id);assert(t.d.querySelector('a[download="example.csv"]'));
});

test('capacity cleanup removes only eligible temporary files and keeps tombstones and permanent files', () => {
  const { w, D } = bootApp({ route: 'task/BIR-079', prepare: D => {
    D.tasks.forEach(t => t.attachments = []); D.storageConfig = { budgetBytes: 1000, high: .8, low: .7 };
    D.tasks.find(t => t.id === 'BIR-079').attachments = [{ id: 'keep', name: 'keep.txt', size: 600, uploadedAt: Date.now() - 3 * 864e5, ephemeral: false }, { id: 'old', name: 'old.txt', size: 250, uploadedAt: Date.now() - 3 * 864e5, lastAccessAt: Date.now() - 2 * 864e5, ephemeral: true }];
  } });
  const task = D.tasks.find(t => t.id === 'BIR-079'), result = w.Uploads.cleanup();
  assert.equal(result.count, 1); assert.equal(task.attachments[1].state, 'cleaned'); assert(!task.attachments[0].state); assert.equal(w.Uploads.available(task).length, 1); assert.equal(w.Uploads.usage(), 600);
});

test('a task holds at most 25 files, defaults to permanent and previews text safely', async () => {
  const { w, d, A, D } = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(t => t.id === 'BIR-079').attachments = Array.from({ length: 24 }, (_, i) => ({ id: 'existing' + i, name: 'existing.txt', size: 1, ephemeral: false })); } });
  const task = D.tasks.find(t => t.id === 'BIR-079');
  A.attachFiles(task.id, { files: [new w.File(['name,value\n"hello, world",<script>'], 'sample.txt', { type: 'text/plain' })], value: '' });
  await waitFor(() => w.Uploads.available(task).length === 25, 'the 25th file is attached');
  assert.equal(task.attachments.at(-1).ephemeral, false);
  A.previewAttachment(task.id, task.attachments.at(-1).id);
  assert(d.querySelector('.file-preview-content pre').textContent.includes('hello, world')); assert(!d.querySelector('.file-preview-content script'));
  d.querySelector('[data-file-close]').click();
  A.attachFiles(task.id, { files: [new w.File(['x'], 'overflow.txt', { type: 'text/plain' })], value: '' });
  await waitFor(() => d.querySelector('.upload-state')?.textContent.includes('25 available'), 'the limit is reported');
  assert.equal(w.Uploads.available(task).length, 25);
});

test('upload validation limits size, checks signatures and accepts plain text', () => {
  const { w } = bootApp();
  const U = w.Uploads;
  assert.equal(U.inspect({ name: 'bad.pdf', size: 4 }, new Uint8Array([1, 2, 3, 4]).buffer), '');
  assert.equal(U.inspect({ name: 'file.txt', size: 26 * 1024 * 1024 }, new ArrayBuffer(0)), 'File exceeds 25 MB.');
  assert.equal(U.inspect({ name: 'file.csv', size: 4 }, new Uint8Array([65, 44, 66, 10]).buffer), '');
  assert(U.inspect({ name: 'anything.bin', size: 26 * 1024 * 1024 }, new ArrayBuffer(0)).includes('exceeds'));
  assert(U.inspect({ name: 'avatar.png', size: 4 }, new Uint8Array([1, 2, 3, 4]).buffer, true).includes('do not match'));
});

test('text file names match the server detection list', () => {
  const read = file => fs.readFileSync(path.resolve(__dirname, '../../..', file), 'utf8');
  const js = read('frontend/views/uploads.js'), rust = read('src/files/service/detect.rs');
  const body = rust.slice(rust.indexOf('fn is_text_name('), rust.indexOf('fn is_text_name(') + 8000).split('\n}')[0];
  const ext = js.match(/textExtensions=new Set\('([^']+)'/)[1].split(' ');
  const names = [...js.match(/textNames=new Set\(\[(.*?)\]/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(new Set([...body.matchAll(/"([^"]+)"/g)].map(match => match[1])), new Set([...ext, ...names]));
});

/** Dispatch a drag event with a synthetic DataTransfer. */
function drag(w, type, target, files = [], items = [], types = ['Files']) {
  const event = new w.Event(type, { bubbles: true, cancelable: true }), transfer = { types, files, items, dropEffect: '' };
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  target.dispatchEvent(event);
  return { event, transfer };
}

test('file drops, drag targets, folders, access, limits and overlays share one upload path', async () => {
  const { w, d, A, D } = bootApp({ route: 'task/BIR-079' });
  const task = D.tasks.find(t => t.id === 'BIR-079'), notices = []; A.toast = (text, kind) => notices.push({ text, kind });
  const zone = () => d.querySelector('.task-attachments');
  assert.equal(zone().dataset.uploadTask, task.id); assert(zone().querySelector(':scope > button.attachment-dropzone')); assert.equal(zone().querySelectorAll('button.attachment-dropzone').length, 1);
  assert(!zone().querySelector('h2 button')); assert(!zone().querySelector('.attachment-empty')); assert(!zone().querySelector('.attachment-dropzone.is-compact'));
  const uploaderMarkup = zone().querySelector('.attachment-dropzone').innerHTML;
  const over = drag(w, 'dragover', zone().querySelector('h2'));
  assert(over.event.defaultPrevented); assert.equal(over.transfer.dropEffect, 'copy'); assert(zone().classList.contains('is-file-dragover')); assert(zone().querySelector('.attachment-drop-title').textContent.includes('Release'));
  const a = new w.File(['hello'], 'hello.txt'), b = new w.File(['world'], 'world.md');
  const drop = drag(w, 'drop', zone().querySelector('h2'), [a, b]);
  assert(drop.event.defaultPrevented); assert(!zone().classList.contains('is-file-dragover'));
  await waitFor(() => task.attachments?.length === 2, 'both dropped files are attached');
  assert(task.attachments.every(f => !f.ephemeral)); assert(zone().querySelector('.attachment-dropzone.is-compact')); assert.equal(zone().querySelector('.attachment-dropzone').innerHTML, uploaderMarkup);
  drag(w, 'dragover', zone()); assert(zone().classList.contains('is-file-dragover')); drag(w, 'dragover', d.querySelector('.tp-title')); assert(!zone().classList.contains('is-file-dragover'));
  const count = task.attachments.length; drag(w, 'drop', d.querySelector('.tp-title'), [a]); assert.equal(task.attachments.length, count); assert(notices.at(-1).text.includes('attachment section'));
  assert(!drag(w, 'dragover', zone(), [], [], ['text/plain']).event.defaultPrevented); assert(!drag(w, 'drop', zone(), [], [], ['text/plain']).event.defaultPrevented);
  const folder = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => new w.File([], 'folder') }, file = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => a };
  drag(w, 'drop', zone(), [a], [folder, file]);
  await waitFor(() => task.attachments.length === count + 1, 'only the file inside the drop is attached');
  assert(notices.some(n => n.text.includes('Folders are not supported')));
  drag(w, 'drop', zone(), [new w.File([new Uint8Array(26 * 1024 * 1024)], 'too-large.zip')]);
  await waitFor(() => d.querySelector('.upload-state')?.textContent.includes('exceeds 25 MB'), 'the size limit is reported');
  assert.equal(task.attachments.length, count + 1);
  drag(w, 'dragover', zone()); D.users.find(u => u.id === 'taylorwu').admin = false; D.projects[0].members.find(m => m.userId === 'taylorwu').permissions = [];
  drag(w, 'drop', zone(), [a]); assert(!zone().classList.contains('is-file-dragover')); assert.equal(task.attachments.length, count + 1); assert(notices.at(-1).text.includes('permission'));
  assert.equal(drag(w, 'dragover', zone()).transfer.dropEffect, 'none');
  const protectedOrder = task.attachments.map(f => f.id);
  assert.equal(A.reorderAttachment(task.id, protectedOrder[0], protectedOrder[1], true), false); assert.deepEqual(task.attachments.map(f => f.id), protectedOrder);
  D.users.find(u => u.id === 'taylorwu').admin = true; A.openModal('task'); drag(w, 'drop', zone(), [a]); assert.equal(task.attachments.length, count + 1); A.closeOverlays();
  task.attachments = Array.from({ length: 24 }, (_, i) => ({ id: 'existing' + i, name: 'existing.txt', size: 1 })); A.refresh();
  drag(w, 'drop', zone(), [a, b]);
  await waitFor(() => task.attachments.length === 25, 'the drop fills the last slot');
  assert([...d.querySelectorAll('.upload-state')].some(el => el.textContent.includes('25 available')));
  task.attachments = []; A.refresh(); assert(!zone().querySelector('.attachment-dropzone.is-compact'));
  A.nav('board'); assert(drag(w, 'drop', d.body, [a]).event.defaultPrevented); assert(notices.at(-1).text.includes('Open a task'));
});

test('attachment order is shared by keyboard and pointer moves, which Escape and leaving cancel', async () => {
  const { w, d, A, D } = bootApp({ route: 'task/BIR-079' });
  const task = D.tasks.find(t => t.id === 'BIR-079');
  A.attachFiles(task.id, { files: [new w.File(['hello'], 'hello.txt'), new w.File(['world'], 'world.md'), new w.File(['third'], 'third.txt')], value: '' });
  await waitFor(() => task.attachments?.length === 3, 'three files are attached');
  const zone = () => d.querySelector('.task-attachments');
  const original = task.attachments.map(f => f.id), grip = () => d.querySelector(`[data-reorder-file="${original[0]}"]`);
  grip().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); assert.equal(task.attachments.at(-1).id, original[0]); assert.equal(d.activeElement.dataset.reorderFile, original[0]);
  grip().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })); assert.deepEqual(task.attachments.map(f => f.id), original);
  const pointer = (type, target, x, y) => { const event = new w.Event(type, { bubbles: true, cancelable: true }); for (const [key, value] of Object.entries({ button: 0, pointerId: 1, clientX: x, clientY: y })) Object.defineProperty(event, key, { value }); target.dispatchEvent(event); };
  const geometry = () => { zone().getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 500 }); [...zone().querySelectorAll('[data-attachment-id]')].forEach((row, i) => row.getBoundingClientRect = () => ({ left: 0, right: 600, top: 100 + i * 100, bottom: 190 + i * 100, width: 600, height: 90 })); };
  geometry(); pointer('pointerdown', grip(), 20, 120); pointer('pointermove', d, 20, 370); assert(d.querySelector('.attachment-insert-marker')); pointer('pointerup', d, 20, 370);
  assert.equal(task.attachments.at(-1).id, original[0]); assert(!d.querySelector('.attachment-insert-marker')); assert(!d.body.classList.contains('attachment-sorting'));
  const reordered = task.attachments.map(f => f.id);
  geometry(); pointer('pointerdown', grip(), 20, 320); pointer('pointermove', d, 20, 110); d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); pointer('pointerup', d, 20, 110);
  assert.deepEqual(task.attachments.map(f => f.id), reordered);
  geometry(); pointer('pointerdown', grip(), 20, 320); pointer('pointermove', d, 700, 110); pointer('pointerup', d, 700, 110); assert.deepEqual(task.attachments.map(f => f.id), reordered);
  const activities = task.activity.length; assert.equal(A.reorderAttachment(task.id, original[0], original[0]), false); assert.equal(task.activity.length, activities);
});

/** Boot a task page whose PDF.js module and canvas are test doubles. */
async function pdfPreview(url, scriptPath) {
  const dom = new JSDOM('<meta name="theme-color"><div id="app"></div>', { url: url + '#/task/BIR-079', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }); w.TextDecoder = TextDecoder; w.URL.createObjectURL = () => 'blob:pdf'; w.HTMLCanvasElement.prototype.getContext = () => ({});
  const observers = []; w.ResizeObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe(el) { this.el = el; } disconnect() { this.stopped = true; } };
  const state = { renders: 0, textReads: 0, fades: 0, documentOptions: null, importURL: null };
  const page = { getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }), render() { state.renders++; return { promise: Promise.resolve(), cancel() {} }; }, getTextContent() { state.textReads++; return Promise.resolve({ items: [] }); } };
  w.pdfTestImport = moduleUrl => { state.importURL = moduleUrl; return Promise.resolve(w.pdfTestModule); };
  w.pdfTestModule = { GlobalWorkerOptions: {}, getDocument: options => { state.documentOptions = options; return { promise: Promise.resolve({ numPages: 2, getPage: async () => page }), destroy: async () => {} }; } };
  for (const name of ['theme', 'data', 'motion', 'vendor/js-sha256/sha256', 'activity', 'recovery', 'uploads', 'collaboration', 'app']) {
    let text = source(name);
    if (name === 'uploads') text = text.replace("await import(new URL('pdf.mjs',root).href)", "await window.pdfTestImport(new URL('pdf.mjs',root).href)");
    const script = name === 'uploads' && scriptPath ? d.createElement('script') : null;
    if (script) script.src = new URL(scriptPath, url).href;
    Object.defineProperty(d, 'currentScript', { configurable: true, value: script });
    w.eval(text);
    Object.defineProperty(d, 'currentScript', { configurable: true, value: null });
  }
  w.UIMotion.fade = el => { if (el?.tagName === 'CANVAS') state.fades++; };
  const task = w.DATA.tasks.find(t => t.id === 'BIR-079');
  w.App.attachFiles(task.id, { files: [new w.File(['%PDF-test'], 'test.pdf')], value: '' });
  await waitFor(() => task.attachments?.length, 'the PDF is attached');
  const open = () => {
    w.App.previewAttachment(task.id, task.attachments[0].id);
    const host = d.querySelector('.file-preview-content'); Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    return host;
  };
  return { w, d, state, observers, open };
}

for (const [url, scriptPath] of [['http://localhost/', '/views/uploads.js'], ['http://localhost/x/y', '/views/uploads.js'], ['http://localhost/', null]]) {
  const label = scriptPath ? `the script URL from ${new URL(url).pathname}` : 'the evaluation fallback';
  test(`PDF previews resolve bundled assets through ${label}`, async () => {
    const { w, d, state, open } = await pdfPreview(url, scriptPath);
    open();
    await waitFor(() => state.fades === 1, 'the first page is painted');
    const root = 'http://localhost/vendor/pdfjs/';
    assert.equal(state.importURL, root + 'pdf.mjs'); assert.equal(w.pdfTestModule.GlobalWorkerOptions.workerSrc, root + 'pdf.worker.mjs');
    assert.equal(state.documentOptions.standardFontDataUrl, root + 'standard_fonts/'); assert.equal(state.documentOptions.cMapUrl, root + 'cmaps/');
    assert.equal(state.renders, 1); assert.equal(state.textReads, 0); assert(!d.querySelector('.pdf-text-version'));
  });
}

test('PDF previews redraw only on width changes, zoom and paging, and stop when closed', async t => {
  const { d, state, observers, open } = await pdfPreview('http://localhost/', '/views/uploads.js');
  // Width changes are debounced for 120 ms; drive the clock instead of sleeping.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const advance = async milliseconds => { t.mock.timers.tick(milliseconds); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  const host = open(); await advance(0);
  const observer = observers.find(o => o.el === host);
  assert.equal(state.renders, 1);
  // Initial and height-only resize callbacks keep the original canvas.
  const canvas = d.querySelector('.pdf-surface canvas'); observer.fn(); observer.fn(); await advance(150); assert.equal(state.renders, 1); assert.strictEqual(d.querySelector('.pdf-surface canvas'), canvas);
  d.querySelector('[data-pdf-fit]').click(); await advance(0); assert.equal(state.renders, 1);
  Object.defineProperty(host, 'clientWidth', { value: 620, configurable: true }); observer.fn(); observer.fn(); await advance(150); assert.equal(state.renders, 2); assert.equal(state.fades, 1);
  d.querySelector('[data-pdf-in]').click(); await advance(0); assert.equal(state.renders, 3); assert.equal(state.fades, 1);
  d.querySelector('[data-pdf-next]').click(); await advance(0); assert.equal(state.renders, 4); assert.equal(state.fades, 2); assert.equal(d.querySelector('[data-pdf-page]').textContent, 'Page 2 of 2');
  // A pending resize cannot redraw after closing or replace another preview.
  Object.defineProperty(host, 'clientWidth', { value: 500, configurable: true }); observer.fn(); d.querySelector('[data-file-close]').click(); await advance(150); assert.equal(state.renders, 4); assert(observer.stopped);
  open(); await advance(0); assert.equal(state.renders, 5);
  const retention = d.querySelector('[data-file-retention]');
  assert.equal(retention.parentElement, d.querySelector('[data-file-ephemeral]').parentElement); assert(retention.parentElement.querySelector('.retention-help')); assert(d.querySelector('.file-overlay > .retention-tooltip'));
  // Restore real timers before the harness closes the window, so it can clear
  // the real timers that were started before the clock was mocked.
  t.mock.timers.reset();
});

test('read-only collections open in the file dialog with their path and date, never retention controls', async () => {
  const t = bootApp({ route: 'board' });
  let readable = true;
  const file = { id: 'knowledge:p1:guides/setup.md:v1', name: 'setup.md', path: 'docs/guides/setup.md', size: 12, updatedAt: 1_700_000_000, previewKind: 'image', state: 'available', url: 'blob:knowledge', contentUrl: 'blob:knowledge', downloadUrl: '/api/projects/p1/knowledge/download?path=guides%2Fsetup.md' };
  t.w.Uploads.previewCollection([file], file.id, () => readable);
  const dialog = t.d.querySelector('.file-dialog');
  assert(dialog, 'the dialog opens');
  const details = dialog.querySelector('.file-info dl').textContent;
  assert.match(details, /Path.*docs\/guides\/setup\.md/s);
  assert.match(details, /Updated/);
  assert.doesNotMatch(details, /Uploaded by|Retention/);
  assert.equal(dialog.querySelector('[data-file-download]').getAttribute('href'), file.downloadUrl);
  assert(dialog.querySelector('.file-navigation').hidden);
  readable = false;
  t.w.Uploads.validateAccess();
  assert.equal(t.d.querySelector('.file-overlay:not([data-motion-exiting]) .file-dialog'), null, 'losing access closes it');
  t.w.Uploads.previewCollection([file], file.id, () => false);
  assert.equal(t.d.querySelector('.file-overlay:not([data-motion-exiting])'), null, 'an unreadable collection never opens');
});

test('inline image previews work outside the dialog and stop when disposed', async () => {
  const t = bootApp({ route: 'board' });
  const host = t.d.createElement('div'), tools = t.d.createElement('div');
  t.d.body.append(tools, host);
  const dispose = t.w.Uploads.mountInlinePreview(host, { id: 'inline-image', name: 'logo.png', size: 10, previewKind: 'image', url: 'blob:logo' }, tools);
  assert.equal(host.querySelector('img').getAttribute('src'), 'blob:logo');
  assert(tools.querySelector('.image-controls'), 'zoom controls move to the page header');
  assert.equal(t.d.querySelector('.file-dialog'), null);
  tools.querySelector('[data-image-in]').click();
  assert.equal(tools.querySelector('[data-image-out]').disabled, false);
  dispose();
  assert.equal(typeof dispose, 'function');
});

test('an upload, retention change and delete still finish after a live update replaced the task', async () => {
  const pending = [];
  const file = (overrides = {}) => ({ id: 'f1', name: 'notes.txt', size: 5, mediaType: 'text/plain', previewKind: 'text', isEphemeral: false, uploadedBy: 'taylorwu', uploadedAt: 1, lastAccessedAt: 1, state: 'available', revision: 1, contentUrl: '/content', downloadUrl: '/download', ...overrides });
  const held = name => () => new Promise(resolve => pending.push({ name, resolve }));
  const t = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').internalId = 'bir-079'; }, setup: w => {
    w.OneloopTransport = { api: { attachments: async () => ({ items: [] }), uploadAttachment: held('upload'), updateAttachment: held('retention'), deleteAttachment: held('delete') }, subscribe: () => () => {} };
  } });
  const replace = () => { const current = t.D.tasks.find(item => item.id === 'BIR-079'), copy = { ...current, attachments: [...(current.attachments || [])].map(item => ({ ...item })) }; t.D.tasks.splice(t.D.tasks.indexOf(current), 1, copy); return copy; };
  const answer = async (name, value) => { await waitFor(() => pending.some(item => item.name === name), `${name} was sent`); replace(); pending.find(item => item.name === name).resolve(value); };
  const notices = []; const toast = t.A.toast; t.A.toast = (text, kind) => { notices.push(text); return toast(text, kind); };
  t.A.attachFiles('BIR-079', { files: [new t.w.File(['notes'], 'notes.txt', { type: 'text/plain' })], value: '' });
  await answer('upload', file());
  await waitFor(() => notices.includes('Attachment added'), 'the upload completes');
  assert.equal(t.D.tasks.find(item => item.id === 'BIR-079').attachments.filter(item => item.id === 'f1').length, 1);
  assert.equal(t.d.querySelector('.upload-row'), null, 'no failed upload row offers Retry');
  t.A.setAttachmentTemporary('BIR-079', 'f1', true);
  await answer('retention', file({ isEphemeral: true, revision: 2 }));
  await waitFor(() => notices.includes('Attachment marked temporary'), 'the retention change completes');
  assert.equal(t.D.tasks.find(item => item.id === 'BIR-079').attachments[0].ephemeral, true);
  t.A.delAttachment('BIR-079', 0); t.d.querySelector('[data-confirm-accept]').click();
  await answer('delete', {});
  await waitFor(() => notices.includes('Attachment deleted'), 'the delete completes');
  assert.deepEqual(t.D.tasks.find(item => item.id === 'BIR-079').attachments, []);
});

test('live updates read attachments and storage usage again passively', async () => {
  const reads = [];
  let listener = () => {};
  const t = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').internalId = 'bir-079'; }, setup: w => {
    w.OneloopTransport = { api: {
      attachments: async (_id, options = {}) => { reads.push(['attachments', !!options.background]); return { items: [] }; },
      storageUsage: async (options = {}) => { reads.push(['storage', !!options.background]); return { budgetBytes: 100, highWatermarkBytes: 90, lowWatermarkBytes: 80, usedBytes: 1, permanentBytes: 1, temporaryBytes: 0, cleanedRecords: 0, reservedBytes: 0, projects: [], recentCleanup: [] }; },
      uploadAttachment() {},
    }, subscribe: fn => { listener = fn; return () => {}; } };
  } });
  // Each read answers at once; let its reply land before the next step.
  const answered = async (count, message) => { await waitFor(() => reads.length === count, message); await new Promise(resolve => setImmediate(resolve)); };
  await answered(1, 'the task page reads its attachments');
  listener({ type: 'sse', taskId: 'BIR-079', entityType: 'task' });
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
