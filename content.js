// Capture only an explicit selection. Explanation still requires a panel action.
let lastSelection = '';
function capture() {
  const target = document.activeElement;
  if (target?.matches('input, textarea, [contenteditable="true"]')) return;
  const text = window.getSelection()?.toString().trim() || '';
  if (!text || text.length > 200 || text === lastSelection) return;
  lastSelection = text;
  void chrome.runtime.sendMessage({ type: 'captureSelection', text }).catch(() => {});
}
document.addEventListener('mouseup', capture);
document.addEventListener('keyup', (event) => { if (event.key === 'Shift' || event.key.startsWith('Arrow')) capture(); });
