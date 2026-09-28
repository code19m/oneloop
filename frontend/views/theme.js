/* Apply the saved appearance before the stylesheet paints. */
(() => {
  const key = 'oneloop.theme';
  const valid = (value) => value === 'light' || value === 'dark';
  let current = 'light';
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) current = saved;
  } catch {}

  const apply = () => {
    document.documentElement.dataset.theme = current;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = current === 'light' ? '#ffffff' : '#181818';
    document.querySelectorAll('[data-theme-option]').forEach((button) => {
      const selected = button.dataset.themeOption === current;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  };
  window.Theme = {
    get current() { return current; },
    set(value) {
      if (!valid(value)) return;
      current = value;
      try { localStorage.setItem(key, current); } catch {}
      apply();
    },
  };
  window.addEventListener('storage', (event) => {
    if (event.key !== key) return;
    current = valid(event.newValue) ? event.newValue : 'light';
    apply();
  });
  apply();
})();
