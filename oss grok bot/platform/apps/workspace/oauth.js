export function oauthUI(ctx) {
  const { api, modal, field, esc, action, close } = ctx;
  function create(botChecks) {
    modal(
      'Connect mail or calendar',
      `${field('Connection name', 'name', '', 'text', 'required')}<label>Provider</label><select name="provider"><option value="google">Google</option><option value="microsoft">Microsoft</option></select><label>Service</label><select name="service"><option value="mail">Mail</option><option value="calendar">Calendar</option></select>${field('Your registered OAuth client ID', 'clientId', '', 'text', 'required autocomplete="off"')}${field('Client secret (private, if required)', 'clientSecret', '', 'password', 'autocomplete="off"')}<p class="tiny muted">Register your own OAuth app with the selected provider. Exact redirect URI: <code>${esc(location.origin)}/api/oauth/callback</code>. Tokens are encrypted locally and never included in model prompts. Only the selected account’s granted operations are available.</p><label>Granted Bots</label>${botChecks()}`,
      async (f) => {
        await api('/oauth/connections', {
          name: f.get('name'),
          provider: f.get('provider'),
          service: f.get('service'),
          clientId: f.get('clientId'),
          clientSecret: f.get('clientSecret') || undefined,
          botIds: f.getAll('botIds'),
        });
      },
      'Save account configuration',
    );
  }
  function bind(items, reopen) {
    document.querySelectorAll('[data-oauth]').forEach(
      (b) =>
        (b.onclick = action(async () => {
          const result = await api(`/oauth/connections/${b.dataset.oauth}/authorize`, {});
          close();
          modal(
            'Authorize the selected account',
            `<p>Continue with the provider to select an account and review its scopes. Return here after authorization.</p><p><a target="_blank" rel="noopener noreferrer" href="${esc(result.authorizeUrl)}">Open provider authorization</a></p><p class="tiny muted">Scopes: ${esc(result.scope.join(', '))}</p>`,
          );
        })),
    );
    document.querySelectorAll('[data-disconnect-oauth]').forEach(
      (b) =>
        (b.onclick = action(async () => {
          await api(`/oauth/connections/${b.dataset.disconnectOauth}/disconnect`, {});
          close();
          await reopen();
        })),
    );
  }
  return { create, bind };
}
