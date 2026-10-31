import { registerPlugin, Capacitor } from './capacitor-core.js';
const host = document.querySelector('#host'),
  error = document.querySelector('#error'),
  form = document.querySelector('form');
const PrimaryHost = registerPlugin('PrimaryHost');
host.value = localStorage.getItem('workshop-primary-host') ?? '';
form.onsubmit = async (event) => {
  event.preventDefault();
  error.textContent = '';
  const button = event.submitter;
  button.disabled = true;
  try {
    const url = new URL(host.value.trim());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw Error('Enter only your primary host’s trusted HTTPS address.');
    if (!Capacitor.isNativePlatform())
      throw Error(
        'Open this client in the iOS app. You can also open the host address directly in your browser.',
      );
    await PrimaryHost.connect({ url: url.origin });
    localStorage.setItem('workshop-primary-host', url.origin);
  } catch (e) {
    error.textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
