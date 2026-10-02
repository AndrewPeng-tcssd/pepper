(() => {
  'use strict';

  const storageKey = 'pepper_theme';
  const isTheme = value => value === 'light' || value === 'dark';
  let currentTheme = 'light';

  function syncControls() {
    document.querySelectorAll('input[name="theme"]').forEach(input => {
      input.checked = input.value === currentTheme;
    });
  }

  function applyTheme(value) {
    currentTheme = isTheme(value) ? value : 'light';
    document.documentElement.dataset.theme = currentTheme;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) {
      themeColor.content = currentTheme === 'dark' ? '#151a16' : '#f6f4ef';
    }
    syncControls();
  }

  function showSaveMessage(message) {
    const messageElement = document.getElementById('themeMessage');
    if (messageElement) messageElement.textContent = message;
  }

  let savedTheme;
  try {
    savedTheme = localStorage.getItem(storageKey);
  } catch {
    // Appearance remains usable when browser storage is unavailable.
  }
  applyTheme(savedTheme);

  document.addEventListener('DOMContentLoaded', () => {
    syncControls();
    document.querySelectorAll('input[name="theme"]').forEach(input => {
      input.addEventListener('change', () => {
        if (!input.checked || !isTheme(input.value)) return;
        applyTheme(input.value);
        try {
          localStorage.setItem(storageKey, currentTheme);
          showSaveMessage('');
        } catch {
          showSaveMessage('Appearance changed for this visit. Your browser could not save it.');
        }
      });
    });
  });

  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== null) return;
    applyTheme(event.newValue);
    showSaveMessage('');
  });
})();
