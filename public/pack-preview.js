(() => {
  'use strict';

  const gallery = document.getElementById('halloweenCards');
  const dialog = document.getElementById('packCardDialog');
  const title = document.getElementById('packCardTitle');
  const image = document.getElementById('packCardImage');
  if (!gallery || !dialog || typeof dialog.showModal !== 'function') return;

  // Artwork previews only; no account, token, or inventory requests.
  gallery.addEventListener('click', event => {
    const card = event.target.closest('.pack-preview-card');
    if (!card || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    title.textContent = card.querySelector('h3').textContent;
    image.src = card.href;
    image.alt = card.querySelector('img').alt;
    dialog.showModal();
  });

  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => image.removeAttribute('src'));
  window.addEventListener('popstate', () => { if (dialog.open) dialog.close(); });
})();
