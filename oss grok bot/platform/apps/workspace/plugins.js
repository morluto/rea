import { pluginSignInUI } from './plugin-signin.js';
import { icon } from './icons.js';
export function pluginsUI(ctx) {
  const { $, api, esc, modal, field, area, action, close, toast, refresh } = ctx;
  const signIn = pluginSignInUI({ ...ctx, configure });
  let query = '',
    category = '',
    installedOnly = false,
    listScroll = 0;
  const installed = (p) => p.installed?.state === 'installed';
  const badge = (p) =>
    `<span class="plugin-badge" aria-hidden="true" ${p.icon ? `style="background:${esc(p.iconBackground)}"` : ''}>${p.icon ? `<img src="/plugin-icons/${esc(p.icon)}" alt="" width="28" height="28">` : icon(p.setup === 'skill' ? 'library' : 'connection', 24)}</span>`;
  const description = (p) =>
    p.setup === 'skill'
      ? 'Instructions for selected Bots.'
      : p.setup === 'oauth'
        ? p.service === 'calendar'
          ? 'Read and manage calendars.'
          : 'Search and manage email.'
        : `Connect ${p.name} to your Bots.`;
  function status(p) {
    if (!installed(p)) return '';
    if (p.connectionReady) return p.setup === 'skill' ? 'Enabled' : 'Connected';
    const c = p.installed.connection;
    if (c?.state === 'failed') return 'Error';
    if (c?.enabled === false) return 'Disconnected';
    return c?.state === 'auth_required' || c?.oauth?.state === 'auth_required'
      ? 'Sign-in required'
      : 'Not ready';
  }
  function show(title, html, back) {
    modal(
      title,
      `${back ? `<button type="button" class="plugin-back" id="pluginback" aria-label="Back">${icon('chevron', 16)}<span>${esc(back.label)}</span></button>` : ''}<div class="plugin-body">${html}</div>`,
      undefined,
      undefined,
      { className: 'plugin-dialog' },
    );
    if (back)
      $('#pluginback').onclick = action(async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await back.run();
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
  }
  function row(p, index) {
    const label = status(p);
    return `<div class="plugin-row" data-plugin="${p.id}" data-category="${esc(p.category)}" data-order="${index}" data-installed="${installed(p)}"><button type="button" class="plugin-open" data-open-plugin="${p.id}" aria-label="Open ${esc(p.name)}">${badge(p)}<span class="plugin-row-copy"><strong>${esc(p.name)}</strong><small>${esc(description(p))}</small></span></button>${label ? `<span class="plugin-row-status ${p.connectionReady ? 'ready' : ''} ${label === 'Error' ? 'error' : ''}">${esc(label)}</span>` : `<button type="button" class="plugin-connect" data-connect-plugin="${p.id}" aria-label="${p.setup === 'skill' ? 'Enable' : 'Connect'} ${esc(p.name)}">${p.setup === 'skill' ? 'Enable' : 'Connect'}</button>`}</div>`;
  }
  function group(name, items, featured = false) {
    return `<section class="plugin-group" data-group="${esc(name)}" ${featured ? 'data-featured' : ''}><div class="plugin-catalog-heading"><h3>${esc(name)}</h3>${!featured && items.length > 6 ? `<button type="button" data-view-category="${esc(name)}">View all</button>` : ''}</div><div class="plugin-list">${items.map(row).join('')}</div></section>`;
  }
  async function open(reset = true) {
    if (reset) {
      query = '';
      category = '';
      installedOnly = false;
      listScroll = 0;
    }
    const items = await api('/plugins'),
      connections = await api('/connections'),
      linked = new Set(items.map((p) => p.installed?.connectionId).filter(Boolean)),
      servers = connections.filter(
        (c) => c.kind === 'mcp' && !linked.has(c.id) && c.state !== 'disconnected',
      ),
      primary = ['Password Managers', 'Productivity', 'Communication', 'Design', 'Code'],
      extra = [...new Set(items.map((p) => p.category))].filter((c) => !primary.includes(c)).sort(),
      recommended = ['datadog', 'vercel', 'supabase', 'cloudflare', 'sentry', 'firebase']
        .map((id) => items.find((p) => p.id === id))
        .filter(Boolean),
      custom = ctx
        .state()
        .extensions.filter(
          (e) =>
            e.type === 'skill' &&
            e.state === 'enabled' &&
            !items.some((p) => p.installed?.extensionId === e.id),
        );
    show(
      installedOnly ? 'Manage plugins and skills' : 'Connect Apps',
      `
      ${installedOnly ? '<h3 class="plugin-manager-title">Manage plugins and skills</h3><h4 class="plugin-section-title">Installed</h4>' : `<div class="plugin-catalog-heading plugin-catalog-title"><h3>Connect Apps</h3><button type="button" id="pluginmanage">${items.filter(installed).length} installed ${icon('chevron', 14)}</button></div><div class="plugin-search-row"><button type="button" id="addmcpserver">${icon('plus', 14)} Add MCP server</button><div class="plugin-search">${icon('search', 14)}<input id="pluginsearch" aria-label="Search plugins" placeholder="Search across apps and skills" value="${esc(query)}"></div><button type="button" id="plugintemplates">${icon('library', 16)} Bot templates ${icon('arrow', 14)}</button></div><div class="plugin-categories" role="group" aria-label="Plugin categories"><button type="button" data-category="" aria-pressed="${!category}">All</button>${primary.map((c) => `<button type="button" data-category="${esc(c)}" aria-pressed="${category === c}">${esc(c)}</button>`).join('')}<details class="plugin-more"><summary>${esc(extra.includes(category) ? category : 'More')}</summary><div>${extra.map((c) => `<button type="button" data-category="${esc(c)}" aria-pressed="${category === c}">${esc(c)}</button>`).join('')}</div></details></div>`}
      ${
        installedOnly
          ? `<div class="plugin-list">${items.filter(installed).map(row).join('')}</div>`
          : group('Recommended for you', recommended, true) +
            [...primary, ...extra]
              .map((c) =>
                group(
                  c,
                  items.filter((p) => p.category === c),
                ),
              )
              .join('')
      }<p id="pluginempty" class="muted" role="status" hidden>${installedOnly ? 'No installed plugins yet.' : 'No plugins found.'}</p>
      ${installedOnly ? `<section class="plugin-private"><div class="plugin-catalog-heading"><h3>MCP servers</h3><button type="button" id="addmcpserver">${icon('plus', 14)} Add MCP server</button></div>${servers.map((c) => `<button type="button" class="plugin-private-row" data-mcp-server="${c.id}">${icon('connection', 24)}<span><strong>${esc(c.name)}</strong><small>${esc(c.state)} · ${c.discoveredTools.length} tools · ${esc(c.endpoint)}</small></span></button>`).join('') || '<p class="muted">No MCP servers yet. Add one and its tools become available to the Bots you select.</p>'}</section><section class="plugin-private"><div class="plugin-catalog-heading"><h3>Private skills</h3><button type="button" id="customskill">${icon('plus', 14)} Add skill</button></div>${custom.map((e) => `<button type="button" class="plugin-private-row" data-custom-skill="${e.id}">${icon('library', 24)}<span><strong>${esc(e.name)}</strong><small>${esc(e.source)} · ${esc(e.version)}</small></span></button>`).join('') || '<p class="muted">No private skills yet.</p>'}</section>` : ''}`,
      installedOnly
        ? {
            label: 'Connect Apps',
            run: async () => {
              installedOnly = false;
              listScroll = 0;
              await open(false);
            },
          }
        : null,
    );
    const body = $('.plugin-body');
    $('#dialog').classList.add(installedOnly ? 'plugin-manager' : 'plugin-catalog');
    body.onscroll = () => $('#dialog').classList.toggle('is-scrolled', body.scrollTop > 30);
    const filter = () => {
      let count = 0;
      document.querySelectorAll('[data-plugin]').forEach((row) => {
        const p = items.find((p) => p.id === row.dataset.plugin);
        row.hidden =
          (installedOnly && !installed(p)) ||
          (!installedOnly &&
            ((row.closest('[data-featured]') && (category || query.trim())) ||
              (category && p.category !== category) ||
              (!category && !query.trim() && Number(row.dataset.order) >= 6) ||
              !`${p.name} ${description(p)}`.toLowerCase().includes(query.toLowerCase())));
        if (!row.hidden) count++;
      });
      document.querySelectorAll('.plugin-group').forEach((section) => {
        section.hidden = !section.querySelector('.plugin-row:not([hidden])');
        const view = section.querySelector('[data-view-category]');
        if (view) view.hidden = !!category || !!query.trim();
      });
      $('#pluginempty').hidden = count > 0;
    };
    filter();
    body.scrollTop = listScroll;
    body.onscroll();
    $('#pluginsearch')?.addEventListener('input', (e) => {
      query = e.target.value;
      filter();
    });
    const selectCategory = (value) => {
      category = value;
      document
        .querySelectorAll('button[data-category]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.category === category)));
      const more = $('.plugin-more');
      more.open = false;
      more.querySelector('summary').textContent = extra.includes(category) ? category : 'More';
      filter();
      body.scrollTop = 0;
    };
    document
      .querySelectorAll('button[data-category]')
      .forEach((button) => (button.onclick = () => selectCategory(button.dataset.category)));
    document
      .querySelectorAll('[data-view-category]')
      .forEach((button) => (button.onclick = () => selectCategory(button.dataset.viewCategory)));
    $('#plugintemplates')?.addEventListener('click', () => $('#marketplacefeature').click());
    $('#pluginmanage')?.addEventListener(
      'click',
      action(async () => {
        installedOnly = true;
        listScroll = 0;
        await open(false);
      }),
    );
    document.querySelectorAll('[data-open-plugin]').forEach(
      (button) =>
        (button.onclick = () => {
          listScroll = body.scrollTop;
          detail(items.find((p) => p.id === button.dataset.openPlugin));
        }),
    );
    document.querySelectorAll('[data-connect-plugin]').forEach(
      (button) =>
        (button.onclick = action(async () => {
          button.disabled = true;
          try {
            await connect(items.find((p) => p.id === button.dataset.connectPlugin));
          } finally {
            if (button.isConnected) button.disabled = false;
          }
        })),
    );
    $('#addmcpserver')?.addEventListener('click', addMcp);
    document.querySelectorAll('[data-mcp-server]').forEach((button) => {
      button.onclick = () => {
        const server = servers.find((c) => c.id === button.dataset.mcpServer);
        show(
          server.name,
          `<p class="muted">${esc(server.endpoint)}</p><p role="status">${esc(server.state)} · ${server.discoveredTools.length} tools. Selected Bots can call them, and each new tool asks for approval.</p><ul>${server.discoveredTools.map((tool) => `<li><strong>${esc(tool.name)}</strong> ${esc(tool.description ?? '')}</li>`).join('') || '<li>No tools discovered yet.</li>'}</ul><button type="button" id="mcptest">Test tools</button>`,
          {
            label: 'Manage plugins and skills',
            run: async () => {
              installedOnly = true;
              await open(false);
            },
          },
        );
        $('#mcptest').onclick = action(async () => {
          $('#mcptest').disabled = true;
          try {
            const ready = await api(`/connections/${server.id}/discover`, {});
            toast(`${ready.discoveredTools.length} tools are available.`);
            await refresh();
            installedOnly = true;
            await open(false);
          } finally {
            if ($('#mcptest')) $('#mcptest').disabled = false;
          }
        });
      };
    });
    $('#customskill')?.addEventListener('click', customSkill);
    document.querySelectorAll('[data-custom-skill]').forEach(
      (button) =>
        (button.onclick = () => {
          const skill = custom.find((e) => e.id === button.dataset.customSkill);
          listScroll = body.scrollTop;
          show(
            skill.name,
            `<h3>Instructions</h3><p class="pre">${esc(skill.instructions)}</p><h3>Allowed Bots</h3><p>${esc(
              ctx
                .state()
                .bots.filter((b) => skill.botIds.includes(b.id))
                .map((b) => b.name)
                .join(', ') || 'None',
            )}</p>`,
            { label: 'Manage', run: () => open(false) },
          );
        }),
    );
  }
  async function connect(p) {
    if (p.setup === 'oauth' && !p.signInReady) return signIn.registration(p);
    if (
      (p.setup === 'mcp' && !p.endpoint && !installed(p)) ||
      (p.setup === 'skill' && !signIn.ownedBotIds().length)
    )
      return configure(p);
    return signIn.connect(p);
  }
  function botChecks(selected = []) {
    return `<label>Allow these Bots</label><div class="checks">${
      ctx
        .state()
        .bots.filter((b) => !b.retired && b.accessRole === 'owner')
        .map(
          (b) =>
            `<label><input type="checkbox" name="botIds" value="${b.id}" ${selected.includes(b.id) ? 'checked' : ''}>${esc(b.name)}</label>`,
        )
        .join('') || '<p class="muted">Create a Bot first.</p>'
    }</div>`;
  }
  function detail(p) {
    const current = installed(p) ? p.installed : null,
      c = current?.connection,
      tools = c?.discoveredTools ?? [];
    show(
      p.name,
      `<div class="plugin-detail-heading">${badge(p)}<h3>${esc(p.name)}</h3><div>${current ? '<button type="button" id="pluginremove">Uninstall</button>' : `<button type="button" id="pluginconnect">${p.setup === 'skill' ? 'Enable' : 'Connect'}</button>`}</div></div><p class="plugin-description">${esc(description(p))}</p>
      ${c ? `<section class="plugin-detail-section"><h4>Accounts</h4><div class="plugin-detail-card"><div class="plugin-account"><span>${esc(c.oauth?.accountEmail ?? c.accountLabel ?? p.name)}</span><span class="${p.connectionReady ? 'ready' : ''}" role="status">${esc(status(p))}</span></div><div class="row wrap">${c.oauth || c.mcpOAuth ? '<button type="button" id="pluginauth">Sign in / reconnect</button>' : ''}<button type="button" id="plugintest">Test tools</button></div></div></section><section class="plugin-detail-section"><h4>Tools</h4><details class="plugin-tool-list"><summary>${tools.length} discovered tools</summary>${tools.map((tool) => `<div><strong>${esc(tool.name)}</strong><span>${esc(tool.policy ?? 'ask')}</span>${tool.description ? `<small>${esc(tool.description)}</small>` : ''}</div>`).join('') || '<p class="muted">No tools discovered yet. Test the connection to check available tools.</p>'}</details><button type="button" id="plugingrants" class="quiet small">Tools & access</button></section>` : ''}
      ${p.setup === 'skill' ? `<section class="plugin-detail-section"><h4>Skill</h4><div class="plugin-detail-card"><p class="pre">${esc(p.instructions)}</p><p class="muted">${esc(p.sandbox)}</p></div></section>` : ''}
      <section class="plugin-detail-section"><h4>Information</h4><dl class="plugin-information"><div><dt>Category</dt><dd>${esc(p.category)}</dd></div><div><dt>Version</dt><dd>${esc(p.version)}</dd></div><div><dt>Availability</dt><dd>${esc(current ? status(p) : 'Not installed')}</dd></div>${p.docs ? `<div><dt>Documentation</dt><dd><a href="${esc(p.docs)}" target="_blank" rel="noopener">Official setup guide</a></dd></div>` : ''}</dl></section><details class="plugin-options"><summary>Connection options</summary><p class="muted">${esc(p.requirements)}</p><button type="button" id="pluginconfigure">${current ? 'Configure / update' : 'Configure'}</button></details>`,
      { label: installedOnly ? 'Manage' : 'Connect Apps', run: () => open(false) },
    );
    $('#pluginconnect')?.addEventListener(
      'click',
      action(async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        try {
          await connect(p);
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      }),
    );
    $('#pluginconfigure').onclick = action(async () => {
      close();
      if (c?.oauth) await signIn.registration(p);
      else configure(p);
    });
    $('#pluginremove')?.addEventListener('click', () => {
      close();
      modal(
        'Remove ' + p.name,
        '<p>Disconnect this plugin and remove its local credentials and Bot grants. Previously submitted actions may still finish. Existing files, conversations and action receipts are retained.</p>',
        async () => api(`/plugins/${p.id}/uninstall`, { revision: p.installed.revision }),
        'Remove plugin',
      );
    });
    if (c) {
      $('#plugintest').onclick = action(async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        try {
          await api(`/connections/${c.id}/discover`, {});
          close();
          await open();
          toast('Tools checked. Review access before using them.');
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
      $('#plugingrants').onclick = () => ctx.features().manageConnection(c);
      $('#pluginauth')?.addEventListener(
        'click',
        action(async () => {
          return signIn.reconnect(p);
        }),
      );
    }
  }
  function configure(p) {
    if (p.setup === 'oauth')
      return void signIn.registration(p).catch((error) => toast(error.message));
    const prior = p.installed,
      c = prior?.connection;
    modal(
      'Set up ' + p.name,
      `${c ? '<p class="tiny muted">Saving replaces the connection and its local credentials. Re-enter any required private values, then reconnect and review tool access.</p>' : ''}<p class="muted">${esc(p.requirements)}</p>${p.setup === 'mcp' ? `${field('MCP server URL', 'endpoint', c?.endpoint ?? p.endpoint ?? '', 'url', 'required')}<label for="pluginauthmode">Authentication</label><select id="pluginauthmode" name="auth"><option value="oauth">Sign in with OAuth</option><option value="token" ${c && !c.mcpOAuth && c.hasCredential ? 'selected' : ''}>API key / bearer token</option><option value="none" ${c && !c.mcpOAuth && !c.hasCredential ? 'selected' : ''}>No authentication</option></select><div id="plugintoken">${field(c ? 'Re-enter API key / token (private)' : 'API key / token (private)', 'token', '', 'password', 'autocomplete="off"')}</div><details><summary>Registered OAuth client (if required)</summary>${field('Client ID', 'clientId')}${field('Client secret (private)', 'clientSecret', '', 'password', 'autocomplete="off"')}</details>` : ''}${botChecks(prior?.botIds ?? signIn.ownedBotIds())}${p.setup === 'skill' ? '' : '<p class="tiny muted">Selected Bots can call this plugin. Newly discovered tools ask for approval.</p>'}`,
      async (f) => {
        const value = Object.fromEntries(f);
        value.botIds = f.getAll('botIds');
        if (prior) value.revision = prior.revision;
        for (const key of ['token', 'clientId', 'clientSecret']) if (!value[key]) delete value[key];
        const configured = await api(`/plugins/${p.id}`, value);
        await refresh();
        return () => signIn.connect(configured);
      },
      p.setup === 'skill' ? 'Enable skill' : 'Save & connect',
    );
    if ($('#pluginauthmode')) {
      const auth = () => {
        const needsToken = $('#pluginauthmode').value === 'token';
        $('#plugintoken').hidden = !needsToken;
        $('#plugintoken input').required = needsToken;
      };
      auth();
      $('#pluginauthmode').onchange = auth;
    }
  }
  function addMcp() {
    close();
    modal(
      'Add an MCP server',
      `<p class="muted">Point this at a Streamable HTTP MCP server. The Bots you select can call its tools. Each new tool asks before it runs.</p>${field('Name', 'name', '', 'text', 'required')}${field('MCP server URL', 'endpoint', '', 'url', 'required')}<label for="pluginauthmode">Authentication</label><select id="pluginauthmode" name="auth"><option value="none">No authentication</option><option value="token">API key / bearer token</option><option value="oauth">Sign in with OAuth</option></select><div id="plugintoken" hidden>${field('API key / token (private)', 'token', '', 'password', 'autocomplete="off"')}</div><details><summary>Registered OAuth client (if the server requires one)</summary>${field('Client ID', 'clientId')}${field('Client secret (private)', 'clientSecret', '', 'password', 'autocomplete="off"')}</details>${field('Account label', 'accountLabel', 'User configured account', 'text')}${botChecks()}`,
      async (f) => {
        const botIds = f.getAll('botIds');
        if (!botIds.length) throw Error('Choose at least one Bot that can use this server.');
        const value = {
          name: f.get('name'),
          endpoint: f.get('endpoint'),
          auth: f.get('auth'),
          accountLabel: f.get('accountLabel') || 'User configured account',
          botIds,
        };
        for (const key of ['token', 'clientId', 'clientSecret'])
          if (f.get(key)) value[key] = f.get(key);
        const created = await api('/plugins/servers', value);
        if (value.auth === 'oauth') {
          const flow = await api(`/connections/${created.id}/authorize`, {});
          window.open(flow.authorizationUrl, '_blank', 'noopener');
          toast('Finish sign-in in the browser, then test this server’s tools.');
        } else {
          const ready = await api(`/connections/${created.id}/discover`, {});
          toast(`${ready.discoveredTools.length} tools are available to the selected Bots.`);
        }
        await refresh();
        return async () => {
          installedOnly = true;
          await open(false);
        };
      },
      'Add server',
    );
    const auth = () => {
      const needsToken = $('#pluginauthmode').value === 'token';
      $('#plugintoken').hidden = !needsToken;
      $('#plugintoken input').required = needsToken;
    };
    auth();
    $('#pluginauthmode').onchange = auth;
  }
  function customSkill() {
    close();
    modal(
      'Add a skill',
      `${field('Name', 'name', '', 'text', 'required')}${area('Instructions', 'instructions')}${botChecks()}`,
      async (f) =>
        api('/extensions', {
          name: f.get('name'),
          instructions: f.get('instructions'),
          botIds: f.getAll('botIds'),
          type: 'skill',
          version: '1.0.0',
          source: 'User-authored skill',
        }),
      'Add skill',
    );
  }
  return { open };
}
