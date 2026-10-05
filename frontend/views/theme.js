/* Apply the saved appearance before the stylesheet paints. Until someone
   picks Light or Dark, follow the device's setting, also when it changes. */
(() => {
  const key = 'oneloop.theme';
  const valid = (value) => value === 'light' || value === 'dark';
  let choice = 'system';
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) choice = saved;
  } catch {}
  let device = null;
  try { device = window.matchMedia('(prefers-color-scheme: dark)'); } catch {}
  const resolved = () => choice !== 'system' ? choice : device?.matches ? 'dark' : 'light';

  const apply = () => {
    const current = resolved();
    document.documentElement.dataset.theme = current;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = current === 'light' ? '#ffffff' : '#181818';
    document.querySelectorAll('[data-theme-option]').forEach((button) => {
      const selected = button.dataset.themeOption === choice;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  };
  window.Theme = {
    /** The theme on screen: light or dark. */
    get current() { return resolved(); },
    /** What the person picked: light, dark or system. */
    get choice() { return choice; },
    set(value) {
      if (!valid(value) && value !== 'system') return;
      choice = value;
      try {
        if (value === 'system') localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {}
      apply();
    },
  };
  try { device?.addEventListener('change', () => { if (choice === 'system') apply(); }); } catch {}
  // Another tab picked a theme; a removed choice, or cleared storage, means System.
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    choice = valid(event.newValue) ? event.newValue : 'system';
    apply();
  });
  apply();
})();
