// The stored preference and the effective system theme are separate facts.
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let preference = 'system';
let renderedTheme;
function renderTheme() {
  const effective = preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference;
  if (renderedTheme === effective) return;
  renderedTheme = effective;
  document.documentElement.dataset.theme = effective;
  if (window.workshopDesktop?.setAppearance)
    void window.workshopDesktop.setAppearance(effective).catch(() => {});
}
systemTheme.addEventListener('change', () => {
  if (preference === 'system') renderTheme();
});
export function applyTheme(settings = {}) {
  preference = settings.theme ?? 'system';
  document.documentElement.dataset.accent = settings.accent === 'black' ? 'black' : 'bot';
  const language =
    settings.language && settings.language !== 'system' ? settings.language : navigator.language;
  if (language) document.documentElement.lang = language;
  renderTheme();
}
export function themeControl(theme = 'system') {
  return `<div class="settings-row"><label for="f-theme">Theme</label><select id="f-theme" name="theme">${[
    ['system', 'Follow System'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${theme === value ? 'selected' : ''}>${label}</option>`,
    )
    .join('')}</select></div>`;
}
