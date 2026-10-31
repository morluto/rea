export function connectedActionsUI(ctx) {
  const { $, api, esc, modal, field, area, action, close, toast } = ctx;
  async function open() {
    const items = (await api('/connections')).filter((c) => c.oauth);
    modal(
      'Mail & calendar',
      `<p class="muted">Choose an authenticated account and a granted Bot. Each operation uses the same permission checks, approvals, durable queue and receipts as model tools. A model is not required for these direct actions.</p><div class="stack">${
        items
          .map(
            (c) =>
              `<article class="card"><h3>${esc(c.name)}</h3><p class="tiny muted">${esc(c.oauth.provider)} · ${esc(c.oauth.service)} · ${esc(c.oauth.accountEmail ?? 'Account not authenticated')}<br>${esc(c.state)} · ${c.enabled ? 'enabled' : 'disabled'}</p><div class="row wrap">${c.discoveredTools
                .filter((op) => op.policy !== 'deny')
                .map(
                  (op) =>
                    `<button type="button" class="small" data-connection="${c.id}" data-operation="${esc(op.name)}">${esc(op.name)}</button>`,
                )
                .join('')}</div></article>`,
          )
          .join('') ||
        '<p class="muted">No mail/calendar account configured. Use Connections to register your OAuth client and authorize the selected account.</p>'
      }</div>`,
    );
    document.querySelectorAll('[data-operation]').forEach(
      (b) =>
        (b.onclick = () => {
          const c = items.find((c) => c.id === b.dataset.connection);
          close();
          compose(
            c,
            c.discoveredTools.find((op) => op.name === b.dataset.operation),
          );
        }),
    );
  }
  function compose(c, op) {
    const bots = ctx
      .state()
      .bots.filter(
        (b) =>
          c.botIds.includes(b.id) &&
          b.accessRole === 'owner' &&
          b.capabilities.includes('extensions'),
      );
    const mail = ['mail.send', 'mail.draft'].includes(op.name),
      calendar = op.name === 'calendar.create';
    modal(
      `${c.name} · ${op.name}`,
      `<p class="tiny muted">Account: ${esc(c.oauth.accountEmail ?? 'Not authenticated')}<br>${esc(op.description)}</p><label>Bot granting this action</label><select name="botId" required>${bots.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>${!bots.length ? '<p class="error">Grant this connection to a Bot you own and enable its Connected tools capability first.</p>' : ''}${
        mail
          ? `${field('Recipients, comma separated', 'to', '', 'text', 'required')}${field('Subject', 'subject', '', 'text', 'required')}${area('Message body', 'body', '')}`
          : calendar
            ? `${field('Event title', 'summary', '', 'text', 'required')}${area('Description', 'description', '')}${field('Start (RFC3339 with offset)', 'start', '', 'text', 'required')}${field('End (RFC3339 with offset)', 'end', '', 'text', 'required')}${field('Timezone', 'timezone', ctx.state().settings.timezone ?? 'UTC', 'text', 'required')}${c.oauth.provider === 'google' ? field('Calendar ID', 'calendarId', 'primary') : ''}`
            : `${area(
                'Exact operation arguments (JSON)',
                'args',
                JSON.stringify(
                  Object.fromEntries(
                    Object.entries(op.inputSchema.properties ?? {})
                      .filter(([key]) => op.inputSchema.required?.includes(key))
                      .map(([key, s]) => [
                        key,
                        s.type === 'number' || s.type === 'integer'
                          ? 1
                          : s.type === 'array'
                            ? []
                            : s.type === 'boolean'
                              ? false
                              : '',
                      ]),
                  ),
                  null,
                  2,
                ),
              )}`
      } ${op.name === 'mail.send' ? `${field('Optional host scheduled send time', 'notBefore', '', 'datetime-local')}<p class="tiny muted">Scheduling is owned by this local host. Keep it running. The operation’s ask/allow policy applies at execution time; ask waits for concrete approval. This does not use provider-native scheduled mail.</p>` : ''}`,
      async (f) => {
        let args;
        if (mail)
          args = {
            to: String(f.get('to'))
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            subject: f.get('subject'),
            body: f.get('body'),
          };
        else if (calendar)
          args = {
            summary: f.get('summary'),
            description: f.get('description'),
            start: f.get('start'),
            end: f.get('end'),
            timezone: f.get('timezone'),
            ...(c.oauth.provider === 'google' ? { calendarId: f.get('calendarId') } : {}),
          };
        else args = JSON.parse(f.get('args'));
        const run = await api(`/bots/${f.get('botId')}/actions`, {
          connectionId: c.id,
          operation: op.name,
          args,
          nonce: crypto.randomUUID(),
          notBefore: f.get('notBefore') ? new Date(f.get('notBefore')).getTime() : 0,
        });
        toast(
          `Host accepted ${op.name}: ${run.state} · ${run.id.slice(0, 8)}. Open the Bot’s Queue or Activity for approval and receipts.`,
        );
      },
      'Submit exact action',
    );
  }
  return { open };
}
