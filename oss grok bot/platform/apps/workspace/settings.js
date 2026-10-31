import { copyText } from './clipboard.js';
import { icon } from './icons.js';

export const accentChoices = [
  ['bot', 'Bot color'],
  ['black', 'Black'],
];
export const languageChoices = [
  ['system', 'Follow System'],
  ['af', 'Afrikaans'],
  ['ar', 'العربية'],
  ['bn', 'বাংলা'],
  ['pt-BR', 'Português (Brasil)'],
  ['cs', 'Čeština'],
  ['da', 'Dansk'],
  ['nl', 'Nederlands'],
  ['en', 'English'],
  ['pt-PT', 'Português (Portugal)'],
  ['fi', 'Suomi'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['el', 'Ελληνικά'],
  ['ha', 'Hausa'],
  ['he', 'עברית'],
  ['hi', 'हिन्दी'],
  ['hu', 'Magyar'],
  ['id', 'Bahasa Indonesia'],
  ['it', 'Italiano'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['mr', 'मराठी'],
  ['nb', 'Norsk bokmål'],
  ['pl', 'Polski'],
  ['ru', 'Русский'],
  ['zh-Hans', '简体中文'],
  ['es', 'Español'],
  ['sw', 'Kiswahili'],
  ['sv', 'Svenska'],
  ['ta', 'தமிழ்'],
  ['te', 'తెలుగు'],
  ['th', 'ไทย'],
  ['zh-Hant', '繁體中文'],
  ['tr', 'Türkçe'],
  ['uk', 'Українська'],
  ['ur', 'اردو'],
  ['vi', 'Tiếng Việt'],
];

function choice(esc, label, name, value, options) {
  return `<div class="settings-row"><label for="f-${name}">${esc(label)}</label><select id="f-${name}" name="${name}">${options
    .map(
      ([id, text]) =>
        `<option value="${esc(id)}" ${value === id ? 'selected' : ''}>${esc(text)}</option>`,
    )
    .join('')}</select></div>`;
}

const sections = [
  ['general', 'General', 'settings'],
  ['computer', 'Computer', 'computer'],
  ['permissions', 'Permissions', 'shield'],
  ['vault', 'Vault', 'vault'],
  ['usage', 'Usage & Billing', 'chart'],
  ['updates', 'Updates', 'cloudDownload'],
];

// The form retains its inputs across section changes. Product APIs and existing
// feature owners continue to own settings, grants, vault values and lifecycle.
export function settingsContent({ state, esc, field, themeControl, modelSettingsCard }) {
  const card = (title, body) =>
    `<section class="settings-section"><h3>${title}</h3><div class="settings-card">${body}</div></section>`;
  const resolvedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [resolvedZone];
  const timezoneOptions = [
    ['auto', `Auto-detect (${resolvedZone})`],
    ...[
      ...new Set(
        [state.settings.timezone, resolvedZone, ...zones].filter((zone) => zone && zone !== 'auto'),
      ),
    ].map((zone) => [zone, zone]),
  ];
  const timezoneValue = state.settings.timezoneAuto ? 'auto' : (state.settings.timezone ?? 'auto');
  const general =
    card(
      'Account',
      `<div class="settings-account"><span class="account-initial">${esc(state.account?.name?.[0]?.toUpperCase() ?? 'O')}</span><strong>${esc(state.account?.name ?? 'Your workspace')}</strong><button type="button" id="settings-add-account" disabled>Add account</button><button type="button" id="logout">Sign out</button></div><p class="tiny muted">Another account cannot be added in this workspace.</p>`,
    ) +
    card(
      'Appearance',
      `${themeControl(state.settings.theme)}${choice(esc, 'Accent', 'accent', state.settings.accent ?? 'bot', accentChoices)}${choice(esc, 'Language', 'language', state.settings.language ?? 'system', languageChoices)}<p class="tiny muted">The language choice is saved. Orbit’s interface text stays in English.</p><div class="settings-row"><label for="settings-spellcheck">Check Spelling While Typing</label><input type="checkbox" role="switch" id="settings-spellcheck" name="spellcheck" ${state.settings.spellcheck !== false ? 'checked' : ''}></div>`,
    ) +
    card(
      'System',
      `${choice(esc, 'Microphone', 'microphone', state.settings.microphone ?? 'system', [['system', 'System Default']])}<div class="settings-row"><label for="settings-hardware">Use hardware acceleration</label><input type="checkbox" role="switch" id="settings-hardware" name="hardwareAcceleration" ${state.settings.hardwareAcceleration !== false ? 'checked' : ''}></div><p class="tiny muted">A change applies the next time the desktop app starts.</p>`,
    ) +
    card('Bot', choice(esc, 'Timezone', 'timezoneChoice', timezoneValue, timezoneOptions)) +
    card(
      'Import',
      `<p>Import Memory to Orbit</p><p class="tiny muted">Transfer preferences and context from another assistant.</p><button type="button" id="settings-import-memory">Start Import</button><input id="settings-import-file" type="file" hidden><p id="settings-import-status" class="tiny" role="status">No memory file is imported.</p>`,
    ) +
    card(
      'Security Key',
      `<div class="settings-row"><label for="settings-security-key">Use hardware security keys</label><input type="checkbox" role="switch" id="settings-security-key" disabled></div><p class="tiny muted">Orbit cannot ask a connected security key to approve an action yet. The switch stays off.</p>`,
    ) +
    card(
      'Advanced',
      `<div class="settings-row"><label for="settings-advanced">Show advanced controls</label><input type="checkbox" role="switch" id="settings-advanced" name="showAdvanced" ${state.settings.showAdvanced ? 'checked' : ''}></div><p class="tiny muted">Show connection and computer diagnostics. Status, failures and recovery remain visible.</p><div data-settings-advanced ${state.settings.showAdvanced ? '' : 'hidden'}><div class="stack">${state.models.map((m) => modelSettingsCard(m, true)).join('') || '<p class="muted">No model configured. No provider is connected.</p>'}<div class="row wrap"><button type="button" id="chatgptsignin">Sign in with ChatGPT</button><button type="button" id="addmodel">Configure a model</button></div>${field('Feedback page (HTTPS)', 'feedbackUrl', state.settings.feedbackUrl ?? '', 'url', 'placeholder="https://"')}<p class="tiny muted">Opens your chosen public feedback page. Workspace data is not uploaded automatically.</p></div><details data-settings-advanced ${state.settings.showAdvanced ? '' : 'hidden'}><summary>Data &amp; session</summary><p class="tiny muted">Product backups retain canonical sessions and library bytes. Live Linux volumes need a separate computer snapshot.</p><button type="button" id="backup">Create local backup</button><button type="button" class="danger" id="shutdownhost">Stop host</button></details>`,
    );
  const bodies = {
    general,
    computer:
      card(
        'Your computer',
        '<p>Bot work runs on the selected primary host. Each Bot has its own persistent Linux computer.</p><div class="settings-row"><label for="settings-route">Route traffic through this computer</label><input type="checkbox" role="switch" id="settings-route" disabled></div><p class="tiny muted">Orbit does not send Bot traffic through this Windows computer. A paired device receives selected HTTP connections only when that device’s routing grant is on.</p><h3>Manage devices</h3><div id="settings-devices"></div><div class="row wrap"><button type="button" data-settings-feature="devicesfeature">Manage devices</button><button type="button" id="settings-open-computer">Open Bot computer</button><button type="button" class="small" data-settings-copy="computer">Copy link to the Computer section</button></div>',
      ) +
      card(
        "Bot's computer",
        '<div class="row wrap"><button type="button" id="settings-update-computer">Update Bot\'s Computer</button><button type="button" id="settings-reset-computer">Reset Bot\'s Computer</button></div><p class="tiny muted">Update installs the current local image and keeps the saved files. Reset starts a fresh desktop and browser. Host history, library files, and routines stay. The running Testing image is not rebuilt from this screen.</p><div id="settings-engine-status"></div><button type="button" id="settings-refresh-computer">Refresh status</button>',
      ),
    permissions: card(
      'Action rules',
      '<div class="settings-row"><label for="settings-auto-review">Auto-Review</label><input type="checkbox" role="switch" id="settings-auto-review" disabled></div><p class="tiny muted">Orbit does not auto-review actions. A named operation still asks, allows, or denies through its rule.</p><h3>Always Ask</h3><button type="button" data-settings-feature="policiesfeature">Add Rule to Always Ask</button><h3>Allow without Asking</h3><button type="button" data-settings-feature="policiesfeature">Add Rule to Allow without Asking</button><div id="settings-rules-status"></div>',
    ),
    vault: card(
      'Private vault',
      '<p>Logins, contact information and payments stay in your private workspace. Secret values stay hidden here.</p><div class="row wrap"><button type="button" data-settings-feature="vaultfeature">New item</button><button type="button" class="small" data-settings-copy="vault">Copy link to the Vault section</button></div><div id="settings-vault-status"></div>',
    ),
    usage:
      card(
        'Usage',
        '<p>Local task and provider-reported token totals. These are not a provider invoice or remaining plan allowance.</p><div id="settings-usage-status"></div><button type="button" data-settings-feature="analyticsfeature">View usage details</button>',
      ) +
      card(
        'Usage limit resets',
        '<div class="row wrap"><button type="button" id="settings-usage-reset" disabled>Enable</button></div><p class="tiny muted">Orbit does not schedule a provider usage-limit reset.</p>',
      ) +
      card(
        'Manage Plan',
        (state.models
          .filter((m) => m.authMode === 'chatgpt')
          .map(
            (m) =>
              `<p>${esc(m.name)} <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage Plan</a></p>`,
          )
          .join('') ||
          '<p class="muted">No connected ChatGPT plan. Model configuration is in General.</p>') +
          '<button type="button" id="settings-manage-billing" disabled>Manage Billing</button><p class="tiny muted">Orbit does not open a billing account. A connected ChatGPT plan keeps its usage page on the provider.</p>',
      ),
    updates: card(
      'Orbit Updates',
      '<div id="settings-version-status"></div><div class="settings-row"><label for="settings-automatic-updates">Automatic Updates</label><input type="checkbox" role="switch" id="settings-automatic-updates" disabled></div><p class="tiny muted">An automatic desktop update service is not configured.</p><div class="row wrap"><button type="button" id="settings-copy-version">Copy version</button><button type="button" id="settings-check-updates">Check for Updates</button><button type="button" class="small" data-settings-copy="updates">Copy link to the Updates section</button></div><p id="settings-update-result" class="tiny" role="status"></p><button type="button" data-settings-feature="operationsfeature">Backups &amp; application</button>',
    ),
  };
  return `<div class="settings-layout"><nav class="settings-navigation" role="tablist" aria-label="Settings sections" aria-orientation="vertical">${sections.map(([id, label, glyph]) => `<button type="button" id="settings-tab-${id}" role="tab" aria-selected="${id === 'general'}" aria-controls="settings-pane-${id}" tabindex="${id === 'general' ? 0 : -1}" data-settings-tab="${id}">${icon(glyph, 17)}${label}</button>`).join('')}</nav><div class="settings-content">${sections.map(([id, label]) => `<section id="settings-pane-${id}" role="tabpanel" aria-labelledby="settings-tab-${id}" ${id === 'general' ? '' : 'hidden'}><h2>${label}</h2>${bodies[id]}</section>`).join('')}</div></div>`;
}

export function bindSettingsSections({
  dialog,
  api,
  esc,
  action,
  close,
  toast,
  openComputer,
  replaceComputer,
  selectedBot,
  initialSection = 'general',
}) {
  const loaded = new Set();
  let copiedVersion = null;
  function currentTarget(selector) {
    const target = dialog.querySelector(selector);
    return target?.isConnected && dialog.open ? target : null;
  }
  async function status(id, targetSelector, load) {
    if (loaded.has(id)) return;
    loaded.add(id);
    const target = currentTarget(targetSelector);
    if (!target) return;
    target.setAttribute('aria-busy', 'true');
    if (id === 'computer') dialog.querySelector('#settings-refresh-computer').disabled = true;
    target.innerHTML = '<p class="muted" role="status">Loading&hellip;</p>';
    try {
      const html = await load();
      if (target.isConnected && dialog.open) target.innerHTML = html;
    } catch (error) {
      if (!target.isConnected || !dialog.open) return;
      target.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p><button type="button">Retry</button>`;
      target.querySelector('button').onclick = () => {
        loaded.delete(id);
        void status(id, targetSelector, load);
      };
    } finally {
      target.removeAttribute('aria-busy');
      if (id === 'computer' && target.isConnected && dialog.open)
        dialog.querySelector('#settings-refresh-computer').disabled = false;
    }
  }
  function select(id, focus = false) {
    if (!sections.some(([key]) => key === id)) throw Error('Unknown settings section');
    for (const [key] of sections) {
      const button = dialog.querySelector(`#settings-tab-${key}`);
      button.setAttribute('aria-selected', String(key === id));
      button.tabIndex = key === id ? 0 : -1;
      dialog.querySelector(`#settings-pane-${key}`).hidden = key !== id;
    }
    if (focus) dialog.querySelector(`#settings-tab-${id}`).focus();
    dialog.querySelector('.settings-content').scrollTop = 0;
    if (id === 'computer')
      void status(id, '#settings-engine-status', async () => {
        const [v, devices] = await Promise.all([api('/docker'), api('/devices')]);
        const deviceTarget = currentTarget('#settings-devices');
        if (deviceTarget)
          deviceTarget.innerHTML = devices.length
            ? devices
                .map(
                  (device) =>
                    `<p>${esc(device.name)} <span class="tiny muted">${esc(device.os ?? device.state)}</span></p>`,
                )
                .join('')
            : '<p class="muted">No paired devices.</p>';
        return `<p class="settings-status">${v.available ? 'Linux engine available' : esc(v.reason ?? 'Linux engine unavailable')}${v.available ? (v.imageReady ? ' · Linux image available' : ' · Linux image needs preparation') : ''}</p><p class="tiny muted">Checked ${Number.isFinite(v.observedAt) ? esc(new Date(v.observedAt).toLocaleTimeString()) : 'at an unknown time'}</p>`;
      });
    if (id === 'permissions')
      void status(id, '#settings-rules-status', async () => {
        const connections = await api('/connections');
        const rules = connections.flatMap((connection) =>
          (connection.rules ?? []).map((rule) => ({ ...rule, account: connection.accountLabel })),
        );
        const group = (behavior, empty) => {
          const matched = rules.filter((rule) => rule.behavior === behavior);
          if (!matched.length) return empty ? `<p class="muted">${empty}</p>` : '';
          return matched
            .map(
              (rule) =>
                `<p>${esc(rule.description)} <span class="tiny muted">${esc(rule.operation)} · ${esc(rule.account || 'account')}</span></p>`,
            )
            .join('');
        };
        return `<h3>Deny</h3>${group('deny', 'No deny rules.')}<h3>Saved ask and allow counts</h3><p class="tiny muted">${rules.filter((rule) => rule.behavior === 'ask').length} ask · ${rules.filter((rule) => rule.behavior === 'allow').length} allow · ${rules.filter((rule) => rule.behavior === 'deny').length} deny</p>${group('ask', '')}${group('allow', '')}`;
      });
    if (id === 'vault')
      void status(id, '#settings-vault-status', async () => {
        const items = await api('/vault');
        const filters = [
          ['all', 'All', items.length],
          ['login', 'Logins', items.filter((item) => item.kind === 'login').length],
          ['card', 'Payments', items.filter((item) => item.kind === 'card').length],
          ['contact', 'Contact info', items.filter((item) => item.kind === 'contact').length],
        ];
        return `<div class="row wrap" role="tablist">${filters
          .map(
            ([kind, label, count]) =>
              `<button type="button" data-vault-filter="${kind}">${label} ${count}</button>`,
          )
          .join('')}</div>${
          items
            .map(
              (item) =>
                `<p data-vault-kind="${esc(item.kind)}">${esc(item.label)} <span class="tiny muted">${esc(item.kind)}${item.origin ? ` · ${esc(item.origin)}` : ''}${item.last4 ? ` · ${esc(item.last4)}` : ''}</span></p>`,
            )
            .join('') || '<p class="muted">No vault items.</p>'
        }`;
      });
    if (id === 'usage')
      void status(id, '#settings-usage-status', async () => {
        const v = await api('/analytics?days=30');
        return `<dl class="settings-totals"><div><dt>Accepted tasks · 30 days</dt><dd>${esc(v.runs)}</dd></div><div><dt>Reported tokens</dt><dd>${esc(v.reportedTokens)}</dd></div></dl>`;
      });
    if (id === 'updates')
      void status(id, '#settings-version-status', async () => {
        const native = window.workshopDesktop ? await window.workshopDesktop.info() : null;
        const health = await api('/health');
        copiedVersion = native?.version ?? health.version;
        return `<p>Version <strong>${esc(copiedVersion)}</strong></p><p class="muted">${native ? 'Desktop application' : 'Web workspace'} · Host ${esc(health.version)}</p>`;
      });
  }
  for (const button of dialog.querySelectorAll('[data-settings-tab]'))
    button.onclick = () => select(button.dataset.settingsTab);
  dialog.querySelector('.settings-navigation').onkeydown = (event) => {
    const index = sections.findIndex(([id]) => id === event.target.dataset.settingsTab);
    if (index < 0 || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? sections.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + sections.length) % sections.length;
    select(sections[next][0], true);
  };
  dialog.querySelector('#modalform').addEventListener('invalid', () => select('general'), true);
  for (const button of dialog.querySelectorAll('[data-settings-feature]'))
    button.onclick = () => {
      const target = document.getElementById(button.dataset.settingsFeature);
      close();
      target?.click();
    };
  dialog.querySelector('#settings-open-computer').disabled = !selectedBot;
  dialog.querySelector('#settings-refresh-computer').onclick = () => {
    loaded.delete('computer');
    select('computer');
  };
  dialog.querySelector('#settings-open-computer').onclick = () => {
    close();
    openComputer();
  };
  dialog.querySelector('#settings-copy-version').onclick = action(async () => {
    if (!copiedVersion) throw Error('Version is still loading.');
    await copyText(copiedVersion);
    toast('Version copied');
  });
  dialog.querySelector('#settings-check-updates').onclick = () => {
    dialog.querySelector('#settings-update-result').textContent =
      'No update service is configured. This desktop build stays at the version above until you install a local update.';
  };
  dialog.querySelector('#settings-vault-status').onclick = (event) => {
    const filter = event.target.closest('[data-vault-filter]')?.dataset.vaultFilter;
    if (!filter) return;
    for (const row of dialog.querySelectorAll('[data-vault-kind]'))
      row.hidden = filter !== 'all' && row.dataset.vaultKind !== filter;
  };
  for (const button of dialog.querySelectorAll('[data-settings-copy]'))
    button.onclick = action(async () => {
      const url = new URL(location.href);
      url.hash = `settings=${button.dataset.settingsCopy}`;
      await copyText(url.toString());
      toast('Section link copied');
    });
  for (const [id, operation] of [
    ['settings-update-computer', 'update'],
    ['settings-reset-computer', 'reset'],
  ])
    dialog.querySelector(`#${id}`).onclick = action(() => replaceComputer(operation));
  const importFile = dialog.querySelector('#settings-import-file');
  dialog.querySelector('#settings-import-memory').onclick = () => importFile.click();
  importFile.onchange = () => {
    const status = dialog.querySelector('#settings-import-status');
    status.textContent = importFile.files?.length
      ? 'This file was not imported. Orbit cannot apply another assistant’s memory yet.'
      : 'No memory file is imported.';
    importFile.value = '';
  };
  select(initialSection);
}
