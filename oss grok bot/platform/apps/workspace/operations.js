let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});
export function operationsUI(ctx) {
  const { $, api, esc, modal, field, action, toast, close } = ctx;
  async function open() {
    let backups = [];
    try {
      backups = await api('/backups');
    } catch {}
    const native = window.workshopDesktop ? await window.workshopDesktop.info() : null;
    const registration =
      'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const application = native
      ? `<h3 style="margin-top:24px">Desktop app · ${esc(native.version)}</h3><p class="tiny muted">${native.mode === 'remote' ? 'Connected to your primary host. Bot work runs there.' : 'This computer is the primary host. Closing the window keeps it running; Quit stops the host.'}</p><button type="button" id="nativehost">Choose primary host</button><p class="tiny muted">This is the installed Electron app. Updates are installed from a new desktop installer; no automatic update service is connected.</p>`
      : `<h3 style="margin-top:24px">Web workspace</h3><p class="tiny muted">Install in a supported browser for a standalone window. Accepted tasks remain on the primary host.</p><div class="row wrap"><button type="button" id="installapp" ${!installPrompt ? 'disabled' : ''}>Install web app</button><button type="button" id="checkappupdate">Check shell update</button>${registration?.waiting ? '<button type="button" id="activateupdate">Activate update & reload</button>' : ''}</div><p class="tiny muted">${installPrompt ? 'Browser installation is available.' : 'Use the browser’s Install app menu when offered.'} Reloading clears unsent composer drafts.</p>`;
    modal(
      'Backups & application',
      `<h3>Product backups</h3><p class="tiny muted">Includes SQLite, canonical sessions, artifact bytes, completed computer snapshots and the encrypted vault/key. Live Docker volumes and companion files have separate lifecycles.</p><button type="button" id="makebackup">Create verified product backup</button><div class="stack" style="margin-top:16px">${backups.map((b) => `<article class="card"><h3>${esc(b.name)}</h3><p class="tiny muted">${b.valid ? `${b.files} files · integrity verified` : 'Integrity failed'}<br>${esc(b.path)}</p>${b.valid ? `<button type="button" class="small" data-restoreguide="${esc(b.path)}">Restore to a new data root</button>` : ''}</article>`).join('') || '<p class="muted">No accessible product backups.</p>'}</div>${application}<h3 style="margin-top:24px">Push notifications</h3><div id="pushsection"><p class="tiny muted">Loading push status…</p></div><h3 style="margin-top:24px">Retention</h3><div id="retentionsection"><p class="tiny muted">Loading retention policy…</p></div><h3 style="margin-top:24px">Workspace</h3><div id="orgsection"><p class="tiny muted">Loading workspace…</p></div>`,
    );
    $('#nativehost')?.addEventListener('click', () => window.workshopDesktop.chooseHost());
    $('#makebackup').onclick = action(async () => {
      const b = await api('/backup', {});
      toast(`Verified backup created: ${b.path}`);
      close();
      await open();
    });
    document.querySelectorAll('[data-restoreguide]').forEach(
      (b) =>
        (b.onclick = () => {
          const path = b.dataset.restoreguide;
          close();
          modal(
            'Restore a verified backup',
            `<p>Restore creates a new data root. It never overwrites an existing directory or adopts original live Docker resources. Schedules are paused and sessions expire.</p><p class="tiny muted">From the platform directory, run:</p><pre class="pre">node_modules/node/bin/node.exe scripts/restore.mjs inspect '${esc(path.replaceAll("'", "''"))}'
node_modules/node/bin/node.exe scripts/restore.mjs restore '${esc(path.replaceAll("'", "''"))}' 'NEW_EMPTY_DATA_ROOT'
$env:WORKSHOP_DATA = 'NEW_EMPTY_DATA_ROOT'
powershell -File scripts/start.ps1</pre><p class="tiny muted">Stop the current service before starting the restored workspace on the same port. Its original files and computer volumes remain intact.</p>`,
          );
        }),
    );
    void loadPush().catch((e) => {
      $('#pushsection').innerHTML = `<p class="tiny muted">${esc(e.message)}</p>`;
    });
    void loadRetention().catch((e) => {
      $('#retentionsection').innerHTML = `<p class="tiny muted">${esc(e.message)}</p>`;
    });
    void loadOrg().catch((e) => {
      $('#orgsection').innerHTML = `<p class="tiny muted">${esc(e.message)}</p>`;
    });
    async function loadPush() {
      const status = await api('/push/status');
      const box = $('#pushsection');
      if (!status.configured) {
        box.innerHTML = `<p class="tiny muted">Push delivery is not configured. Configuring generates local VAPID keys; the private key stays in the secret store.</p><button type="button" id="pushconfig">Enable push delivery</button>`;
        $('#pushconfig').onclick = action(async () => {
          await api('/push/config', {});
          toast('Push delivery enabled');
          await loadPush();
        });
        return;
      }
      box.innerHTML = `<p class="tiny muted">Push delivery is enabled for this workspace. Subscribing registers this browser for run results, reminders and coding outcomes. Payloads are titles only.</p><div class="stack">${status.subscriptions.map((s) => `<p class="tiny muted">${esc(s.endpoint.slice(0, 80))}… · ${new Date(s.createdAt).toLocaleString()} <button type="button" class="small" data-unsub="${esc(s.id)}">Remove</button></p>`).join('') || '<p class="muted">This browser is not subscribed.</p>'}</div><div class="row wrap"><button type="button" id="pushsubscribe">Subscribe this browser</button></div>`;
      document.querySelectorAll('[data-unsub]').forEach(
        (b) =>
          (b.onclick = action(async () => {
            await api(`/push/subscriptions/${b.dataset.unsub}/remove`, {});
            await loadPush();
          })),
      );
      $('#pushsubscribe').onclick = action(async () => {
        if (!('serviceWorker' in navigator) || !('PushManager' in window))
          throw Error('Push is unavailable in this browser');
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw Error('Notification permission was not granted');
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) throw Error('Service worker is unavailable');
        const key = new Uint8Array(
          atob(status.publicKey.replace(/-/g, '+').replace(/_/g, '/'))
            .split('')
            .map((c) => c.charCodeAt(0)),
        );
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
        await api('/push/subscriptions', subscription.toJSON());
        toast('This browser is subscribed');
        await loadPush();
      });
    }
    async function loadRetention() {
      let policy;
      try {
        policy = await api('/admin/retention');
      } catch (e) {
        $('#retentionsection').innerHTML =
          `<p class="tiny muted">Retention is managed by the workspace owner. ${esc(e.message)}</p>`;
        return;
      }
      $('#retentionsection').innerHTML =
        `<p class="tiny muted">${esc(policy.states)}</p>${field('Event retention (days)', 'eventDays', policy.eventDays, 'number', 'required min="7"')}${field('Expired search snapshots (days)', 'snapshotDays', policy.snapshotDays, 'number', 'required min="1"')}${field('Settled run partials (days)', 'partialDays', policy.partialDays, 'number', 'required min="1"')}${field('Read notifications (days)', 'notificationDays', policy.notificationDays, 'number', 'required min="1"')}<div class="row wrap"><button type="button" id="retentionsave">Save retention</button><button type="button" id="retentionprune">Prune now</button></div>`;
      $('#retentionsave').onclick = action(async () => {
        await api('/admin/retention', {
          eventDays: Number(document.querySelector('#f-eventDays').value),
          snapshotDays: Number(document.querySelector('#f-snapshotDays').value),
          partialDays: Number(document.querySelector('#f-partialDays').value),
          notificationDays: Number(document.querySelector('#f-notificationDays').value),
          revision: policy.revision,
        });
        toast('Retention saved');
        await loadRetention();
      });
      $('#retentionprune').onclick = action(async () => {
        const result = await api('/admin/retention/prune', {});
        toast(
          `Pruned ${result.deletedEvents} events, ${result.deletedSnapshots} snapshots, ${result.clearedPartials} partials, ${result.deletedNotifications} notifications`,
        );
      });
    }
    async function loadOrg() {
      let org;
      try {
        org = await api('/org');
      } catch (e) {
        $('#orgsection').innerHTML = `<p class="tiny muted">${esc(e.message)}</p>`;
        return;
      }
      $('#orgsection').innerHTML =
        `<p class="tiny muted">${esc(org.note)}</p><p class="tiny muted">Satellites: ${org.satellites.length ? org.satellites.map((s) => `${esc(s.label)} (${esc(s.state)})`).join(', ') : 'none paired'}</p>`;
    }
    if (!native) {
      $('#installapp').onclick = action(async () => {
        if (!installPrompt) throw Error('Installation is not offered by this browser');
        await installPrompt.prompt();
        const choice = await installPrompt.userChoice;
        toast(`Installation: ${choice.outcome}`);
        installPrompt = null;
      });
      $('#checkappupdate').onclick = action(async () => {
        if (!registration) throw Error('Service worker is unavailable in this browser');
        await registration.update();
        toast(
          registration.waiting
            ? 'Update ready. Reopen this panel to activate.'
            : 'Update check complete',
        );
      });
      $('#activateupdate')?.addEventListener('click', () => {
        registration.waiting.postMessage('ACTIVATE_UPDATE');
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
          once: true,
        });
      });
    }
  }
  return { open };
}
