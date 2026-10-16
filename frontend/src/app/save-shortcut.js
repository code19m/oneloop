// @ts-check

/**
 * Cmd+S on Apple devices and Ctrl+S elsewhere save what the person is
 * editing, as its own save would, and never download the page.
 */

/**
 * Whether `event` is Ctrl or Command with `letter` and no other modifier. On a
 * layout without Latin letters, the key in the letter's place counts too; on
 * others that place can hold another letter, such as the Y of a German
 * keyboard, so only the letter counts.
 * @param {KeyboardEvent} event @param {string} letter a lowercase Latin letter
 */
export function commandKey(event, letter) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  const key = String(event.key).toLowerCase();
  return key === letter || !/^[a-z]$/.test(key) && event.code === `Key${letter.toUpperCase()}`;
}

/** Press `button` as a click would, unless it is disabled. @param {Element|null} button */
function press(button) {
  if (button instanceof HTMLButtonElement && !button.disabled) button.click();
}

/**
 * Answer Cmd/Ctrl+S in `doc`'s window, before anything else hears it. A field
 * that saves itself (`data-autosave`) saves now and keeps focus. Inside an
 * element marked `data-save-shortcut`, such as a dialog's form or a comment
 * being edited, the key does what its primary button does. With nothing being
 * edited, it presses the buttons marked `data-save-shortcut`, such as Save
 * beside a task field that is not saved. Anything else gets nothing: a new
 * comment, a reply and the Pool's quick add send only with Enter.
 * @param {Document} doc @param {{markSaved:(element:Element)=>void}} recovery
 */
export function installSaveShortcut(doc, recovery) {
  const win = doc.defaultView;
  win.addEventListener('keydown', (event) => {
    if (!commandKey(event, 's')) return;
    event.preventDefault();
    if (event.repeat || event.isComposing) return;
    const focused = doc.activeElement;
    if (!focused || focused.closest('[inert]')) return;
    if (focused.matches('[data-autosave]')) {
      // The field's blur action saves it; a blur event that moves no focus runs it.
      focused.dispatchEvent(new win.FocusEvent('blur'));
      recovery.markSaved(focused);
      return;
    }
    const form = focused.closest('[data-save-shortcut]:not(button)');
    if (form) { press(form.querySelector('.btn.primary')); return; }
    if (focused.matches('input,textarea,select,[contenteditable="true"]')) return;
    for (const button of doc.querySelectorAll('button[data-save-shortcut]')) if (!button.closest('[inert]')) press(button);
  }, true);
}
