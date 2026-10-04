(() => {
  const preferenceKey = 'demodb-theme';
  const allowed = (value) => value === 'light' || value === 'dark';
  const cookieValue = () => {
    try {
      const entry = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${preferenceKey}=`));
      const value = entry?.slice(preferenceKey.length + 1);
      return allowed(value) ? value : null;
    } catch {
      return null;
    }
  };
  const storedValue = () => {
    try {
      const value = localStorage.getItem(preferenceKey);
      return allowed(value) ? value : null;
    } catch {
      return null;
    }
  };
  const savedValue = () => cookieValue() ?? storedValue() ?? 'light';
  const updateButton = (theme) => {
    const button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-pressed', String(theme === 'dark'));
    button.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
    const label = button.querySelector('[data-theme-toggle-label]');
    if (label) label.textContent = nextTheme === 'dark' ? 'Dark' : 'Light';
    const icon = button.querySelector('.theme-toggle-icon');
    if (icon) icon.textContent = theme === 'dark' ? '☼' : '◐';
  };
  const apply = (theme, persist = false) => {
    const selected = allowed(theme) ? theme : 'light';
    document.documentElement.dataset.theme = selected;
    document.documentElement.style.colorScheme = selected;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', selected === 'dark' ? '#08111f' : '#f7f9fc');
    if (persist) {
      try { localStorage.setItem(preferenceKey, selected); } catch { /* Preference still applies for this page. */ }
      try {
        const sharedDomain = location.hostname === 'demodb.dev' || location.hostname.endsWith('.demodb.dev') ? '; Domain=demodb.dev' : '';
        document.cookie = `${preferenceKey}=${selected}; Path=/; Max-Age=31536000; SameSite=Lax; Secure${sharedDomain}`;
      } catch { /* Preference still applies for this page. */ }
    }
    updateButton(selected);
  };

  apply(savedValue());
  document.addEventListener('DOMContentLoaded', () => updateButton(document.documentElement.dataset.theme));
  document.addEventListener('click', (event) => {
    const button = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-theme-toggle]')
      : null;
    if (button) apply(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
  });
})();
