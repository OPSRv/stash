// Блокує браузерне контекстне меню в усьому застосунку, лишаючи його
// в полях вводу — там воно потрібне для copy/paste/spellcheck.
const EDITABLE_SELECTOR =
  'input, textarea, [contenteditable="true"], [contenteditable=""]';

export function installContextMenuGuard(target: Window): () => void {
  const handler = (e: MouseEvent) => {
    const node = e.target as HTMLElement | null;
    if (node?.closest?.(EDITABLE_SELECTOR)) return;
    e.preventDefault();
  };
  target.addEventListener('contextmenu', handler);
  return () => target.removeEventListener('contextmenu', handler);
}
