// The desktop exposes a write-only bridge owned by its trusted main frame.
// Browser clients keep the browser's normal clipboard consent and focus rules.
export async function copyText(text) {
  if (window.workshopDesktop?.copyText) return window.workshopDesktop.copyText(text);
  return navigator.clipboard.writeText(text);
}
