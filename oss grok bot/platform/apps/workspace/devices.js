import { copyText } from './clipboard.js';
export function devicesUI(ctx) {
  const { $, api, esc, modal, field, action, close, toast } = ctx;
  async function open() {
    const items = await api('/devices');
    modal(
      'Paired devices',
      `<p class="muted">A companion exposes only a workspace directory you explicitly choose. File access and HTTP routing are separate grants. No host shell or native desktop input is exposed.</p><div class="stack">${items.map((d) => `<article class="card"><h3>${esc(d.name)}</h3><p class="tiny muted">${esc(d.state)} · ${esc(d.os ?? 'not paired')}<br>${esc(d.rootLabel ?? '')}<br>Files ${d.files ? 'allowed' : 'off'} · HTTP routing ${d.routing ? 'allowed' : 'off'}<br>Last seen: ${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'unknown'}</p><div class="row"><button type="button" class="small" data-devicecheck="${d.id}">Check presence</button><button type="button" class="small" data-deviceedit="${d.id}">Grants / revoke</button></div></article>`).join('') || '<p class="muted">No paired devices.</p>'}</div><button type="button" id="pairdevice" style="margin-top:16px">＋ Pair a companion</button>`,
    );
    $('#pairdevice').onclick = () => {
      close();
      modal(
        'Pair a workspace companion',
        `${field('Device name', 'name', '', 'text', 'required')}<label>Granted Bots</label><div class="checks">${ctx
          .state()
          .bots.filter((b) => b.accessRole === 'owner')
          .map(
            (b) =>
              `<label><input type="checkbox" name="botIds" value="${b.id}">${esc(b.name)}</label>`,
          )
          .join(
            '',
          )}</div><div class="checks" style="margin-top:16px"><label><input type="checkbox" name="files">Allow selected workspace file access</label><label><input type="checkbox" name="routing">Allow selected HTTP connections to route here</label></div>`,
        async (f) => {
          const d = await api('/devices', {
            name: f.get('name'),
            botIds: f.getAll('botIds'),
            files: f.has('files'),
            routing: f.has('routing'),
          });
          return () => pairInstructions(d);
        },
        'Create private pairing code',
      );
    };
    document.querySelectorAll('[data-devicecheck]').forEach(
      (b) =>
        (b.onclick = action(async () => {
          await api(`/devices/${b.dataset.devicecheck}/check`, {});
          close();
          await open();
        })),
    );
    document
      .querySelectorAll('[data-deviceedit]')
      .forEach((b) => (b.onclick = () => edit(items.find((d) => d.id === b.dataset.deviceedit))));
  }
  function pairInstructions(d) {
    close();
    modal(
      'Pair this companion',
      `<p>Code expires in ten minutes and can be used once. Enter it in the companion’s private terminal prompt.</p><input id="paircode" type="password" readonly value="${esc(d.pairCode)}"><button type="button" id="copypair" style="margin-top:12px">Copy private pairing code</button><label>Run from the platform directory</label><pre class="pre">python device/companion.py --root "PATH_TO_YOUR_CHOSEN_DIRECTORY"${d.routing ? ' --allow-http-routing' : ''}</pre><p class="tiny muted">The companion binds loopback, identifies its current generation and exposes only the selected root. HTTP routing is limited to configured connector requests; it is not a system-wide VPN. Routing a connection permits this device to receive that connection’s transport credential.</p>`,
    );
    $('#copypair').onclick = action(async () => {
      await copyText(d.pairCode);
      toast('Private code copied');
    });
  }
  function edit(d) {
    close();
    modal(
      'Device grants',
      `${field('Name', 'name', d.name, 'text', 'required')}<label>Granted Bots</label><div class="checks">${ctx
        .state()
        .bots.filter((b) => b.accessRole === 'owner')
        .map(
          (b) =>
            `<label><input name="botIds" type="checkbox" value="${b.id}" ${d.botIds.includes(b.id) ? 'checked' : ''}>${esc(b.name)}</label>`,
        )
        .join(
          '',
        )}</div><div class="checks" style="margin-top:16px"><label><input name="files" type="checkbox" ${d.files ? 'checked' : ''}>Workspace files</label><label><input name="routing" type="checkbox" ${d.routing ? 'checked' : ''}>HTTP connection routing</label></div><label>State</label><select name="state"><option value="paired">Keep paired</option><option value="revoked" ${d.state === 'revoked' ? 'selected' : ''}>Revoke</option></select>`,
      async (f) => {
        await api(`/devices/${d.id}`, {
          revision: d.revision,
          name: f.get('name'),
          botIds: f.getAll('botIds'),
          files: f.has('files'),
          routing: f.has('routing'),
          state: f.get('state'),
        });
      },
    );
  }
  return { open };
}
