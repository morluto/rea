import { wordmark } from './mascots.js';
import { applyTheme } from './appearance.js';
export function accountScreen(status, ctx) {
  const { $, app, esc, field, api, init } = ctx,
    invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  applyTheme();
  app.innerHTML = `<main class="onboarding"><section class="onboard-story"><a class="brand" href="/" aria-label="Orbit home">${wordmark()}</a><div class="onboard-emblem"><img class="onboard-logo" src="/orbit-mark-dark.png" alt=""></div><p class="story-note">Bots, memory and automations on your own computer.</p></section><section class="onboard-form"><div class="onboard-form-inner"><h1>${invite ? 'Join this workspace' : status.setup ? 'Create your workspace' : 'Welcome back'}</h1><p class="muted">${invite ? 'Use your invitation to create an account.' : status.setup ? 'Your Bots run on this computer.' : 'Sign in to continue.'}</p><form id="authform">${field('Account name', 'name', '', 'text', 'required autocomplete="username" autofocus')}${field('Password (at least 12 characters)', 'password', '', 'password', `required minlength="12" autocomplete="${status.setup || invite ? 'new-password' : 'current-password'}"`)}<div class="error" id="autherror" role="alert"></div><button class="primary auth-submit">${invite ? 'Join workspace' : status.setup ? 'Create workspace' : 'Sign in'}</button></form></div></section></main>`; // taste-skill-ignore: user-mandated Claude brand asset, see release report
  $('#authform').onsubmit = async (e) => {
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const credentials = Object.fromEntries(new FormData(e.target));
      if (invite) {
        await api('/auth/join', { ...credentials, token: invite });
        history.replaceState(null, '', location.pathname);
        await api('/auth/login', credentials);
      } else await api('/auth/' + (status.setup ? 'setup' : 'login'), credentials);
      await init();
    } catch (e) {
      $('#autherror').textContent = e.message;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  };
}
