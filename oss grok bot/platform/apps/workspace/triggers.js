import { copyText } from './clipboard.js';
export function triggersUI(ctx) {
  const { $, api, esc, modal, field, area, action, close, toast } = ctx;
  async function open() {
    const items = await api('/triggers');
    modal(
      'Event triggers',
      `<p class="muted">Signed events admit a fixed task through the same durable queue. Event bodies are reference data; they cannot change the task or its grants. Delivery IDs are deduplicated.</p><div class="stack">${items.map((t) => `<article class="card"><h3>${esc(t.name)}</h3><p>${esc(t.task)}</p><p class="tiny muted">${t.enabled ? 'Enabled' : 'Paused'} · /api/hooks/${t.id}</p><button type="button" class="small" data-trigger="${t.id}">${t.enabled ? 'Pause' : 'Resume'}</button></article>`).join('') || '<p class="muted">No event triggers.</p>'}</div><button type="button" id="newtrigger" style="margin-top:16px">＋ New signed trigger</button>`,
    );
    document.querySelectorAll('[data-trigger]').forEach(
      (b) =>
        (b.onclick = action(async () => {
          const t = items.find((t) => t.id === b.dataset.trigger);
          await api(`/triggers/${t.id}`, { enabled: !t.enabled, revision: t.revision });
          close();
          await open();
        })),
    );
    $('#newtrigger').onclick = () => {
      close();
      modal(
        'New event trigger',
        `${field('Name', 'name', '', 'text', 'required')}<label>Bot</label><select name="botId">${ctx
          .state()
          .bots.filter((b) => b.accessRole === 'owner')
          .map((b) => `<option value="${b.id}">${esc(b.name)}</option>`)
          .join('')}</select>${area('Fixed task to perform when a signed event arrives', 'task')}`,
        async (f) => {
          const t = await api('/triggers', Object.fromEntries(f));
          return () => instructions(t);
        },
      );
    };
  }
  function instructions(t) {
    close();
    modal(
      'Private event signing setup',
      `<p>The signing secret is shown only now. Copy it privately into your event sender.</p><input id="triggersecret" type="password" readonly value="${esc(t.signingSecret)}"><button type="button" id="copytriggersecret" style="margin-top:12px">Copy private signing secret</button><label>Local receiver</label><pre class="pre">${esc(location.origin)}/api/hooks/${t.id}</pre><p class="tiny muted">POST JSON with X-Workshop-Event-ID, X-Workshop-Timestamp (Unix milliseconds), and X-Workshop-Signature. Signature is hex HMAC-SHA256 over timestamp + "." + event ID + "." + exact body bytes. Timestamp tolerance: five minutes. This loopback service is not publicly reachable.</p>`,
    );
    $('#copytriggersecret').onclick = action(async () => {
      await copyText(t.signingSecret);
      toast('Private signing secret copied');
    });
  }
  return { open };
}
