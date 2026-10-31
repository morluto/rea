export function pluginSignInUI(ctx) {
  const { $, api, esc, modal, field, action, close, toast } = ctx;
  const ownedBotIds = () =>
    ctx
      .state()
      .bots.filter((bot) => bot.id === ctx.botId() && bot.accessRole === 'owner' && !bot.retired)
      .map((bot) => bot.id);
  const providerName = (provider) => (provider === 'google' ? 'Google' : 'Microsoft');
  async function registration(plugin) {
    const application = await api('/oauth/applications/' + plugin.provider);
    close();
    modal(
      'Set up ' + providerName(plugin.provider) + ' sign-in once',
      "<p>Orbit needs its own registered OAuth app. Save it once here, then use Connect on this provider's plugins. This is not your account password.</p>" +
        (plugin.provider === 'google'
          ? '<p class="tiny muted">In Google Cloud, enable the Gmail / Calendar APIs, configure consent and create a Desktop app OAuth client. Add your account as a test user if required. Import the downloaded client JSON or enter its values below.</p><a href="https://developers.google.com/workspace/gmail/api/quickstart/nodejs" target="_blank" rel="noopener">Official Google setup guide</a><label for="oauthclientfile">Import OAuth client JSON (private)</label><input id="oauthclientfile" type="file" accept="application/json,.json">'
          : '') +
        field('OAuth app client ID', 'clientId', application.clientId, 'text', 'required') +
        field(
          'Client secret (private; leave blank to keep saved)',
          'clientSecret',
          '',
          'password',
          'autocomplete="off"',
        ) +
        '<p class="tiny muted">Local callback: ' +
        esc(application.redirectUri) +
        '. Never paste account passwords here. Saving reconnects this plugin with the app registration and requires fresh account consent. Other plugins are unchanged.</p>',
      async (form) => {
        await api('/oauth/applications/' + plugin.provider, {
          clientId: form.get('clientId'),
          ...(form.get('clientSecret') ? { clientSecret: form.get('clientSecret') } : {}),
          revision: application.revision,
        });
        return async () => {
          try {
            if (plugin.installed?.state === 'installed')
              await api('/plugins/' + plugin.id, {
                botIds: plugin.installed.botIds,
                revision: plugin.installed.revision,
              });
            await connect(plugin);
          } catch (error) {
            toast(error.message);
          }
        };
      },
      'Save & sign in with ' + providerName(plugin.provider),
    );
    $('#oauthclientfile')?.addEventListener(
      'change',
      action(async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        if (file.size > 65536)
          throw Error('Choose the small OAuth client JSON, not a data export.');
        const parsed = JSON.parse(await file.text()),
          client = parsed?.installed;
        if (
          !client ||
          typeof client.client_id !== 'string' ||
          (client.client_secret !== undefined && typeof client.client_secret !== 'string')
        )
          throw Error(
            'Choose a Google Desktop app OAuth client file, not a Web app or service-account file.',
          );
        $('#f-clientId').value = client.client_id;
        $('#f-clientSecret').value = client.client_secret ?? '';
        event.target.value = '';
      }),
    );
  }
  const flowPath = (authorization) =>
    (authorization.type === 'mcp' ? '/mcp/oauth/flows/' : '/oauth/flows/') + authorization.id;
  const label = (plugin) => (plugin.provider ? providerName(plugin.provider) : plugin.name);
  function showConnected(plugin) {
    const connection = plugin.installed?.connection;
    modal(
      'Connected: ' + plugin.name,
      '<p role="status">' +
        esc(
          connection
            ? (connection.oauth
                ? 'Connected as ' + connection.accountLabel + '. '
                : 'Connected to ' + plugin.name + '. ') +
                connection.discoveredTools.length +
                ' tools available with approval.'
            : 'Skill enabled for the selected Bot.',
        ) +
        '</p>' +
        '<p class="tiny muted">' +
        esc(
          connection
            ? 'Bot tool permissions and approval policies remain in effect. Provider-managed MCP accounts do not imply independently verified email identity.'
            : 'No external account was needed.',
        ) +
        '</p>' +
        (connection
          ? '<button type="button" id="pluginoauthaccess">Review Bots & tool access</button>'
          : ''),
    );
    if (connection)
      $('#pluginoauthaccess').onclick = () => ctx.features().manageConnection(connection);
    $('#cancelmodal').textContent = 'Done';
  }
  async function launch(plugin, start, opensBrowser = true) {
    const popup =
      !opensBrowser || window.workshopDesktop ? null : window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    close();
    modal(
      'Connect ' + plugin.name,
      '<div id="pluginlaunch"><p role="status">' +
        (opensBrowser ? 'Preparing secure sign-in...' : 'Connecting and checking tools...') +
        '</p><p class="tiny muted">Only the selected plugin and Bot are being connected. No account access is granted until authorization succeeds.</p></div>',
    );
    const target = $('#pluginlaunch');
    try {
      const value = await start(),
        authorization = value.authorization;
      if (!target.isConnected || !$('#dialog').open) {
        popup?.close();
        if (authorization) await api(flowPath(authorization) + '/cancel', {});
        return;
      }
      close();
      if (!authorization) {
        popup?.close();
        showConnected(value.plugin);
        return;
      }
      watch(value.plugin, authorization);
      if (popup) popup.location.replace(authorization.authorizeUrl);
      else if (window.workshopDesktop)
        window.open(authorization.authorizeUrl, '_blank', 'noopener');
    } catch (error) {
      popup?.close();
      if (target.isConnected) {
        target.innerHTML =
          '<p role="alert">' +
          esc(error.message) +
          '</p><p class="tiny muted">This provider may need an API key, approved OAuth client or a different MCP server. No successful connection is claimed.</p><button type="button" id="pluginlaunchoptions">Connection options</button>';
        $('#pluginlaunchoptions').onclick = () => ctx.configure(plugin);
      } else toast(error.message);
    }
  }
  async function connect(plugin) {
    const connection = plugin.installed?.connection;
    const opensBrowser =
      plugin.setup === 'oauth' ||
      (plugin.setup === 'mcp' && (!connection || !!connection.mcpOAuth));
    return launch(
      plugin,
      () => api('/plugins/' + plugin.id + '/connect', { botIds: ownedBotIds() }),
      opensBrowser,
    );
  }
  async function reconnect(plugin) {
    return launch(plugin, async () => {
      const connection = plugin.installed.connection;
      const flow = await api(
        (connection.oauth ? '/oauth/connections/' : '/connections/') + connection.id + '/authorize',
        {},
      );
      return {
        plugin,
        authorization: {
          ...flow,
          authorizeUrl: flow.authorizeUrl ?? flow.authorizationUrl,
          type: connection.oauth ? 'oauth' : 'mcp',
        },
      };
    });
  }
  function watch(plugin, authorization) {
    modal(
      'Connect ' + plugin.name,
      '<div id="pluginoauthwatch"><p id="pluginoauthstatus" role="status">Finish sign-in in your browser. Orbit will detect the result automatically.</p><a class="button" href="' +
        esc(authorization.authorizeUrl) +
        '" target="_blank" rel="noopener">Open ' +
        esc(label(plugin)) +
        ' sign-in</a><p class="tiny muted">Only this plugin and the selected Bots are connected. Those Bots can call its tools, and each new tool asks for approval.</p></div>',
    );
    const target = $('#pluginoauthwatch'),
      dialog = $('#dialog'),
      path = flowPath(authorization);
    let timer,
      ended = false;
    const finish = () => {
      ended = true;
      clearTimeout(timer);
      dialog.removeEventListener('cancel', cancel);
    };
    const cancel = (event) => {
      event?.preventDefault();
      finish();
      void api(path + '/cancel', {}).catch(() => {});
      close();
    };
    dialog.addEventListener('cancel', cancel);
    $('#closemodal').onclick = cancel;
    $('#cancelmodal').onclick = cancel;
    async function poll() {
      if (ended) return;
      if (!target.isConnected || !dialog.open) {
        finish();
        void api(path + '/cancel', {}).catch(() => {});
        return;
      }
      try {
        const flow = await api(path);
        if (ended || !target.isConnected || !dialog.open) return;
        if (['connected', 'completed'].includes(flow.state)) {
          if (authorization.type === 'mcp') {
            $('#pluginoauthstatus').textContent = 'Signed in. Checking available tools...';
            await api('/connections/' + flow.connectionId + '/discover', {});
          }
          const current = (await api('/plugins')).find((value) => value.id === plugin.id);
          if (ended || !target.isConnected || !dialog.open) {
            finish();
            return;
          }
          if (!current?.installed?.connection?.enabled)
            throw Error('This connection was disabled.');
          finish();
          close();
          showConnected(current);
          return;
        }
        if (['failed', 'cancelled', 'expired', 'superseded'].includes(flow.state)) {
          finish();
          $('#pluginoauthstatus').textContent =
            flow.state === 'failed'
              ? 'Sign-in was declined or failed. Reconnect to try again; no connection success is claimed.'
              : 'Sign-in ' + flow.state + '. Reconnect when ready.';
          return;
        }
        timer = setTimeout(poll, 1000);
      } catch (error) {
        if (target.isConnected)
          $('#pluginoauthstatus').textContent =
            error.message + ' Close and reconnect or open connection options to try again.';
        finish();
      }
    }
    void poll();
  }
  return { connect, reconnect, registration, providerName, ownedBotIds };
}
