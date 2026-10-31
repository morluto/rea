export function remoteUI(ctx) {
  const { $, api, esc, modal, field, action, close, toast } = ctx;
  async function open() {
    let s;
    try {
      s = await api('/remote');
    } catch {
      modal(
        'Your primary host',
        '<p>This app is connected to your primary host. Pairing and network access are managed directly on that computer.</p>',
      );
      return;
    }
    modal(
      'Your primary host',
      `<p>Your Bots, sessions, files and Docker computers run on this machine. Other apps control the same workspace.</p><div class="card"><strong>${s.running ? 'Remote access is running' : 'Remote access is off'}</strong><p class="tiny muted">${esc(s.url ?? 'Add a trusted HTTPS address below to connect your Mac or iPhone.')}${s.lastError ? '<br>' + esc(s.lastError) : ''}</p></div>${s.fingerprint ? `<p class="tiny muted">Compare this host fingerprint when connecting a new app:</p><pre class="pre">${esc(s.fingerprint)}</pre>` : ''}${!s.enabled ? `<label for="remoteaddress">Private network address</label><select id="remoteaddress">${s.addresses.map((a) => `<option value="${esc(a.address)}">${esc(a.name)} - ${esc(a.address)}</option>`).join('')}</select><button type="button" class="primary" id="remotequick" ${!s.addresses.length ? 'disabled' : ''}>Enable private network connection</button><p class="tiny muted">Creates an encrypted connection on the selected address. Other devices verify the host fingerprint once. Keep both devices on the same reachable private network or VPN.</p>` : ''}<div class="row wrap" style="margin:16px 0"><button type="button" id="remoteconfigure">${s.enabled ? 'Change network settings' : 'Advanced HTTPS settings'}</button>${s.running ? '<button type="button" class="primary" id="remotepair">Pair another device</button>' : ''}${s.enabled ? '<button type="button" id="remotestop">Turn off access</button>' : ''}</div><div class="stack">${s.clients.map((c) => `<article class="card row spread"><div><strong>${esc(c.name)}</strong><p class="tiny muted">${esc(c.state)} · paired ${new Date(c.createdAt).toLocaleDateString()}</p></div>${c.state === 'paired' ? `<button type="button" data-revokeclient="${esc(c.id)}">Revoke</button>` : ''}</article>`).join('') || '<p class="muted">No paired remote apps.</p>'}</div>${window.workshopDesktop ? '<button type="button" id="chooseprimary">Choose a different primary host</button>' : ''}`,
    );
    $('#remoteconfigure').onclick = () => configure(s);
    $('#remotequick')?.addEventListener(
      'click',
      action(async () => {
        await api('/remote/quick', { address: $('#remoteaddress').value });
        close();
        await open();
      }),
    );
    $('#remotepair')?.addEventListener('click', () => pair());
    $('#remotestop')?.addEventListener(
      'click',
      action(async () => {
        await api('/remote', { enabled: false, url: s.url, bind: s.bind, port: s.port });
        close();
        await open();
      }),
    );
    document.querySelectorAll('[data-revokeclient]').forEach(
      (b) =>
        (b.onclick = action(async () => {
          await api(`/remote/clients/${b.dataset.revokeclient}/revoke`, {});
          close();
          await open();
        })),
    );
    $('#chooseprimary')?.addEventListener('click', () => window.workshopDesktop.chooseHost());
  }
  function configure(s) {
    close();
    modal(
      'Connect your other apps',
      `<p>Use a hostname reachable from your other devices and a TLS certificate trusted by them. A private VPN with a trusted HTTPS name works too. This app does not change your firewall or publish a tunnel.</p>${field('HTTPS address', 'url', s.url ?? 'https://', 'url', 'required')}${field('Listen interface', 'bind', s.bind ?? '0.0.0.0', 'text', 'required')}${field('Listen port', 'port', s.port ?? 44317, 'number', 'min="1" max="65535" required')}<label for="remotecert">PEM certificate${s.enabled ? ' (leave both files empty to retain it)' : ''}</label><input type="file" id="remotecert" accept=".pem,.crt,.cer"><label for="remotekey">Matching PEM private key</label><input type="file" id="remotekey" accept=".pem,.key"><p class="tiny muted">The selected TLS identity is encrypted in this workspace’s vault. It is never sent to another service.</p>`,
      async (f) => {
        const cert = $('#remotecert').files[0],
          key = $('#remotekey').files[0];
        if (cert?.size > 65536 || key?.size > 65536)
          throw Error('Each PEM file must be under 64 KiB');
        await api('/remote', {
          enabled: true,
          url: f.get('url'),
          bind: f.get('bind'),
          port: Number(f.get('port')),
          ...(cert ? { certificate: await cert.text() } : {}),
          ...(key ? { privateKey: await key.text() } : {}),
        });
        toast('Remote access enabled. Pair an app from your primary host.');
      },
      'Enable remote access',
    );
  }
  function pair() {
    close();
    modal(
      'Pair another app',
      field('Device label', 'name', '', 'text', 'required placeholder="My iPhone"'),
      async (f) => {
        const p = await api('/remote/pair', { name: f.get('name') });
        setTimeout(
          () =>
            modal(
              'Your one-use pairing code',
              `<p>Open this address in the other Orbit app:</p><pre class="pre">${esc(p.url)}</pre><p>Enter this code on that device:</p><input readonly id="paircopy" value="${esc(p.code)}" aria-label="One-use pairing code"><p class="tiny muted">Expires ${new Date(p.expiresAt).toLocaleTimeString()}. It works once. After pairing, sign in with your workspace account.</p>`,
            ),
          0,
        );
      },
      'Create pairing code',
    );
  }
  return { open };
}
