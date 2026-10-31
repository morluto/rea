import { remoteUI } from './remote.js';
import { icon } from './icons.js';
import { operationsUI } from './operations.js';
import { computerUI } from './computer.js';
import { oauthUI } from './oauth.js';
import { connectedActionsUI } from './connected-actions.js';
import { triggersUI } from './triggers.js';
import { voiceUI } from './voice.js';
import { devicesUI } from './devices.js';
import { collaborationUI } from './collaboration.js';
import { codingUI } from './coding.js';
import { learningUI } from './learning.js';
import { personalVaultUI } from './personal-vault.js';
import { policiesUI } from './policies.js';
import { librarySearchUI } from './library-search.js';
import { marketplaceUI } from './marketplace.js';
export function featureUI(ctx) {
  const { $, api, esc, modal, field, area, action, toast, close, refresh } = ctx;
  const collaboration = collaborationUI(ctx),
    devices = devicesUI(ctx),
    voice = voiceUI(ctx),
    triggers = triggersUI(ctx),
    operations = operationsUI(ctx);
  const remote = remoteUI(ctx);
  const coding = codingUI(ctx);
  const learning = learningUI(ctx),
    personalVault = personalVaultUI(ctx);
  const policies = policiesUI(ctx);
  const librarySearch = librarySearchUI(ctx);
  const marketplace = marketplaceUI(ctx);
  const computer = computerUI(ctx),
    oauth = oauthUI(ctx),
    connectedActions = connectedActionsUI(ctx);
  const terminal = (s) => ['settled', 'failed', 'cancelled', 'interrupted'].includes(s);
  let alertAccount = null,
    alertSeen = null,
    alertNext = 0,
    alertBusy = false;
  async function browserAlerts() {
    if (alertBusy || Date.now() < alertNext) return;
    alertNext = Date.now() + 5000;
    const account = ctx.state().account?.id;
    if (!account) return;
    if (account !== alertAccount) {
      alertAccount = account;
      alertSeen = null;
    }
    alertBusy = true;
    try {
      const items = (await api('/notifications')).slice(-500);
      const deliveredKey = 'orbit-alerts-submitted-' + account;
      const delivered = new Set(JSON.parse(localStorage.getItem(deliveredKey) ?? '[]'));
      const fresh = items.filter(
        (notice) =>
          !notice.read &&
          !delivered.has(notice.id) &&
          ['reminder', 'approval', 'input'].includes(notice.kind),
      );
      alertSeen = new Set(items.map((notice) => notice.id));
      const native = window.workshopDesktop?.notificationStatus
        ? await window.workshopDesktop.notificationStatus()
        : null;
      const enabled = native
        ? native.enabled && native.supported
        : localStorage.getItem('workshop-browser-alerts') === 'enabled' &&
          'Notification' in window &&
          Notification.permission === 'granted';
      if (enabled || window.webkit?.messageHandlers?.orbitNotify)
        for (const notice of fresh.slice(-3)) {
          if (window.webkit?.messageHandlers?.orbitNotify) {
            window.webkit.messageHandlers.orbitNotify.postMessage({
              title: notice.title,
              body: notice.message,
              tag: notice.id,
            });
            delivered.add(notice.id);
            continue;
          }
          if (native) {
            if (await window.workshopDesktop.notify(notice.title, notice.message, notice.id))
              delivered.add(notice.id);
          } else if (enabled) {
            const banner = new Notification(notice.title, {
              body: notice.message,
              tag: notice.id,
              icon: '/icon.svg',
            });
            banner.onclick = () => {
              window.focus();
              banner.close();
            };
            delivered.add(notice.id);
          }
        }
      localStorage.setItem(deliveredKey, JSON.stringify([...delivered].slice(-500)));
    } catch {
    } finally {
      alertBusy = false;
    }
  }
  function global() {
    void browserAlerts();
    const foot = document.querySelector('.toolmenu') ?? document.querySelector('.sidefoot');
    if (!foot || $('#connectionsfeature')) return;
    const block = document.createElement('div');
    block.className = 'stack';
    block.innerHTML = [
      ['remotefeature', 'device', 'Primary host'],
      ['operationsfeature', 'archive', 'Backups & app'],
      ['triggersfeature', 'bolt', 'Event triggers'],
      ['voicefeature', 'mic', 'Voice & dictation'],
      ['devicesfeature', 'device', 'Devices'],
      ['codingfeature', 'bolt', 'T3 coding'],
      ['learningfeature', 'library', 'Taught tasks'],
      ['librarysearchfeature', 'search', 'Search library'],
      ['marketplacefeature', 'library', 'Template marketplace'],
      ['vaultfeature', 'archive', 'Personal vault'],
      ['policiesfeature', 'settings', 'Custom action rules'],
      ['peoplefeature', 'people', 'People & rooms'],
      ['connectionsfeature', 'connection', 'Connections'],
      ['notificationsfeature', 'bell', 'Notifications'],
      ['analyticsfeature', 'chart', 'Analytics'],
    ]
      .map(
        ([id, glyph, label]) =>
          `<button class="quiet" id="${id}">${icon(glyph, 17)}<span class="sidebarlabel">${label}</span></button>`,
      )
      .join('');
    foot.prepend(block);
    $('#remotefeature').onclick = action(remote.open);
    $('#operationsfeature').onclick = action(operations.open);
    $('#triggersfeature').onclick = action(triggers.open);
    $('#voicefeature').onclick = voice.open;
    $('#devicesfeature').onclick = action(devices.open);
    $('#codingfeature').onclick = action(coding.open);
    $('#learningfeature').onclick = action(learning.open);
    $('#librarysearchfeature').onclick = librarySearch.open;
    $('#marketplacefeature').onclick = action(marketplace.open);
    $('#vaultfeature').onclick = action(personalVault.open);
    $('#policiesfeature').onclick = action(policies.open);
    $('#peoplefeature').onclick = action(collaboration.open);
    $('#connectionsfeature').onclick = action(connections);
    $('#notificationsfeature').onclick = action(notifications);
    $('#analyticsfeature').onclick = action(() => analytics());
    block.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-label', b.textContent.trim().replace(/^[^\p{L}]+/u, ''));
    });
    const mail = document.createElement('button');
    mail.className = 'quiet';
    mail.id = 'mailfeature';
    mail.setAttribute('aria-label', 'Mail & calendar');
    mail.innerHTML = icon('mail', 17) + '<span class="sidebarlabel">Mail & calendar</span>';
    mail.onclick = action(connectedActions.open);
    block.prepend(mail);
  }
  async function connections() {
    const items = await api('/connections');
    modal(
      'Connected tools',
      `<p class="muted">Connect an MCP HTTP server or a named HTTP API. Only discovered/configured tools with explicit Bot grants can run. Credentials remain separate from prompts.</p><div class="stack">${items.map((c) => `<article class="card"><h3>${esc(c.name)}</h3><p class="tiny muted">${esc(c.kind)} · ${esc(c.accountLabel)}<br>${esc(c.endpoint)}<br>${esc(c.state)} · ${c.discoveredTools.length} named tools · ${c.enabled ? 'enabled' : 'disabled'}</p><div class="row"><button type="button" class="small" data-discover="${c.id}">Discover / validate tools</button><button type="button" class="small" data-grants="${c.id}">Grants & policies</button></div></article>`).join('') || '<p class="muted">No connections configured.</p>'}</div><button type="button" id="newconnection" style="margin-top:18px">＋ New connection</button>`,
    );
    const newOauth = document.createElement('button');
    newOauth.type = 'button';
    newOauth.textContent = 'Connect Google / Microsoft mail or calendar';
    newOauth.style.marginTop = '12px';
    $('#newconnection').after(newOauth);
    newOauth.onclick = () => {
      close();
      oauth.create(botChecks);
    };
    for (const c of items.filter((c) => c.oauth)) {
      const card = document.querySelector(`[data-grants="${c.id}"]`).closest('article');
      const controls = document.createElement('div');
      controls.className = 'row';
      controls.innerHTML = `<button type="button" class="small" data-oauth="${c.id}">Authorize / reconnect account</button><button type="button" class="small" data-disconnect-oauth="${c.id}">Disconnect locally</button>`;
      card.append(controls);
      const discover = card.querySelector('[data-discover]');
      discover.disabled = true;
      discover.textContent =
        c.oauth.state === 'authenticated' ? 'Account verified' : 'Authorization required';
    }
    oauth.bind(items, connections);
    $('#newconnection').onclick = () => {
      close();
      connectionForm();
    };
    document.querySelectorAll('[data-discover]').forEach(
      (b) =>
        (b.onclick = action(async () => {
          b.disabled = true;
          try {
            await api(`/connections/${b.dataset.discover}/discover`, {});
            close();
            await connections();
          } finally {
            b.disabled = false;
          }
        })),
    );
    document
      .querySelectorAll('[data-grants]')
      .forEach(
        (b) => (b.onclick = () => connectionGrants(items.find((c) => c.id === b.dataset.grants))),
      );
  }
  function botChecks(selected = []) {
    return `<div class="checks">${ctx
      .state()
      .bots.filter((b) => !b.retired)
      .map(
        (b) =>
          `<label><input name="botIds" type="checkbox" value="${b.id}" ${selected.includes(b.id) ? 'checked' : ''}>${esc(b.name)}</label>`,
      )
      .join('')}</div>`;
  }
  async function connectionForm() {
    const devices = await api('/devices');
    modal(
      'New connection',
      `${field('Name', 'name', '', 'text', 'required')}<label>Transport</label><select name="kind"><option value="mcp">MCP · Streamable HTTP</option><option value="http">HTTP API · named operations</option></select>${field('Endpoint URL', 'endpoint', '', 'url', 'required')}<label>HTTP route</label><select name="routeDeviceId"><option value="">Direct from host</option>${devices
        .filter((d) => d.routing && d.state !== 'revoked')
        .map((d) => `<option value="${d.id}">Via ${esc(d.name)}</option>`)
        .join(
          '',
        )}</select><p class="tiny muted">A selected routing device receives this connection?s transport credential. Its routing and Bot grants must also permit the operation.</p>${field('Selected account label', 'accountLabel', '', 'text', 'required')}${field('Bearer token (private, optional)', 'token', '', 'password', 'autocomplete="off"')}<label>Grant to Bots</label>${botChecks()}<details><summary>HTTP operation definitions</summary><p class="tiny muted">For HTTP APIs, define exact operation names, relative paths, methods, JSON input schemas and ask/allow/deny policies. MCP tools are discovered from the server.</p>${area('Operations JSON', 'tools', '[]')}</details>`,
      async (f) => {
        const tools = JSON.parse(f.get('tools') || '[]');
        await api('/connections', {
          name: f.get('name'),
          kind: f.get('kind'),
          endpoint: f.get('endpoint'),
          accountLabel: f.get('accountLabel'),
          token: f.get('token'),
          botIds: f.getAll('botIds'),
          tools,
          routeDeviceId: f.get('routeDeviceId') || null,
        });
      },
      'Save connection',
    );
  }
  function connectionGrants(c) {
    close();
    modal(
      `${c.name} · access`,
      `<label class="row"><input style="width:auto" type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}>Enabled</label><label>Granted Bots (also enable Connected tools in Bot settings)</label>${botChecks(c.botIds)}<label>Named operation policies</label>${c.discoveredTools.map((t) => `<label>${esc(t.name)}</label><p class="tiny muted">${esc(t.description)}</p><select name="policy-${esc(t.name)}">${['ask', 'allow', 'deny'].map((p) => `<option ${t.policy === p ? 'selected' : ''}>${p}</option>`).join('')}</select>`).join('')}<p class="tiny muted">Ask requires approval of the concrete tool and arguments. Allow is a standing grant for this named operation and account. Deny never dispatches it.</p>`,
      async (f) => {
        await api(`/connections/${c.id}`, {
          revision: c.revision,
          enabled: f.has('enabled'),
          botIds: f.getAll('botIds'),
          policies: Object.fromEntries(
            c.discoveredTools.map((t) => [t.name, f.get('policy-' + t.name)]),
          ),
        });
      },
    );
  }
  async function notifications() {
    const items = await api('/notifications');
    const botId = ctx.botId();
    const reminders = botId ? await api('/bots/' + botId + '/reminders') : [];
    const native = window.workshopDesktop?.notificationStatus
      ? await window.workshopDesktop.notificationStatus()
      : null;
    const enabled = native
      ? native.enabled
      : localStorage.getItem('workshop-browser-alerts') === 'enabled';
    modal(
      'Notifications',
      '<p id="alertstatus" class="notice">' +
        esc(
          native
            ? 'Native desktop alerts: ' +
                (native.supported ? (enabled ? 'enabled' : 'off') : 'unsupported')
            : 'Browser alerts: ' +
                ('Notification' in window ? Notification.permission : 'unsupported'),
        ) +
        '</p>' +
        '<p class="muted">Windows, Mac and iPhone banners are only for a decision, a question, or a reminder. Task progress stays quiet. The computer running Orbit has to stay awake, and system settings can still hide a banner.</p>' +
        '<div class="row wrap"><button type="button" id="desktopnotify">' +
        (enabled ? 'Disable' : 'Enable') +
        ' desktop alerts</button><button type="button" id="testnotify">Send test notification</button>' +
        (botId ? '<button type="button" id="remindonce">Remind me once</button>' : '') +
        '</div>' +
        '<div class="stack">' +
        reminders
          .filter((row) => row.state === 'scheduled')
          .map(
            (row) =>
              '<article class="card"><h3>One-time reminder</h3><p>' +
              esc(row.message) +
              '</p><p>' +
              esc(new Date(row.dueAt).toLocaleString()) +
              '</p><button type="button" data-reminder-cancel="' +
              row.id +
              '">Cancel reminder</button></article>',
          )
          .join('') +
        items
          .map(
            (notice) =>
              '<article class="card"><h3>' +
              esc(notice.title) +
              '</h3><p>' +
              esc(notice.message) +
              '</p><p class="tiny muted">' +
              esc(new Date(notice.createdAt).toLocaleString()) +
              ' - ' +
              (notice.read ? 'read' : 'unread') +
              '</p>' +
              (!notice.read
                ? '<button type="button" data-read="' + notice.id + '">Mark read</button>'
                : '') +
              '</article>',
          )
          .join('') +
        '</div>',
    );
    document.querySelectorAll('[data-read]').forEach(
      (button) =>
        (button.onclick = action(async () => {
          await api('/notifications', { id: button.dataset.read });
          close();
          await notifications();
        })),
    );
    document.querySelectorAll('[data-reminder-cancel]').forEach(
      (button) =>
        (button.onclick = action(async () => {
          await api(
            '/bots/' + botId + '/reminders/' + button.dataset.reminderCancel + '/cancel',
            {},
          );
          close();
          await notifications();
        })),
    );
    $('#desktopnotify').onclick = action(async () => {
      if (native) {
        const current = await window.workshopDesktop.notificationStatus();
        await window.workshopDesktop.setNotifications(!current.enabled);
      } else {
        if (!('Notification' in window))
          throw Error('This browser does not support desktop alerts');
        if (enabled) localStorage.setItem('workshop-browser-alerts', 'disabled');
        else {
          const permission = await Notification.requestPermission();
          localStorage.setItem(
            'workshop-browser-alerts',
            permission === 'granted' ? 'enabled' : 'disabled',
          );
        }
      }
      alertNext = 0;
      close();
      await notifications();
    });
    $('#testnotify').onclick = action(async () => {
      if (native) {
        const submitted = await window.workshopDesktop.notify(
          'Orbit notification test',
          'If you can see this banner, desktop alerts are working.',
          'orbit-notification-test',
        );
        if (!submitted) throw Error('Enable supported desktop alerts first');
      } else {
        if (!enabled || !('Notification' in window) || Notification.permission !== 'granted')
          throw Error('Enable desktop alerts first');
        new Notification('Orbit notification test', {
          body: 'If you can see this banner, desktop alerts are working.',
        });
      }
      toast(
        'Submitted to the operating system. Check for the test banner; submission alone does not confirm display.',
      );
    });
    $('#remindonce')?.addEventListener('click', () => {
      close();
      modal(
        'One-time reminder',
        area('Reminder message', 'message') +
          field('Remind me after (seconds)', 'delaySeconds', 60, 'number', 'min="1" required'),
        async (form) => {
          await api('/bots/' + botId + '/reminders', {
            message: form.get('message'),
            delaySeconds: Number(form.get('delaySeconds')),
            nonce: crypto.randomUUID(),
            ...(ctx.conversationId() ? { conversationId: ctx.conversationId() } : {}),
          });
        },
        'Schedule once',
      );
    });
  }
  async function analytics(days = 30) {
    const v = await api('/analytics?days=' + days);
    modal(
      'Workspace analytics',
      `<div class="row">${[7, 30, 90].map((d) => `<button type="button" class="small" data-days="${d}">${d} days</button>`).join('')}</div><div class="cards" style="margin-top:20px">${[
        ['Accepted tasks', v.runs],
        ['Completed', v.completed],
        ['Failed', v.failed],
        ['Cancelled', v.cancelled],
        ['Active days', v.activeDays],
        ['Reported tokens', v.reportedTokens],
        ['Estimated cost (USD)', v.estimatedCostUsd ?? 0],
        ['Runs with your rates', v.runsWithCostBasis ?? 0],
      ]
        .map(
          ([label, value]) =>
            `<div class="card"><p class="tiny muted">${label}</p><h2>${value.toLocaleString()}</h2></div>`,
        )
        .join(
          '',
        )}</div><p class="tiny muted" style="margin-top:18px">${v.runsWithReportedUsage} runs have provider-reported usage. Cost is a host-computed estimate from your optional model rates, not a provider invoice. Minutes saved are unknown. Period begins ${new Date(v.periodStart).toLocaleString()}.</p>`,
    );
    document.querySelectorAll('[data-days]').forEach(
      (b) =>
        (b.onclick = action(async () => {
          close();
          await analytics(Number(b.dataset.days));
        })),
    );
  }
  function panel(tab, panel) {
    const o = ctx.overview(),
      botId = ctx.botId();
    if (tab === 'computer') {
      computer.render(panel);
      return true;
    }
    if (tab === 'queue') {
      const runs = o.runs
        .filter((r) => !terminal(r.state))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.acceptedAt - b.acceptedAt);
      panel.innerHTML = `<div class="sectionhead"><h2>Task queue</h2><p class="muted">One execution stream per Bot. Input waits, workers and approvals retain their task identity.</p></div><div class="stack">${runs.map((r) => `<article class="card"><div class="row spread"><h3>${esc(r.text.slice(0, 100))}</h3><span class="badge">${esc(r.state)}</span></div><p class="tiny muted">${esc(r.id)} · priority ${r.priority ?? 0}</p><div class="actions">${r.state === 'queued' ? `<button class="small" data-priority="${r.id}">Move to front</button>` : `<button class="small" data-steer="${r.id}">Steer task</button>`}<button class="small danger" data-stop="${r.id}">Cancel task & children</button></div></article>`).join('') || '<div class="listempty">No active or queued tasks.</div>'}</div>`;
      document.querySelectorAll('[data-priority]').forEach(
        (b) =>
          (b.onclick = action(async () => {
            const r = runs.find((r) => r.id === b.dataset.priority);
            await api(`/bots/${botId}/queue/${r.id}`, {
              priority: Math.min(100, Math.max(...runs.map((r) => r.priority ?? 0)) + 1),
              revision: r.revision,
            });
            await refresh();
          })),
      );
      document.querySelectorAll('[data-stop]').forEach(
        (b) =>
          (b.onclick = action(async () => {
            await api(`/bots/${botId}/runs/${b.dataset.stop}/cancel`, {});
            await refresh();
          })),
      );
      document
        .querySelectorAll('[data-steer]')
        .forEach((b) => (b.onclick = () => steer(b.dataset.steer)));
      return true;
    }
    if (tab === 'knowledge') {
      const entries = o.knowledge ?? [];
      panel.innerHTML = `<div class="sectionhead row spread"><div><h2>Knowledge & review</h2><p class="muted">Accepted source material is searchable. Proposed knowledge waits for your review.</p></div><button id="addknowledge">＋ Add knowledge</button></div><div class="stack">${entries.map((k) => `<article class="card"><div class="row spread"><h3>${esc(k.title)}</h3><span class="badge">${esc(k.state)} · r${k.revision}</span></div><p class="pre">${esc(k.content.slice(0, 1000))}</p><p class="tiny muted">Source: ${esc(k.source)}</p><button class="small" data-review="${k.id}">Review / edit</button></article>`).join('') || '<div class="listempty">No knowledge entries yet.</div>'}</div>`;
      $('#addknowledge').onclick = () => knowledgeForm();
      document
        .querySelectorAll('[data-review]')
        .forEach(
          (b) => (b.onclick = () => knowledgeForm(entries.find((k) => k.id === b.dataset.review))),
        );
      return true;
    }
    return false;
  }
  function knowledgeForm(k) {
    modal(
      k ? 'Review knowledge' : 'Add knowledge',
      `${field('Title', 'title', k?.title ?? '', 'text', 'required')}${area('Content', 'content', k?.content ?? '')}${!k ? field('Source URL, document or user reference', 'source', '', 'text', 'required') : `<p class="tiny muted">Currently ${esc(k.state)} · r${k.revision}. Only accepted entries are searchable.</p><label>Decision</label><select name="state">${['accepted', 'rejected', 'archived'].map((s) => `<option ${s === k.state ? 'selected' : ''}>${s}</option>`).join('')}</select>`}`,
      async (f) => {
        await api(
          `/bots/${ctx.botId()}/knowledge${k ? '/' + k.id : ''}`,
          k
            ? {
                revision: k.revision,
                title: f.get('title'),
                content: f.get('content'),
                state: f.get('state'),
              }
            : Object.fromEntries(f),
          k ? 'PATCH' : 'POST',
        );
      },
    );
  }
  function steer(runId) {
    modal(
      'Steer the current task',
      area('Correction or additional instruction', 'text'),
      async (f) => {
        await api(`/bots/${ctx.botId()}/runs/${runId}/steer`, { text: f.get('text') });
      },
      'Send steering',
    );
  }
  let waitSignature = '';
  function chat() {
    voice.update();
    const o = ctx.overview(),
      botId = ctx.botId();
    let container = $('#inputcards');
    if (!container) {
      const parent = document.querySelector('.composerbox');
      if (!parent) return;
      container = document.createElement('div');
      container.id = 'inputcards';
      parent.prepend(container);
      waitSignature = '';
    }
    const waits = (o.waits ?? []).filter((w) => w.state === 'pending');
    const signature = JSON.stringify(waits.map((w) => [w.id, w.revision]));
    if (signature === waitSignature) return;
    waitSignature = signature;
    container.innerHTML = waits
      .map(
        (w) =>
          `<form class="card" data-answer="${w.id}"><h3>${esc(w.question)}</h3><div class="row wrap">${w.choices.map((c) => `<button type="button" class="small" data-choice="${esc(c)}">${esc(c)}</button>`).join('')}</div><label for="answer-${w.id}">Answer</label><input id="answer-${w.id}" name="answer" required autocomplete="off"><button class="primary small" style="margin-top:12px">Continue task</button></form>`,
      )
      .join('');
    container.querySelectorAll('form').forEach((form) => {
      form.querySelectorAll('[data-choice]').forEach(
        (b) =>
          (b.onclick = () => {
            form.querySelector('input').value = b.dataset.choice;
          }),
      );
      form.onsubmit = action(async (e) => {
        e.preventDefault();
        const wait = waits.find((w) => w.id === form.dataset.answer);
        await api(`/bots/${botId}/waits/${wait.id}`, {
          answer: new FormData(form).get('answer'),
          revision: wait.revision,
        });
        await refresh();
      });
    });
  }
  return {
    global,
    panel,
    chat,
    connections,
    manageConnection: connectionGrants,
    notifications,
    analytics,
    stop: () => {
      voice.stop();
      alertAccount = null;
      alertSeen = null;
    },
  };
}
