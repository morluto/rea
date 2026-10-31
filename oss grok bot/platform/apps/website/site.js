import { mascot } from '/shared/mascots.js';
const orb = document.querySelector('#orb');
function state(value) {
  orb.innerHTML = mascot(
    {
      id: 'workshop-preview',
      name: 'Mascot preview',
      color: '#a9bca6',
      activity: {
        state: value,
        label:
          value === 'working'
            ? 'Working'
            : value === 'waiting'
              ? 'Waiting for you'
              : 'Ready when you are',
      },
    },
    'hero',
  );
  for (const button of document.querySelectorAll('[data-state]'))
    button.setAttribute('aria-pressed', String(button.dataset.state === value));
}
state('idle');
document
  .querySelectorAll('[data-state]')
  .forEach((button) => (button.onclick = () => state(button.dataset.state)));
try {
  const r = await fetch('/api/downloads');
  const v = await r.json(),
    download = document.querySelector('#download'),
    info = document.querySelector('#downloadinfo');
  if (v.windows) {
    download.href = v.windows.url;
    download.removeAttribute('aria-disabled');
    download.textContent = 'Download for Windows ↗';
    info.textContent = `Version ${v.version} · per-user installer · no administrator install required`;
  } else {
    download.textContent = 'Windows installer is being prepared';
    info.textContent =
      'Run the desktop build command from the repository. This page offers only files that actually exist.';
  }
} catch {
  document.querySelector('#downloadinfo').textContent = 'Build availability could not be checked.';
}
