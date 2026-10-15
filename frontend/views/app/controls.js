// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* Form controls: selects, date fields with a calendar, field errors and
   labels, and the cleaning of typed and pasted text. */

import { UIMotion } from '../../src/app/motion.js';
import { I, UIAction, d, esc, humanFull, iso, setHTML, today } from './format.js';
import { App, recovery } from './model.js';
import { POP, closePop, openPop, placePop, rememberOpener, restoreOpener } from './overlays.js';

// Popovers are imperative on purpose: opening one never re-renders the app,
// so text already typed into a form is never lost. A select or date field's
// definition is kept by its key until the next render replaces it.
const SELS = {}, DPS = {};

function setFieldError(control, wrap, message, className = 'ferr') {
  if (!control || !wrap) return;
  if (!control.id) control.id = 'field-error-control-' + (++fieldSequence);
  const id = control.id + '-error';
  const descriptions = new Set((control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  let error = document.getElementById(id) || wrap.querySelector('.ferr');
  if (message) {
    if (!error) { error = document.createElement('div'); wrap.append(error); }
    error.id = id; error.className = className; error.setAttribute('role', 'alert'); error.textContent = message;
    descriptions.add(id); control.classList.add('invalid'); control.setAttribute('aria-invalid', 'true');
  } else {
    if (error) descriptions.delete(error.id);
    descriptions.delete(id); error?.remove(); control.classList.remove('invalid'); control.removeAttribute('aria-invalid');
  }
  if (descriptions.size) control.setAttribute('aria-describedby', [...descriptions].join(' '));
  else control.removeAttribute('aria-describedby');
}

function clearFieldError(control) {
  setFieldError(control, control.closest('.field, .task-title-field, .date-field') || control.parentNode, '');
}

function failField(form, name, msg) {
  const inp = form.querySelector(`[name="${name}"]`);
  if (!inp) return false;
  const wrap = inp.closest('.field') || inp.parentNode;
  const ctl = inp.matches('input:not([type=hidden]),textarea') ? inp : wrap.querySelector('.ctl');
  setFieldError(ctl, wrap, msg);
  ctl?.focus();
  return false;
}

export function selectHtml(key, def) {
  SELS[key] = def;
  const cur = def.options.find((o) => o.v === def.value);
  return `<div class="sel"${def.width ? ` style="width:${def.width}px"` : ''}>
    ${def.name ? `<input type="hidden" name="${def.name}" value="${esc(def.value ?? '')}">` : ''}
    <button type="button" id="select-${esc(key)}" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="${def.label ? `select-${key}-name ` : ''}select-${key}-value" class="ctl sel-btn${def.cls ? ' ' + def.cls : ''}${cur ? '' : ' empty'}" data-tip="${esc(cur ? cur.l : (def.placeholder || 'Select'))}" data-tip-overflow ${def.disabled ? 'disabled' : UIAction('popSelect', UIAction.event, key)}>${def.label ? `<span class="sr-only" id="select-${esc(key)}-name">${esc(def.label)}</span>` : ''}${def.icon || ''}<span id="select-${esc(key)}-value" class="sel-label">${esc(cur ? cur.l : (def.placeholder || 'Select'))}</span>${def.cls ? '' : I.chev}</button>
  </div>`;
}
export const MULTI = {};

export function multiHtml(key, def) {
  MULTI[key] = def;
  const label = def.summary();
  return `<div class="sel"${def.width ? ` style="width:${def.width}px"` : ''}>
    <button type="button" data-filter-key="${esc(key)}" aria-expanded="false" class="ctl sel-btn${def.cls ? ' ' + def.cls : ''}${def.values().length ? '' : ' empty'}" data-tip="${esc(label)}" data-tip-overflow ${def.label ? `aria-label="${esc(def.label)}"` : ''} ${def.disabled ? 'disabled' : UIAction('popMulti', UIAction.event, key)}>${def.icon ? def.icon() : ''}<span class="sel-label">${esc(label)}</span>${def.cls ? '' : I.chev}</button>
  </div>`;
}

// Date values always use ISO. The editor owns separators; users enter digits.
function parseDateInput(raw) {
  const text = String(raw ?? '');
  if (!text) return '';
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!parts) return null;
  const [, year, month, day] = parts;
  const y = Number(year), m = Number(month), n = Number(day);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || n < 1 || n > 31) return null;
  const dt = new Date(0); dt.setUTCFullYear(y, m - 1, n);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== n) return null;
  return text;
}

function formatDateDigits(raw) {
  const digits = String(raw).replace(/[^0-9]/g, '').slice(0, 8);
  return digits.slice(0, 4) + (digits.length >= 4 ? '-' + digits.slice(4, 6) : '') + (digits.length >= 6 ? '-' + digits.slice(6, 8) : '');
}

function digitCaret(value, count) {
  if (!count) return 0;
  let seen = 0, pos = 0;
  while (pos < value.length && seen < count) { if (/[0-9]/.test(value[pos])) seen++; pos++; }
  while (value[pos] === '-') pos++;
  return pos;
}

function inputKind(input) {
  if (input.classList.contains('date-text')) return 'date';
  if (input.name === 'username') return 'username';
  if (input.name === 'key') return 'key';
  return 'text';
}

function sanitizeInputValue(input, value) {
  if (input.type === 'password') return value;
  const kind = inputKind(input);
  if (input.classList.contains('tp-title')) value = value.replace(/[\r\n\t]+/g, ' ');
  if (kind === 'date') return formatDateDigits(value);
  if (kind === 'username') return value.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 32);
  if (kind === 'key') return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return value.replace(input.tagName === 'TEXTAREA' ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g : /[\x00-\x1f\x7f]/g, '');
}

// Cut text to `max` UTF-16 units, as maxlength counts them, without splitting
// a character: half of a surrogate pair cannot be saved.
function clampText(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 32);
  const parts = typeof Intl.Segmenter === 'function' ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(head), part => part.segment) : Array.from(head);
  let out = '';
  for (const part of parts) { if (out.length + part.length > max) break; out += part; }
  return out;
}

function insertCleanText(input, text) {
  const kind = inputKind(input), old = input.value;
  const from = input.selectionStart ?? old.length, to = input.selectionEnd ?? from;
  let fragment = kind === 'username' ? text.toLowerCase().replace(/[^a-z0-9._-]/g, '')
    : kind === 'key' ? text.toUpperCase().replace(/[^A-Z0-9]/g, '')
    : sanitizeInputValue(input, text);
  if (!fragment && text) return;
  if (input.maxLength >= 0) fragment = clampText(fragment, Math.max(0, input.maxLength - (old.length - (to - from))));
  const prefix = old.slice(0, from) + fragment;
  input.value = sanitizeInputValue(input, prefix + old.slice(to));
  const caret = Math.min(sanitizeInputValue(input, prefix).length, input.value.length);
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function editableText(input) {
  return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement && ['text','search','url','email','tel','password'].includes(input.type);
}

function normalizeInput(input) {
  if (!editableText(input) || input.disabled || input.readOnly || input.type === 'password') return;
  const old = input.value, caret = input.selectionStart ?? old.length;
  const value = sanitizeInputValue(input, old);
  if (value === old) return;
  const next = inputKind(input) === 'date' ? digitCaret(value, old.slice(0, caret).replace(/[^0-9]/g, '').length) : sanitizeInputValue(input, old.slice(0, caret)).length;
  input.value = value; input.setSelectionRange(next, next);
}

function editDateDigits(input, text, deletion) {
  const value = input.value;
  let from = value.slice(0, input.selectionStart).replace(/[^0-9]/g, '').length;
  let to = value.slice(0, input.selectionEnd).replace(/[^0-9]/g, '').length;
  const digits = value.replace(/[^0-9]/g, '');
  if (deletion && from === to) {
    if (deletion.includes('Backward')) from = Math.max(0, from - 1);
    else to = Math.min(digits.length, to + 1);
  }
  const inserted = text.replace(/[^0-9]/g, '').slice(0, Math.max(0, 8 - (digits.length - (to - from))));
  input.value = formatDateDigits(digits.slice(0, from) + inserted + digits.slice(to));
  const caret = digitCaret(input.value, from + inserted.length);
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function dateError(def, value) {
  if (value === null) return 'Enter a valid date in YYYY-MM-DD format.';
  if (!value) return def.clearable ? '' : 'Enter a date.';
  const min = def.min?.(), max = def.max?.();
  if (min && value < min) return def.minError || 'Date is before the allowed start.';
  if (max && value > max) return def.maxError || 'Date is after the allowed end.';
  return '';
}

function dateFieldError(wrap, message, focus = false) {
  const input = wrap.querySelector('.date-text');
  setFieldError(input, wrap, message, 'ferr date-error');
  if (message && focus) input.focus();
  return !message;
}

export function dateValue(key) {
  const input = document.querySelector(`[data-date-key="${esc(key)}"] .date-text`);
  return input ? parseDateInput(input.value) : '';
}

function commitDate(key, raw, focusError = false) {
  const def = DPS[key], wrap = document.querySelector(`[data-date-key="${esc(key)}"]`);
  if (!def || def.disabled || !wrap) return false;
  const value = parseDateInput(raw), error = dateError(def, value);
  if (error) return dateFieldError(wrap, error, focusError);
  const sending = value !== (def.value || '') && !!def.pick, result = sending ? def.pick(value) : true;
  if (result === false) { if (def.autosave) wrap.querySelector('.date-text').toggleAttribute('data-unsaved', true); return false; }
  const previous = def.value;
  def.value = value;
  wrap.querySelector('input[type="hidden"]').value = value;
  wrap.querySelector('.date-text').value = value || '';
  // A date that saves itself counts as saved once the server accepted it,
  // though it may keep focus, as after Enter. One the server refused counts
  // again, also once focus leaves it, and the next Enter or Tab sends it again.
  if (def.autosave) {
    const settled = (saved) => {
      const current = document.querySelector(`[data-date-key="${esc(key)}"]`), input = current?.querySelector('.date-text'), shown = !!input && parseDateInput(input.value) === value;
      if (saved !== false) { if (shown) { recovery.markSaved(input); input.removeAttribute('data-unsaved'); } return; }
      if (DPS[key] !== def || def.value !== value) return;
      def.value = previous;
      const hidden = current?.querySelector('input[type="hidden"]'); if (hidden) hidden.value = previous || '';
      if (shown) input.toggleAttribute('data-unsaved', true);
    };
    if (sending && typeof result?.then === 'function') { def.pending = value; result.then((saved) => { if (def.pending === value) def.pending = null; settled(saved); }); }
    else if (def.pending !== value) settled(result);
  }
  dateFieldError(wrap, '');
  // A corrected range can resolve the other field's error as well.
  const scope = wrap.closest('form') || wrap.parentElement;
  scope.querySelectorAll('.date-field').forEach((other) => {
    if (other === wrap) return;
    const input = other.querySelector('.date-text');
    if (input.getAttribute('aria-invalid') === 'true' && !dateError(DPS[other.dataset.dateKey], parseDateInput(input.value))) dateFieldError(other, '');
  });
  return true;
}

function validateFormDates(form) {
  let firstInvalid;
  form.querySelectorAll('.date-field').forEach((wrap) => {
    const input = wrap.querySelector('.date-text');
    if (!commitDate(wrap.dataset.dateKey, input.value) && !firstInvalid) firstInvalid = input;
  });
  if (firstInvalid) firstInvalid.focus();
  return !firstInvalid;
}

export function dateHtml(key, def) {
  DPS[key] = def;
  const label = def.label || ({ start: 'Start date', end: 'End date', date: 'Date', _start: 'Start date', _dl: 'Deadline' }[def.name]) || 'Date';
  const placeholder = def.disabled ? 'Not set' : def.placeholder || (label === 'Date' ? 'Select date' : 'Set ' + label.toLowerCase());
  return `<div class="sel date-field${def.cls ? ' ' + def.cls : ''}" data-date-key="${esc(key)}">
    <input type="hidden" name="${def.name}" value="${esc(def.value || '')}">
    ${def.cls && !def.hideLabel ? `<div class="date-inline-label">${label}${def.clearable ? optionalMark : ''}</div>` : ''}<div class="date-control"><input type="text" class="ctl date-text" id="${esc(key)}-input" ${def.autosave ? 'data-autosave ' : ''}${def.clearable ? 'aria-required="false"' : 'required aria-required="true"'} aria-label="${label}" value="${esc(def.value || '')}" placeholder="${esc(placeholder)}" aria-description="Type a date in YYYY-MM-DD format or use the calendar." maxlength="10" inputmode="numeric" autocomplete="off" spellcheck="false" ${def.disabled ? 'disabled' : `${UIAction.on('input', 'dateTyping', key)} ${UIAction.on('blur', 'dateBlur', UIAction.event, key)} ${UIAction.on('keydown', 'dateKey', UIAction.event, key)}`}>
    <button type="button" class="date-trigger sel-btn" aria-label="Open ${label.toLowerCase()} calendar" aria-haspopup="dialog" aria-expanded="false" ${def.disabled ? 'disabled' : UIAction('popDate', UIAction.event, key)}>${def.icon || I.cal}</button></div>
  </div>`;
}

function calHtml(view, selected, focusDate, def) {
  const [, mo] = view.split('-').map(Number);
  const first = d(view + '-01');
  const gridStart = new Date(first); gridStart.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const dt = new Date(gridStart); dt.setUTCDate(gridStart.getUTCDate() + i);
    const ds = iso(dt);
    const cls = ['cal-d', dt.getUTCMonth() !== mo - 1 ? 'out' : '', ds === iso(today) ? 'today' : '', ds === selected ? 'sel' : '', ds === focusDate ? 'focus' : ''].join(' ');
    cells += `<button type="button" class="${cls}" data-d="${esc(ds)}" aria-label="${humanFull(ds)}" aria-pressed="${ds === selected}" tabindex="${ds === focusDate ? 0 : -1}" ${dateError(def, parseDateInput(ds)) ? 'disabled' : ''}>${dt.getUTCDate()}</button>`;
  }
  return `<div class="cal">
    <div class="cal-head">
      <button type="button" class="btn icon" data-nav="-1" aria-label="Previous month">‹</button>
      <span class="cal-title">${first.toLocaleDateString('en-US', { timeZone:'UTC', month: 'long', year: 'numeric' })}</span>
      <button type="button" class="btn icon" data-nav="1" aria-label="Next month">›</button>
    </div>
    <div class="cal-grid">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((w) => `<div class="cal-wd">${w}</div>`).join('')}${cells}</div>
    <div class="cal-foot">
      <button type="button" class="btn quiet" data-today ${dateError(def, iso(today)) ? 'disabled' : ''}>Today</button>
      ${def.clearable ? '<button type="button" class="btn quiet" data-clear>Clear</button>' : ''}
    </div>
  </div>`;
}

// ---------- field labels ----------
export const optionalMark = '<span class="optional-mark">Optional</span>';
const fieldPlaceholders = {
  Username: 'alex', 'Full name': 'First and last name',
  Password: 'Enter password', 'Current password': 'Current password',
  'New password': 'New password', Confirm: 'Repeat password',
  Name: 'Customer portal', 'Task prefix': 'APP',
  Description: 'Scope and outcome', Goal: 'Target outcome',
};
let fieldSequence = 0;

/** Number field labels from the start again, so a page drawn again keeps its IDs. */
export function resetFieldIds() { fieldSequence = 0; }

export function field(label, inner, optional = false) {
  let targetId = '';
  inner = inner.replace(/<(input|textarea)\b([^>]*)>/g, (match, tag, attrs) => {
    if (/\bdisabled\b|type="(?:hidden|file|checkbox)"/.test(attrs)) return match;
    if (!/\bplaceholder=/.test(attrs)) attrs += ` placeholder="${esc(fieldPlaceholders[label] || label)}"`;
    attrs = attrs.replace(/\srequired\b/g, '').replace(/\saria-required="[^"]*"/g, '');
    return `<${tag}${attrs}${optional ? ' aria-required="false"' : ' required aria-required="true"'}>`;
  });
  inner = inner.replace(/<(input|textarea|button)\b([^>]*)>/g, (match, tag, attrs) => {
    if (targetId || /type="(?:hidden|file|checkbox)"/.test(attrs)) return match;
    if (tag === 'button' && !/\bsel-btn\b/.test(attrs)) return match;
    targetId = /\bid="([^"]+)"/.exec(attrs)?.[1] || `field-${++fieldSequence}`;
    if(tag==='button'&&/\bsel-btn\b/.test(attrs)&&attrs.includes('aria-haspopup="listbox"')){
      const valueId=/id="([^"]+)" class="sel-label"/.exec(inner)?.[1];
      attrs=attrs.replace(/\saria-labelledby="[^"]*"/,'')+` aria-labelledby="${targetId}-label${valueId?' '+valueId:''}"`;
    }
    return `<${tag}${/\bid=/.test(attrs) ? attrs : `${attrs} id="${esc(targetId)}"`}>`;
  });
  return `<div class="field" data-required="${esc(!optional)}"><label${targetId ? ` id="${esc(targetId)}-label" for="${esc(targetId)}"` : ''}>${label}${optional ? optionalMark : ''}</label>${inner}</div>`;
}

// ---------- input cleaning and required fields ----------
document.addEventListener('mousedown', (e) => {
  if (POP.el && !POP.el.contains(e.target) && !e.target.closest('.sel-btn')) closePop();
});

document.addEventListener('submit', (e) => {
  const form = e.target;
  for (const field of form.querySelectorAll('.field[data-required="true"]')) {
    const input = field.querySelector('input:not(:disabled), textarea:not(:disabled)');
    if (!input || ['checkbox','file'].includes(input.type)) continue;
    const value = input.type === 'password' ? input.value : input.value.trim();
    if (value) continue;
    e.preventDefault(); e.stopImmediatePropagation();
    const ctl = field.querySelector('.ctl');
    if (input.name) failField(form, input.name, 'This field is required.');
    else { ctl?.focus(); ctl?.classList.add('invalid'); }
    return;
  }
}, true);

document.addEventListener('beforeinput', (e) => {
  const input = e.target;
  if (!editableText(input) || input.disabled || input.readOnly || input.type === 'password' || e.isComposing) return;
  if (input.classList.contains('tp-title') && ['insertLineBreak', 'insertParagraph'].includes(e.inputType)) { e.preventDefault(); return; }
  if (inputKind(input) === 'date') {
    if (e.inputType.startsWith('delete')) {
      if (!e.cancelable) return;
      e.preventDefault(); editDateDigits(input, '', e.inputType); return;
    }
    if (e.inputType.startsWith('insert') && e.data !== null) {
      if (!e.cancelable) return;
      e.preventDefault();
      const digits = e.data.replace(/[^0-9]/g, '');
      if (digits) editDateDigits(input, digits);
      return;
    }
  } else if (e.data !== null && e.inputType.startsWith('insert')) {
    const from = input.selectionStart, to = input.selectionEnd;
    const proposed = input.value.slice(0, from) + e.data + input.value.slice(to);
    const clean = sanitizeInputValue(input, proposed);
    if (clean !== proposed && e.cancelable) {
      e.preventDefault(); insertCleanText(input, e.data);
    }
  }
}, true);

document.addEventListener('paste', (e) => {
  const input = e.target;
  if (!editableText(input) || input.disabled || input.readOnly || input.type === 'password') return;
  const text = e.clipboardData?.getData('text');
  if (text === undefined) return;
  if (inputKind(input) === 'date') { e.preventDefault(); if (/[0-9]/.test(text)) editDateDigits(input, text); }
  else if (sanitizeInputValue(input, text) !== text) { e.preventDefault(); insertCleanText(input, text); }
}, true);

document.addEventListener('input', (e) => { if (!e.isComposing) normalizeInput(e.target); }, true);

document.addEventListener('compositionend', (e) => { normalizeInput(e.target); }, true);

document.addEventListener('input', (e) => {
  if (e.target.classList && (e.target.classList.contains('ctl') || e.target.classList.contains('tp-title'))) clearFieldError(e.target);
});

Object.assign(App, {
  validateFormDates,
  fieldError: failField,
  popMulti(ev, key) {
    ev.preventDefault();
    if (POP.id === 'ms:' + key) { closePop(); return; }
    const def = MULTI[key];
    const btn = ev.currentTarget;
    const el = openPop(btn, Math.max(btn.getBoundingClientRect().width, 220));
    POP.id = 'ms:' + key;
    el.id='multi-'+key;POP.trigger=btn;btn.setAttribute('aria-expanded','true');btn.setAttribute('aria-controls',el.id);
    POP.onClose = def.onClose || null;
    let q = '';
    const row = (o) => `<button type="button" class="pop-opt multi${def.values().includes(o.v) ? ' on' : ''}" aria-pressed="${def.values().includes(o.v)}" data-v="${esc(o.v)}">
        <span class="chk">${def.values().includes(o.v) ? I.tick : ''}</span>
        <span class="pop-opt-text"><span class="l">${esc(o.l)}</span>${o.sub ? `<span class="s">${esc(o.sub)}</span>` : ''}</span></button>`;
    const paint = () => {
      const opts = q ? def.options.filter((o) => o.l.toLowerCase().includes(q) || (o.sub || '').toLowerCase().includes(q)) : def.options;
      const pinned = opts.filter((o) => o.pinned), rest = opts.filter((o) => !o.pinned);
      const list = el.querySelector('.pop-list');
      setHTML(list,(pinned.length ? pinned.map(row).join('') + '<div class="pop-sep"></div>' : '') + rest.map(row).join('') || '<div class="pop-empty">No matches</div>');
      const foot = el.querySelector('.pop-foot');
      if (foot) foot.style.display = def.values().length && def.clear ? '' : 'none';
      [...list.querySelectorAll('.pop-opt')].forEach((oel) => oel.addEventListener('click', () => {
        const focused=document.activeElement===oel,value=oel.dataset.v;def.toggle(value);
        btn.querySelector('.sel-label').textContent = def.summary(); btn.dataset.tip = def.summary();
        btn.classList.toggle('empty', !def.values().length);
        paint();if(focused)[...list.querySelectorAll('.pop-opt')].find(option=>option.dataset.v===value)?.focus({preventScroll:true});
      }));
      placePop(btn);
    };
    setHTML(el,`${def.search ? '<div class="pop-search-wrap"><input class="pop-search" type="text" placeholder="Search options" spellcheck="false"></div>' : ''}<div class="pop-list"></div>${def.clear ? '<div class="pop-foot"><button type="button" class="btn quiet">Clear</button></div>' : ''}`);
    paint();
    requestAnimationFrame(() => { if (POP.el === el) placePop(btn); });
    const input = el.querySelector('.pop-search');
    if (input) { input.focus(); input.addEventListener('input', () => { q = input.value.trim().toLowerCase(); paint(); }); }
    const foot = el.querySelector('.pop-foot button');
    if (foot) foot.addEventListener('click', () => { def.clear(); btn.querySelector('.sel-label').textContent = def.summary(); btn.dataset.tip = def.summary(); btn.classList.add('empty'); paint(); });
    POP.onKey = (e) => {
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closePop();btn.focus({preventScroll:true});}
      else if(e.key==='Tab')closePop();
      else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const rows=[...el.querySelectorAll('.pop-opt')],index=rows.indexOf(document.activeElement),next=index<0?(e.key==='ArrowDown'?0:rows.length-1):Math.max(0,Math.min(rows.length-1,index+(e.key==='ArrowDown'?1:-1)));rows[next]?.focus();}
      else if((e.key==='Enter'||e.key===' ')&&document.activeElement?.matches('.pop-opt.multi')&&el.contains(document.activeElement)){e.preventDefault();document.activeElement.click();}
    };
    document.addEventListener('keydown', POP.onKey, true);
  },

  // popover components
  popSelect(ev, key) {
    ev.preventDefault();
    if (POP.id === 'sel:' + key) { closePop(); return; }
    const def = SELS[key];
    const btn = ev.currentTarget;
    const hid = btn.parentNode.querySelector('input[type="hidden"]');
    const cur = hid ? hid.value : def.value;
    const searchable = def.search || def.options.length > 7;
    const el = openPop(btn);
    POP.id = 'sel:' + key;POP.trigger=btn;btn.setAttribute('aria-expanded','true');btn.setAttribute('aria-controls',`select-${key}-list`);
    setHTML(el,`${searchable ? '<div class="pop-search-wrap"><input class="pop-search" type="text" placeholder="Search options" spellcheck="false"></div>' : ''}<div class="pop-list"></div>`);
    const listEl = el.querySelector('.pop-list');
    const input = el.querySelector('.pop-search');
    listEl.id=`select-${key}-list`;listEl.setAttribute('role','listbox');listEl.setAttribute('aria-labelledby',btn.id);
    const focusOwner=input||listEl;focusOwner.tabIndex=0;
    if(input){input.setAttribute('role','combobox');input.setAttribute('aria-label',btn.textContent.trim());input.setAttribute('aria-expanded','true');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',listEl.id);}
    let q = '', filtered = def.options, idx = -1;

    const pick = (o) => {
      const returnFocus = rememberOpener(btn);
      closePop();
      if (hid) hid.value = o.v;
      def.value = o.v;
      btn.classList.toggle('empty', o.v === '' || o.v == null);
      btn.querySelector('.sel-label').textContent = o.l; btn.dataset.tip = o.l;
      clearFieldError(btn);
      if (def.pick) def.pick(o.v);
      restoreOpener(returnFocus);
    };
    const setIdx = (i) => {
      idx = i;
      [...listEl.children].forEach((oel, j) => oel.classList && oel.classList.toggle('focus', j === i));
      const f = listEl.children[i];if(f)focusOwner.setAttribute('aria-activedescendant',f.id);else focusOwner.removeAttribute('aria-activedescendant'); if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest' });
    };
    const paintList = () => {
      filtered = q ? def.options.filter((o) => o.l.toLowerCase().includes(q)) : def.options;
      setHTML(listEl,filtered.length
        ? filtered.map((o,i) => `<button type="button" role="option" tabindex="-1" id="select-${esc(key)}-option-${esc(i)}" aria-selected="${o.v === cur}" class="pop-opt${o.v === cur ? ' on' : ''}"><span class="option-label">${o.icon || ''}<span>${esc(o.l)}</span></span>${o.v === cur ? I.tick : ''}</button>`).join('')
        : '<div class="pop-empty">No matches</div>');
      [...listEl.querySelectorAll('.pop-opt')].forEach((oel, i) => {
        oel.addEventListener('click', () => pick(filtered[i]));
        oel.addEventListener('mousemove', () => idx !== i && setIdx(i));
      });
      const curIdx = filtered.findIndex((o) => o.v === cur);
      setIdx(curIdx >= 0 ? curIdx : (filtered.length ? 0 : -1));
      placePop(btn);
    };
    paintList();
    if(!input)listEl.focus();
    requestAnimationFrame(() => { if (POP.el === el) placePop(btn); });
    if (input) {
      input.focus();
      input.addEventListener('input', () => { q = input.value.trim().toLowerCase(); paintList(); });
    }
    POP.onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); restoreOpener(rememberOpener(btn)); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (filtered.length) setIdx(Math.min(idx + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (filtered.length) setIdx(Math.max(idx - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); if (idx >= 0 && filtered[idx]) pick(filtered[idx]); }
      else if (e.key === 'Tab') { closePop(); if (btn.isConnected) btn.focus({preventScroll:true}); }
    };
    document.addEventListener('keydown', POP.onKey, true);
  },
  dateTyping(key) {
    const wrap = document.querySelector(`[data-date-key="${esc(key)}"]`);
    if (wrap) { normalizeInput(wrap.querySelector('.date-text')); dateFieldError(wrap, ''); }
  },
  dateBlur(ev, key) {
    if(App.isRendering())return;
    if (POP.id === 'dp:' + key) return;
    commitDate(key, ev.target.value);
  },
  dateKey(ev, key) {
    if (ev.isComposing||ev.keyCode===229) return;
    if(ev.key==='Enter'&&ev.repeat){ev.preventDefault();return;}
    if (ev.key === 'Enter') { ev.preventDefault(); commitDate(key, ev.target.value, true); }
    else if (ev.key === 'Escape') {
      // Escape closes the calendar or undoes the typing first; with nothing to undo, it goes on to the dialog.
      const undoes = POP.id === 'dp:' + key || ev.target.value !== (DPS[key].value || '');
      closePop(true);
      ev.target.value = DPS[key].value || ''; ev.target.removeAttribute('data-unsaved');
      dateFieldError(ev.target.closest('.date-field'), '');
      if (undoes) { ev.preventDefault(); ev.stopPropagation(); }
    } else if (ev.key === 'ArrowDown' && ev.altKey) {
      ev.preventDefault(); ev.target.closest('.date-field').querySelector('.date-trigger').click();
    }
  },
  popDate(ev, key) {
    ev.preventDefault();
    const def = DPS[key];
    if (!def || def.disabled) return;
    const btn = ev.currentTarget, wrap = btn.closest('.date-field'), input = wrap.querySelector('.date-text');
    if (POP.id === 'dp:' + key) { closePop(true); input.focus(); return; }
    const enteredDate = parseDateInput(input.value);
    let focusDate = enteredDate || def.value || iso(today);
    let view = focusDate.slice(0, 7);
    const el = openPop(wrap.querySelector('.date-control'), 262);
    POP.id = 'dp:' + key; POP.dateTrigger = btn;
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', input.getAttribute('aria-label') + ' calendar');
    btn.setAttribute('aria-expanded', 'true');
    POP.onClose = () => { if (input.isConnected) commitDate(key, input.value); };
    const pick = (ds) => {
      if (!commitDate(key, ds)) return;
      closePop(); input.focus();
    };
    const paint = (focus = false) => {
      const changedMonth=el.dataset.month&&el.dataset.month!==view;el.dataset.month=view;
      setHTML(el,calHtml(view, enteredDate === null ? def.value : enteredDate, focusDate, def));
      placePop(wrap.querySelector('.date-control'));if(changedMonth)UIMotion.fade(el.querySelector('.cal-grid'));
      el.querySelectorAll('.cal-d').forEach((b) => b.addEventListener('click', () => pick(b.dataset.d)));
      el.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
        const target = d(view + '-01'); target.setUTCMonth(target.getUTCMonth() + Number(b.dataset.nav));
        if (target.getUTCFullYear() < 1 || target.getUTCFullYear() > 9999) return;
        view = iso(target).slice(0, 7); focusDate = iso(target); paint(true);
      }));
      el.querySelector('[data-today]').addEventListener('click', () => pick(iso(today)));
      const clear = el.querySelector('[data-clear]'); if (clear) clear.addEventListener('click', () => pick(''));
      if (focus) (el.querySelector(`.cal-d[data-d="${esc(focusDate)}"]:not(:disabled)`) || el.querySelector('.cal-d:not(:disabled)') || el.querySelector('[data-nav]')).focus();
    };
    paint(true);
    POP.onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(true); input.focus(); return; }
      if (e.key === 'Tab') { closePop(); input.focus(); return; }
      if (!el.contains(e.target) || !e.target.matches('.cal-d')) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (step) {
        e.preventDefault(); const next = d(e.target.dataset.d); next.setUTCDate(next.getUTCDate() + step);
        const candidate = parseDateInput(iso(next));
        if (!candidate || dateError(def, candidate)) return;
        focusDate = candidate; view = focusDate.slice(0, 7); paint(true);
      }
    };
    document.addEventListener('keydown', POP.onKey, true);
  },
});
