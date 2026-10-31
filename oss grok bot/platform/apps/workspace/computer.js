import { icon } from './icons.js';
export function computerUI(ctx) {
  const { $, api, esc, modal, field, action, refresh } = ctx;
  let engineStarting = false,
    infrastructurePending = false,
    nextInfrastructureCheck = 0;
  const expandedSettings = new Set();
  async function infrastructure(force = false) {
    if (!force && (infrastructurePending || Date.now() < nextInfrastructureCheck)) return;
    const target = $('#infrastructure');
    if (!target) return;
    if (infrastructurePending) return;
    infrastructurePending = true;
    const retry = $('#refreshinfrastructure');
    if (retry) {
      retry.disabled = true;
      retry.textContent = 'Checking...';
    }
    try {
      const v = await api('/docker');
      if (!target.isConnected) return;
      const building = ['building', 'cancelling'].includes(v.build?.state);
      target.innerHTML = `<div class="row spread"><div><h3>${v.imageReady ? 'Linux image available' : v.available ? 'Prepare Linux computers' : 'Linux engine unavailable'}</h3><p class="muted">${esc(v.available ? (v.imageReady ? 'Start this Bot’s computer to verify its desktop and browser.' : 'Prepare the shared Linux image once, then start this Bot’s computer.') : v.reason || 'The Linux engine is unavailable on your primary computer. Start the Docker CLI engine, then retry.')}</p></div><button id="refreshinfrastructure" class="small">Refresh</button></div>${v.canStart && !v.available ? `<button id="startengine" class="small" ${engineStarting ? 'disabled' : ''}>${engineStarting ? 'Starting engine...' : 'Start Linux engine'}</button>` : ''}${v.canPrepare ? `<div class="row wrap"><button id="prepareimage" ${!v.available || building ? 'disabled' : ''}>${v.imageReady ? 'Rebuild Linux image' : 'Prepare Linux image'}</button>${building ? '<button id="cancelimage">Stop build client</button>' : ''}</div>` : '<p class="tiny muted">The workspace owner prepares the shared Linux image.</p>'}${v.build ? `<p class="tiny muted">Build: ${esc(v.build.state)} · ${esc(v.build.message)}</p>${v.build.log ? `<details><summary>Build output</summary><pre class="pre">${esc(v.build.log)}</pre></details>` : ''}` : ''}<details class="computer-advanced" ${ctx.state().settings.showAdvanced ? '' : 'hidden'}><summary>Infrastructure details · observed ${new Date(v.observedAt).toLocaleTimeString()}</summary><pre class="pre">${esc(JSON.stringify({ ...v, build: undefined }, null, 2))}</pre></details>`;
      nextInfrastructureCheck = Date.now() + (building ? 1000 : 5000);
      $('#refreshinfrastructure').onclick = action(() => infrastructure(true));
      if ($('#startengine'))
        $('#startengine').onclick = action(async () => {
          if (engineStarting) return;
          engineStarting = true;
          const button = $('#startengine');
          button.disabled = true;
          button.textContent = 'Starting engine...';
          try {
            const result = await api('/docker/start', {});
            await infrastructure(true);
            if (!result.available)
              ctx.toast(
                result.reason || 'The start request completed, but the Linux engine is not ready.',
              );
          } finally {
            engineStarting = false;
            const current = $('#startengine');
            if (current) {
              current.disabled = false;
              current.textContent = 'Start Linux engine';
            }
          }
        });
      if ($('#prepareimage'))
        $('#prepareimage').onclick = action(async () => {
          await api('/docker/prepare', {});
          nextInfrastructureCheck = 0;
          await infrastructure(true);
        });
      if ($('#cancelimage'))
        $('#cancelimage').onclick = action(async () => {
          await api('/docker/cancel', {});
          nextInfrastructureCheck = 0;
          await infrastructure(true);
        });
    } catch (e) {
      if (target.isConnected)
        target.innerHTML = `<p class="error" role="alert">${esc(e.message)}</p><button id="refreshinfrastructure">Retry check</button>`;
      if ($('#refreshinfrastructure'))
        $('#refreshinfrastructure').onclick = action(() => infrastructure(true));
    } finally {
      infrastructurePending = false;
    }
  }
  function render(panel) {
    panel.querySelectorAll('.computer-advanced').forEach((el) => {
      el.hidden = !ctx.state().settings.showAdvanced;
    });
    const botId = ctx.botId(),
      c = ctx.overview().computer,
      key = JSON.stringify([
        botId,
        c.generation,
        c.state,
        c.controller,
        c.error,
        c.idlePauseSeconds,
        c.idleStopSeconds,
      ]);
    const controlling = c.controller === 'human' && c.state === 'ready';
    let stage = document.querySelector('#computerstage');
    if (!controlling) stage?.remove();
    else {
      if (!stage) {
        stage = document.createElement('div');
        stage.id = 'computerstage';
        stage.className = 'computer-stage';
        stage.innerHTML = `<div class="computer-stage-screen" id="viewer"></div><div class="computer-stage-bar"><span class="computer-stage-status">${icon('computer', 15)} You're in control</span><button type="button" id="stagedone">I'm done</button></div>`;
        $('#app').append(stage);
      }
      stage.querySelector('#stagedone').onclick = action(async () => {
        const button = stage.querySelector('#stagedone');
        button.disabled = true;
        try {
          await api(`/bots/${botId}/computer/handback`, {});
          await refresh();
        } finally {
          button.disabled = false;
        }
      });
    }
    if (panel.dataset.computer === key && panel.querySelector('#infrastructure')) {
      void infrastructure().catch(() => {});
      return;
    }
    panel.dataset.computer = key;
    panel.innerHTML = `<div class="sectionhead row spread"><h2>Computer</h2><span class="badge">${esc(c.state)}</span></div>${c.controller === 'human' ? '<p class="notice">You have control. Hand back to let the Bot continue.</p>' : ''}${c.error ? '<p class="error" role="alert">' + esc(c.error) + '</p>' : ''}${controlling ? '<p class="computer-screen-note">The desktop is open across Orbit.</p>' : `<div id="viewer">${c.state === 'ready' ? '' : '<p class="computer-screen-note">The desktop appears here after you start this computer.</p>'}</div>`}<div class="row wrap"><button id="startcomputer">Start / resume</button><button id="watchcomputer" ${c.state !== 'ready' ? 'disabled' : ''}>Open live viewer</button><button id="takeover" ${c.state !== 'ready' ? 'disabled' : ''}>Take control</button><button id="handback" ${c.controller !== 'human' ? 'disabled' : ''}>Hand back to Bot</button></div><details class="computer-settings"><summary>Computer settings</summary><div class="row wrap"><button id="pausecomputer" ${!c.containerId ? 'disabled' : ''}>Pause</button><button id="stopcomputer" ${!c.containerId ? 'disabled' : ''}>Stop</button><button id="computersnapshots">Snapshots</button><button id="computerpolicy">Idle policy</button><button id="computerreplace">Reset / update</button><button id="computergenerations">Retained computers</button></div><p class="tiny muted computer-advanced" ${ctx.state().settings.showAdvanced ? '' : 'hidden'}>Generation ${c.generation}. Pause after ${c.idlePauseSeconds ?? 300}s idle; stop after ${c.idleStopSeconds ?? 1800}s. Active tasks, viewers and human control keep it awake.</p><details class="computer-advanced" ${ctx.state().settings.showAdvanced ? '' : 'hidden'}><summary>Isolation and storage</summary><p class="muted">Each Bot has its own Linux Docker container and persistent home/browser/workspace volumes. Containers share Docker’s Linux VM; they are not full VMs. Human control blocks agent input, screenshots and workspace jobs until handback. Library and conversations stay on the host.</p></details></details><section id="infrastructure" class="card" style="margin-top:20px"><p class="muted">Checking the Linux engine…</p></section>`;
    const settings = panel.querySelector('.computer-settings');
    settings.open = expandedSettings.has(botId);
    settings.addEventListener('toggle', () => {
      if (settings.open) expandedSettings.add(botId);
      else expandedSettings.delete(botId);
    });
    nextInfrastructureCheck = 0;
    void infrastructure(true).catch(() => {});
    for (const [element, op] of [
      ['startcomputer', 'start'],
      ['takeover', 'takeover'],
      ['handback', 'handback'],
      ['pausecomputer', 'pause'],
      ['stopcomputer', 'stop'],
    ])
      $('#' + element).onclick = action(async () => {
        const button = $('#' + element);
        button.disabled = true;
        try {
          await api(`/bots/${botId}/computer/${op}`, {});
          await refresh();
        } finally {
          button.disabled = false;
        }
      });
    const showScreen = async () => {
      const t = await api(`/bots/${botId}/computer/ticket`, {});
      const viewer = document.querySelector('#computerstage #viewer') || panel.querySelector('#viewer');
      if (!viewer?.isConnected) return;
      viewer.innerHTML = `<iframe class="viewer" title="Live Linux desktop" src="/viewer.html?ticket=${encodeURIComponent(t.ticket)}&mode=${t.mode}"></iframe>`;
    };
    $('#watchcomputer').onclick = action(showScreen);
    if (c.state === 'ready') void showScreen().catch(() => {});
    $('#computerpolicy').onclick = () =>
      modal(
        'Computer idle policy',
        `${field('Pause after idle seconds', 'idlePauseSeconds', c.idlePauseSeconds ?? 300, 'number', 'min="30" required')}${field('Stop after idle seconds', 'idleStopSeconds', c.idleStopSeconds ?? 1800, 'number', 'min="30" max="604800" required')}<p class="muted">Pause freezes processes and keeps RAM allocated. Stop releases process memory and preserves the persistent volumes. The next authorized computer action starts/resumes it.</p>`,
        async (f) =>
          api(`/bots/${botId}/computer/policy`, {
            idlePauseSeconds: Number(f.get('idlePauseSeconds')),
            idleStopSeconds: Number(f.get('idleStopSeconds')),
          }),
      );
    $('#computergenerations').onclick = action(generations);
    $('#computerreplace').onclick = () =>
      modal(
        'Replace this Linux computer',
        `<p>Library files, conversations, routines and memory belong to the host and stay in place. The current computer generation is ${c.generation}.</p><label for="replace-kind">Computer change</label><select id="replace-kind" name="operation"><option value="reset">Fresh desktop and browser</option><option value="update">Update to the current locally built image</option><option value="remove">Permanently remove its persistent volumes</option></select><p class="tiny muted">A fresh desktop gets new empty home/browser/workspace volumes. An image update first takes a verified stopped filesystem snapshot, then restores it into new volumes with the installed image. Both retain the old generation for inspection. The new computer starts only when requested. Removal deletes the current home/browser/workspace volumes; saved snapshots and backups remain separate.</p><label class="check"><input type="checkbox" name="confirmRemove"> I understand that removal permanently deletes these computer volumes.</label>`,
        async (f) => {
          const operation = f.get('operation');
          if (operation === 'remove' && !f.has('confirmRemove'))
            throw Error('Confirm permanent volume removal to continue');
          return api(`/bots/${botId}/computer/${operation}`, {
            expectedGeneration: c.generation,
            ...(operation === 'remove' ? { confirmRemove: true } : {}),
          });
        },
        'Apply computer change',
      );
    $('#computersnapshots').onclick = action(snapshots);
  }
  async function generations() {
    panel.querySelectorAll('.computer-advanced').forEach((el) => {
      el.hidden = !ctx.state().settings.showAdvanced;
    });
    const botId = ctx.botId(),
      items = await api(`/bots/${botId}/computer/generations`);
    modal(
      'Retained computer generations',
      `<p>Reset, update and restore retain the previous Linux home/browser/workspace. Library, memory and sessions are separate host records.</p><div class="stack">${items.map((c) => `<article class="card"><h3>Generation ${c.generation}</h3><p class="tiny muted">${esc(c.retainedReason)}<br>${esc(c.state)}${c.error ? '<br>' + esc(c.error) : ''}</p>${!['removed', 'unbound_after_restore'].includes(c.state) ? `<button type="button" data-remove-generation="${c.id}">Permanently remove this generation</button>` : ''}</article>`).join('') || '<p class="muted">No retained computers.</p>'}</div>`,
    );
    document.querySelectorAll('[data-remove-generation]').forEach(
      (button) =>
        (button.onclick = () => {
          const c = items.find((c) => c.id === button.dataset.removeGeneration);
          ctx.close();
          modal(
            'Permanently remove this old computer',
            `<p>This removes generation <strong>${c.generation}</strong> and its retained Linux home, browser profile and workspace volumes. Saved snapshots and backups are retained separately. The current generation and host Library, sessions and memory stay in place.</p><p class="tiny muted">${esc(c.resourceName)}</p>`,
            async () => api(`/bots/${botId}/computer/generations/${c.id}/remove`, {}),
            'Delete generation and its volumes',
          );
        }),
    );
  }
  async function snapshots() {
    panel.querySelectorAll('.computer-advanced').forEach((el) => {
      el.hidden = !ctx.state().settings.showAdvanced;
    });
    const botId = ctx.botId(),
      items = await api(`/bots/${botId}/computer/snapshots`);
    modal(
      'Linux computer snapshots',
      `<p class="muted">A snapshot stops the computer, archives its home, browser profile and workspace, and records the immutable base image. It contains no RAM. Restoring does not renew expired external logins. Old generations remain retained for inspection.</p><button type="button" id="newsnapshot">Stop & take snapshot</button><div class="stack" style="margin-top:18px">${items.map((s) => `<article class="card"><h3>${new Date(s.createdAt).toLocaleString()}</h3><p class="tiny muted">${esc(s.state)} · generation ${s.generation} · ${s.bytes ?? 0} bytes<br>${esc(s.digest ?? 'Archive not verified')}</p>${s.state === 'ready' ? `<button type="button" class="small" data-restore="${s.id}">Restore to new generation</button>` : ''}</article>`).join('') || '<p class="muted">No snapshots yet.</p>'}</div>`,
    );
    $('#newsnapshot').onclick = action(async () => {
      $('#newsnapshot').disabled = true;
      await api(`/bots/${botId}/computer/snapshot`, {});
      ctx.close();
      await refresh();
      await snapshots();
    });
    document.querySelectorAll('[data-restore]').forEach(
      (b) =>
        (b.onclick = () => {
          const s = items.find((s) => s.id === b.dataset.restore);
          ctx.close();
          modal(
            'Restore this exact snapshot',
            `<p>Stop the current computer and restore snapshot <strong>${esc(s.id)}</strong> into new volumes and a new computer generation. Existing volumes are retained. The restored computer starts only when you request it.</p><p class="tiny muted">SHA-256 ${esc(s.digest)}</p>`,
            async () =>
              api(`/bots/${botId}/computer/restore`, {
                snapshotId: s.id,
                expectedGeneration: ctx.overview().computer.generation,
              }),
            'Restore snapshot',
          );
        }),
    );
  }
  return { render };
}
