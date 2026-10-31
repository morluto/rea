import { copyText } from './clipboard.js';
import { workspaceUI, newBotPurpose } from './workspace.js';
import { accountScreen } from './onboarding.js';
import { transcript } from './transcript.js';
import { icon } from './icons.js';
import { mascot, mascotShapes } from './mascots.js';
import { artifactPreview } from './artifacts.js';
import { featureUI } from './features.js';
import { pluginsUI } from './plugins.js';
import { modelSignInUI } from './model-signin.js';
import { applyTheme, themeControl } from './appearance.js';
import { HistoryView } from './history-view.js';
import { ComposerDrafts, composerKey } from './composer-drafts.js';
import { libraryUI } from './library.js';
import { settingsContent, bindSettingsSections } from './settings.js';
import { accountMenuUI } from './account-menu.js';
const $ = (s) => document.querySelector(s),
  app = $('#app'),
  dialog = $('#dialog');
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const date = (v) => (v ? new Date(v).toLocaleString() : 'Unknown');
const terminal = (s) => ['settled', 'cancelled', 'failed', 'interrupted'].includes(s);
let state = { bots: [], models: [], settings: {} },
  overview = {},
  botId = null,
  explicitHome = false,
  tab = 'details',
  detailsOpen = false,
  conversationId = null,
  source,
  polling = false,
  showHidden = false,
  cursor = 0,
  showForgottenMemories = false;
const bot = () => state.bots.find((b) => b.id === botId);
let features, design, pluginManager, modelSignIn, accountMenu;
let refreshPending = null,
  refreshRequested = false,
  rebuildRequested = false,
  eventRefreshTimer,
  authGeneration = 0,
  authenticated = false;
const liveRuns = new Map();
const historyView = new HistoryView();
const drafts = new ComposerDrafts();
const composerOwners = new WeakMap();
const detailViews = new Map();
const pendingRoutines = new Set();
const library = libraryUI({
  esc,
  action,
  api,
  refresh,
  modal,
  upload: (artifact, selectedBot) => uploadDialog(artifact, selectedBot),
  search: () => $('#librarysearchfeature')?.click(),
  preview: (revisionId, selectedOverview, selectedBot) =>
    artifactPreview(revisionId, {
      api,
      esc,
      modal,
      overview: selectedOverview,
      botId: selectedBot,
    }),
});
const detailKey = () => JSON.stringify([state.account?.id, botId]);
const selectedComposer = () => ({ accountId: state.account?.id, botId, conversationId });
const isSelectedComposer = (owner) => composerKey(owner) === composerKey(selectedComposer());
function scheduleRefresh() {
  if (!authenticated || eventRefreshTimer) return;
  eventRefreshTimer = setTimeout(() => {
    eventRefreshTimer = null;
    if (!dialog.open) void refresh().catch(() => {});
  }, 80);
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch('/api' + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const v = await r.json();
  if (!r.ok) throw Error(v.error?.message ?? 'Request failed');
  return v;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').style.display = 'block';
  setTimeout(() => ($('#toast').style.display = 'none'), 5000);
}
function action(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      toast(e.message);
    }
  };
}
function close() {
  dialog.close();
  dialog.innerHTML = '';
}
function modal(title, html, submit, label = 'Save', options = {}) {
  dialog.oncancel = null;
  dialog.onkeydown = null;
  dialog.removeAttribute('aria-label');
  dialog.className = options.className ?? '';
  const actions =
    options.actions === false
      ? ''
      : `<div class="dialogactions"><button type="button" id="cancelmodal">Cancel</button>${submit ? `<button class="primary" type="submit">${esc(label)}</button>` : ''}</div>`;
  dialog.innerHTML = `<form id="modalform"><div class="dialoghead"><h2>${esc(title)}</h2><button type="button" id="closemodal" aria-label="Close">×</button></div>${html}<div class="error" id="formerror"></div>${actions}</form>`;
  $('#closemodal').onclick = close;
  if ($('#cancelmodal')) $('#cancelmodal').onclick = close;
  $('#modalform').onsubmit = async (e) => {
    e.preventDefault();
    if (!submit) return;
    const button = e.submitter;
    if (button) button.disabled = true;
    try {
      const afterSave = await submit(new FormData(e.target));
      await refresh();
      close();
      if (typeof afterSave === 'function') await afterSave();
    } catch (e) {
      $('#formerror').textContent = e.message;
    } finally {
      if (button) button.disabled = false;
    }
  };
  dialog.showModal();
}
const field = (label, name, value = '', type = 'text', extra = '') =>
  `<label for="f-${name}">${esc(label)}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}>`;
const area = (label, name, value = '') =>
  `<label for="f-${name}">${esc(label)}</label><textarea id="f-${name}" name="${name}" required>${esc(value)}</textarea>`;
features = featureUI({
  $,
  api,
  esc,
  modal,
  field,
  area,
  action,
  toast,
  close,
  refresh,
  state: () => state,
  overview: () => overview,
  botId: () => botId,
  history: () => historyView.entries,
  conversationId: () => conversationId,
});
pluginManager = pluginsUI({
  $,
  api,
  esc,
  modal,
  field,
  area,
  action,
  close,
  toast,
  refresh,
  state: () => state,
  features: () => features,
  botId: () => botId,
});
modelSignIn = modelSignInUI({
  $,
  api,
  esc,
  modal,
  field,
  action,
  close,
  refresh,
  settings: settingsDialog,
});
accountMenu = accountMenuUI({
  app,
  esc,
  modal,
  action,
  api,
  settings: settingsDialog,
  signOut,
  toast,
  state: () => state,
});
design = workspaceUI({
  $,
  app,
  esc,
  modal,
  action,
  close,
  state: () => state,
  botId: () => botId,
  tab: () => tab,
  detailsOpen: () => detailsOpen,
  showHidden: () => showHidden,
  toggleHidden: () => (showHidden = !showHidden),
  newBot: () => botDialog(),
  settings: settingsDialog,
  accountMenu: () => accountMenu.open(),
  chooseModel: () => chooseBotModel(),
  extensions: () => extensionsDialog(),
  botSettings: (b) => botDialog(b),
  botMenu: (b, event) => botMenu(b, event),
  shareBot: (anchor) => shareBot(anchor),
  changeTab: (t) => {
    tab = t;
    detailViews.set(detailKey(), t);
    detailsOpen = true;
    renderHeader();
    renderPanel();
  },
  toggleDetails: () => {
    detailsOpen = !detailsOpen;
    renderHeader();
    renderPanel();
  },
  closeDetails: () => {
    detailsOpen = false;
    renderHeader();
    renderPanel();
    $('#botdetails')?.focus();
  },
  chooseBot: action(async (key) => {
    saveDraft();
    explicitHome = key == null;
    botId = key;
    tab = detailViews.get(detailKey()) ?? 'details';
    conversationId = null;
    historyView.reset();
    overview = {};
    document.body.classList.remove('nav-open');
    await refresh(true);
  }),
});
function authScreen(status) {
  return accountScreen(status, { $, app, esc, field, api, init });
}
function shell() {
  design.shell();
  renderPanel();
  features.global();
}
function sidebar() {
  design.sidebar();
}
function saveDraft() {
  const input = $('#composer');
  const owner = input && composerOwners.get(input);
  if (owner) {
    drafts.text(owner, input.value);
    const send = $('#taskform [type=submit]');
    if (send) send.hidden = !input.value.trim();
  }
}
function renderHeader() {
  design.header();
}
function refresh(rebuild = false) {
  if (!authenticated) return Promise.resolve();
  if (rebuild) saveDraft();
  refreshRequested = true;
  rebuildRequested ||= rebuild;
  if (!refreshPending)
    refreshPending = (async () => {
      while (refreshRequested) {
        refreshRequested = false;
        const nextRebuild = rebuildRequested;
        rebuildRequested = false;
        await loadRefresh(nextRebuild);
      }
    })().finally(() => {
      refreshPending = null;
    });
  return refreshPending;
}
async function loadRefresh(rebuild) {
  const generation = authGeneration,
    selectedBot = botId,
    selectedConversation = conversationId;
  const nextState = await api('/state');
  if (generation !== authGeneration || !authenticated) return;
  let nextBot =
    selectedBot && nextState.bots.some((b) => b.id === selectedBot && !b.retired)
      ? selectedBot
      : null;
  if (!nextBot && !explicitHome)
    nextBot =
      [...nextState.bots]
        .filter((b) => !b.retired && !b.hidden)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]?.id ?? null;
  let nextOverview = {},
    nextHistoryPage = null,
    nextConversation = null;
  if (nextBot) {
    const [o, w] = await Promise.all([
      api(`/bots/${nextBot}/overview`),
      api(`/bots/${nextBot}/workflow`),
    ]);
    if (generation !== authGeneration || !authenticated) return;
    nextOverview = { ...o, ...w };
    nextConversation =
      selectedConversation ??
      (drafts.pending.has(
        composerKey({ accountId: nextState.account.id, botId: nextBot, conversationId: null }),
      )
        ? null
        : (nextOverview.conversations[0]?.id ?? null));
    if (nextConversation) {
      nextHistoryPage = await api(
        `/bots/${nextBot}/conversations/${nextConversation}/history?limit=200&direction=backward`,
      );
    }
  }
  if (generation !== authGeneration || !authenticated) return;
  if (selectedBot !== botId || selectedConversation !== conversationId) {
    refreshRequested = true;
    rebuildRequested = true;
    return;
  }
  rebuild ||= nextBot !== selectedBot;
  if (nextHistoryPage) {
    const result = historyView.refresh(`${nextBot}:${nextConversation}`, nextHistoryPage);
    if (!result.ok) throw Error(result.error.message);
  } else historyView.reset();
  state = nextState;
  botId = nextBot;
  overview = nextOverview;
  conversationId = nextConversation;
  applyTheme(state.settings);
  const retained = new Set();
  for (const r of overview.runs ?? []) {
    const live = liveRuns.get(r.id);
    if (live && !terminal(r.state) && live.revision > r.revision) {
      Object.assign(r, live);
      retained.add(r.id);
    }
  }
  for (const key of liveRuns.keys()) if (!retained.has(key)) liveRuns.delete(key);
  if (!$('#workspace')) shell();
  else {
    sidebar();
    renderHeader();
    renderPanel();
    features.global();
  }
}
function renderPanel() {
  const pane = $('#workspace');
  const details = $('#botpanels');
  if (details.dataset.bot !== (botId ?? '')) {
    details.dataset.bot = botId ?? '';
    for (const panel of details.querySelectorAll('.detail-view > .content')) {
      panel.replaceChildren();
      delete panel.dataset.computer;
    }
  }
  if (!bot()) {
    design.home(pane);
    return;
  }
  if (!$('#composer') || !isSelectedComposer(composerOwners.get($('#composer')))) renderChat(pane);
  else renderTranscript();
  $('#composer').placeholder =
    bot().purpose === newBotPurpose
      ? 'What should I help you with?'
      : 'Type your answer, or talk about something…';
  $('#composer').spellcheck = state.settings.spellcheck !== false;
  details.hidden = !detailsOpen;
  document.querySelector('.main').classList.toggle('details-open', detailsOpen);
  for (const view of details.querySelectorAll('[data-detail-view]')) {
    view.hidden =
      view.dataset.detailView !== (['library', 'computer'].includes(tab) ? tab : 'details');
  }
  if (detailsOpen) renderBotPanel();
}

function renderDetails(panel) {
  const selectedBot = botId;
  const routines = overview.routines ?? [],
    coding = overview.codingTasks ?? [];
  panel.innerHTML = `${routines.length ? `<h3 class="details-section-title">Routines</h3><div class="routine-list">${routines.map((r) => `<div class="routine-row" data-routine="${r.id}"><div><span>${esc(r.name)}</span><small>${r.enabled ? 'Next ' + esc(date(r.nextAt)) : 'Paused'}</small></div><button class="routine-switch" type="button" role="switch" aria-checked="${r.enabled}" aria-label="${r.enabled ? 'Pause' : 'Resume'} ${esc(r.name)}" data-toggle-routine="${r.id}" ${bot().accessRole !== 'owner' ? 'disabled' : ''}><span></span></button></div>`).join('')}</div>` : '<p class="details-empty">Routines are recurring tasks this Bot runs on a schedule. Ask it in chat to set one up.</p>'}${coding.length ? `<h3 class="details-section-title">Coding</h3><div class="stack">${coding.map((task) => `<button class="coding-summary" type="button" data-open-coding="${task.id}"><strong>${esc(task.title)}</strong><small>${esc(task.state)}</small></button>`).join('')}</div>` : ''}`;
  panel.querySelectorAll('[data-toggle-routine]').forEach((button) => {
    const r = routines.find((item) => item.id === button.dataset.toggleRoutine);
    button.disabled ||= pendingRoutines.has(r.id);
    button.onclick = action(async () => {
      if (pendingRoutines.has(r.id)) return;
      pendingRoutines.add(r.id);
      button.disabled = true;
      try {
        await api(`/bots/${selectedBot}/routines/${r.id}`, {
          name: r.name,
          task: r.task,
          cron: r.cron,
          timezone: r.timezone,
          enabled: !r.enabled,
          revision: r.revision,
        });
        await refresh();
      } finally {
        pendingRoutines.delete(r.id);
        if (selectedBot === botId && detailsOpen && tab === 'details')
          renderDetails($('#details-panel'));
      }
    });
  });
  panel.querySelectorAll('[data-routine]').forEach(
    (row) =>
      (row.oncontextmenu = (event) => {
        event.preventDefault();
        const routine = routines.find((r) => r.id === row.dataset.routine);
        // The existing editor preserves the host's exact stored definition and revision.
        routineDialog(routine);
      }),
  );
  panel
    .querySelectorAll('[data-open-coding]')
    .forEach((button) => (button.onclick = () => $('#codingfeature')?.click()));
}
function renderChat(pane) {
  const owner = selectedComposer();
  const draft = drafts.read(owner);
  pane.innerHTML = `<div class="chatlayout" style="--bot-color:${esc(bot().color)}"><details class="conversation-picker"><summary aria-label="Conversation options">${icon('chevron', 14)}</summary><div class="chattoolbar"><select id="conversation" aria-label="Conversation">${overview.conversations?.map((c) => `<option value="${c.id}" ${c.id === conversationId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><button class="quiet small" id="newconversation">+ New conversation</button></div></details><div class="chat-pins" id="chatpins" hidden></div><div class="transcript" id="transcript" role="log" aria-label="Conversation history" aria-live="off"></div><div class="composerbox"><form class="composer" id="taskform"><details class="composer-actions"><summary aria-label="Composer actions">${icon('plus', 20)}</summary><div class="composer-action-menu"><button type="button" id="attachartifact">${icon('paperclip', 16)} Attach files</button><button type="button" id="teachtask">${icon('spark', 16)} Teach a task</button></div></details><div class="composer-input"><textarea id="composer" rows="1" aria-label="Message" placeholder="Type your answer, or talk about something…">${esc(draft.text)}</textarea><div id="attachmentchips"></div></div><button type="button" class="iconbutton" id="voiceinput" aria-label="Voice input" title="Voice input">${icon('mic', 18)}</button><button type="button" class="iconbutton" id="voicechat" aria-label="Voice conversation" title="Voice conversation">${icon('waveform', 18)}</button><button type="button" class="iconbutton danger" id="stoprun" aria-label="Stop" title="Stop" hidden>&#9632;</button><button type="submit" class="iconbutton primary send-button" aria-label="Send &#8593;" title="Send" ${draft.text.trim() ? '' : 'hidden'}>${icon('send', 18)}</button></form><div class="statusline" id="chatstatus" aria-live="polite"></div></div></div>`;
  const input = $('#composer');
  composerOwners.set(input, owner);
  const sendButton = $('#taskform [type=submit]');
  sendButton.disabled = drafts.pending.has(composerKey(owner));
  $('#newconversation').onclick = action(async () => {
    saveDraft();
    const button = $('#newconversation'),
      input = $('#composer');
    button.disabled = true;
    input.disabled = true;
    try {
      const c = await api(`/bots/${owner.botId}/conversations`, {
        name: `Conversation ${(overview.conversations?.length ?? 0) + 1}`,
      });
      if (isSelectedComposer(owner)) {
        conversationId = c.id;
        await refresh(true);
      }
    } finally {
      button.disabled = false;
      input.disabled = false;
    }
  });
  $('#conversation').onchange = action(async (e) => {
    saveDraft();
    const input = $('#composer');
    input.disabled = true;
    try {
      conversationId = e.target.value;
      await refresh(true);
    } finally {
      input.disabled = false;
    }
  });
  $('#taskform').onsubmit = async (e) => {
    e.preventDefault();
    if (!isSelectedComposer(owner) || drafts.pending.has(composerKey(owner))) return;
    saveDraft();
    const record = drafts.read(owner),
      text = record.text.trim();
    if (!text) return;
    if (bot().purpose === newBotPurpose) {
      try {
        const latest = bot();
        await api(
          `/bots/${latest.id}`,
          {
            ...botBody(latest),
            purpose: text.slice(0, 2000),
            role: text.slice(0, 32000),
            revision: latest.revision,
          },
          'PATCH',
        );
        await refresh(true);
      } catch (e) {
        toast(e.message);
        return;
      }
    }
    if (!bot().modelId) {
      toast('Choose a model for this Bot. Your draft is kept.');
      chooseBotModel();
      return;
    }
    let destination = owner;
    drafts.pending.add(composerKey(destination));
    sendButton.disabled = true;
    try {
      if (!destination.conversationId) {
        const c = await api(`/bots/${owner.botId}/conversations`, { name: 'Conversation 1' });
        if (state.account?.id !== owner.accountId)
          throw Error('The account changed. Sign in again before sending.');
        destination = { ...owner, conversationId: c.id };
        drafts.move(owner, destination);
        if (isSelectedComposer(owner)) {
          conversationId = c.id;
          overview.conversations = [c, ...(overview.conversations ?? [])];
          renderPanel();
        }
      }
      if (state.account?.id !== owner.accountId)
        throw Error('The account changed. Your draft was kept.');
      await api(`/bots/${owner.botId}/tasks`, {
        text,
        conversationId: destination.conversationId,
        nonce: crypto.randomUUID(),
        artifactRevisionIds: record.revisionIds,
      });
      drafts.accepted(destination, record);
      if (isSelectedComposer(destination)) {
        const current = $('#composer');
        if (current && composerKey(composerOwners.get(current)) === composerKey(destination)) {
          current.value = drafts.read(destination).text;
          saveDraft();
          renderAttachmentChips();
        }
      }
    } catch (e) {
      toast(e.message);
    } finally {
      drafts.pending.delete(composerKey(destination));
      if (sendButton.isConnected) sendButton.disabled = false;
      if (isSelectedComposer(destination)) {
        const currentSend = $('#taskform [type=submit]');
        if (currentSend) currentSend.disabled = false;
      }
      await refresh().catch((e) => toast(e.message));
    }
  };
  $('#composer').oninput = saveDraft;
  $('#composer').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.form.requestSubmit();
    }
  };
  $('#attachartifact').onclick = () => attachDialog();
  $('#teachtask').onclick = () => $('#learningfeature')?.click();
  $('#voiceinput').onclick = () => $('#voicefeature')?.click();
  $('#voicechat').onclick = () => $('#voicefeature')?.click();
  renderAttachmentChips();
  renderTranscript();
}
function renderBotPanel() {
  const panel = $(
    tab === 'computer'
      ? '#computer-panel'
      : tab === 'library'
        ? '#library-panel'
        : '#details-panel',
  );
  if (tab === 'details') {
    renderDetails(panel);
    return;
  }
  if (features.panel(tab, panel)) return;
  if (tab === 'general') {
    const b = bot();
    const model = (state.models ?? []).find((m) => m.id === b.modelId);
    const modelLine = model
      ? `${esc(model.name)} · ${esc(model.model)} (${esc(model.connection)})`
      : esc(b.modelId ?? 'not configured');
    panel.innerHTML = `<div class="sectionhead row spread"><div><h2>General</h2><span class="muted">Identity, model, capabilities and lifecycle. Revisions are preserved.</span></div><button id="editgeneral">Edit Bot settings</button></div><div class="stack"><article class="card"><div class="row spread"><h3>${esc(b.name)}</h3><span class="badge">r${b.revision} · ${esc(b.activity?.label ?? 'Idle')}</span></div><p class="muted">${esc(b.purpose)}</p><p class="pre">${esc(b.role ?? '')}</p><p class="tiny muted">Model: ${modelLine}<br>Capabilities: ${esc((b.capabilities ?? []).join(', ') || 'none')}<br>Turns ${b.maxTurns} · deadline ${b.maxDurationSeconds}s · token budget ${b.tokenBudget}<br>ID ${esc(b.id)}</p><div class="actions"><button class="small" id="copygeneralid">Copy ID</button><button class="small" id="exportgeneral">Export template</button></div></article><article class="card"><h3>Management</h3><p class="tiny muted">Knowledge review lives under the Knowledge tab. Workspace-wide usage lives under Analytics in the sidebar; per-Bot usage lives under the Analytics tab.</p></article></div>`;
    $('#editgeneral').onclick = () => botDialog(b);
    $('#copygeneralid').onclick = action(async () => {
      await copyText(b.id);
      toast('Bot ID copied');
    });
    $('#exportgeneral').onclick = action(async () => {
      await downloadBotTemplate(b);
      toast('Template downloaded');
    });
    return;
  }
  if (tab === 'analytics') {
    const runs = overview.runs ?? [];
    const settled = runs.filter((r) => r.state === 'settled').length;
    const failed = runs.filter((r) => r.state === 'failed').length;
    const cancelled = runs.filter((r) => r.state === 'cancelled').length;
    const active = runs.filter((r) =>
      [
        'preparing',
        'running',
        'waiting_child',
        'cancelling',
        'waiting_approval',
        'waiting_input',
        'queued',
      ].includes(r.state),
    ).length;
    const withUsage = runs.filter((r) => r.usage).length;
    const tokens = runs.reduce((sum, r) => sum + (r.usage?.totalTokens ?? 0), 0);
    const estimatedCost = runs.reduce((sum, r) => sum + (r.cost?.usd ?? 0), 0);
    const costRuns = runs.filter((r) => r.cost?.basis === 'user_rates').length;
    const recent = runs.slice(-5).reverse();
    panel.innerHTML = `<div class="sectionhead row spread"><div><h2>Analytics</h2><span class="muted">Per-Bot outcomes from recorded receipts. Provider token counts only; cost estimates use your optional model rates.</span></div><button id="openworkspaceanalytics">Workspace analytics</button></div><div class="stack"><article class="card"><h3>This Bot</h3><p class="tiny muted">Runs ${runs.length} · settled ${settled} · failed ${failed} · cancelled ${cancelled} · active ${active}<br>Reported tokens ${tokens.toLocaleString()} across ${withUsage} runs with usage<br>Estimated cost $${estimatedCost.toFixed(2)} across ${costRuns} runs with your rates (host estimate, not an invoice)<br>Routines ${(overview.routines ?? []).length} · memories ${(overview.memories ?? []).length}${(overview.memories ?? []).some((m) => m.state === 'forgotten') ? ` (incl. ${(overview.memories ?? []).filter((m) => m.state === 'forgotten').length} forgotten)` : ''} · library ${(overview.artifacts ?? []).length} · knowledge ${(overview.knowledge ?? []).length}</p></article>${recent.length ? `<article class="card"><h3>Recent runs</h3>${recent.map((r) => `<p class="tiny muted">${esc((r.id ?? '').slice(0, 8))} · ${esc(r.state)}${r.usage ? ` · ${Number(r.usage.totalTokens ?? 0).toLocaleString()} tokens` : ''}</p>`).join('')}</article>` : ''}</div>`;
    $('#openworkspaceanalytics').onclick = () => features.analytics();
    return;
  }
  if (tab === 'memory') {
    const showForgotten = showForgottenMemories;
    const visible = overview.memories.filter((m) => showForgotten || m.state !== 'forgotten');
    const forgottenCount = overview.memories.filter((m) => m.state === 'forgotten').length;
    panel.innerHTML = `<div class="sectionhead row spread"><div><h2>Memory</h2><span class="muted">Facts and preferences, with a source and a scope.</span></div><div class="row"><button id="togglememoryforgotten" class="quiet small">${showForgotten ? 'Hide forgotten' : `Show forgotten (${forgottenCount})`}</button><button id="addmemory">＋ Add memory</button></div></div><div class="cards">${
      visible
        .map(
          (m) =>
            `<article class="card"><div class="row spread"><h3>${esc(m.subject)}</h3><span class="badge">${esc(m.scope)} · r${m.revision}</span></div><p class="pre">${esc(m.content)}</p><div class="tiny muted">${esc(m.certainty)} · ${esc(m.state)}<br>Source: ${esc(m.source)}</div><div class="actions"><button class="small" data-memory="${m.id}">Edit</button></div></article>`,
        )
        .join('') ||
      '<div class="listempty">No memories yet. Saved facts stay scoped to this Bot.</div>'
    }</div>`;
    $('#addmemory').onclick = () => memoryDialog();
    $('#togglememoryforgotten').onclick = () => {
      showForgottenMemories = !showForgottenMemories;
      renderPanel();
    };
    document
      .querySelectorAll('[data-memory]')
      .forEach(
        (el) =>
          (el.onclick = () =>
            memoryDialog(overview.memories.find((m) => m.id === el.dataset.memory))),
      );
  }
  if (tab === 'routines') {
    panel.innerHTML = `<div class="sectionhead row spread"><div><h2>Routines</h2><span class="muted">Durable schedules. The host must remain running.</span></div><button id="addroutine">＋ New routine</button></div><div class="notice">Timezone-aware cron · skip overlapping runs · after downtime, run one missed occurrence and advance. External scheduled sends are not available.</div><div class="cards">${
      overview.routines
        .map(
          (r) =>
            `<article class="card"><div class="row spread"><h3>${esc(r.name)}</h3><span class="badge">${esc(r.state)}</span></div><p>${esc(r.task)}</p><p class="tiny muted"><code>${esc(r.cron)}</code> · ${esc(r.timezone)}<br>Next: ${r.enabled ? date(r.nextAt) : 'Paused'}</p><div class="actions"><button class="small" data-runroutine="${r.id}">Run now</button><button class="small" data-pause="${r.id}">${r.enabled ? 'Pause' : 'Resume'}</button><button class="small" data-editroutine="${r.id}">Edit</button></div><details><summary>Occurrence history</summary>${
              overview.occurrences
                .filter((o) => o.routineId === r.id)
                .slice(-15)
                .map(
                  (o) =>
                    `<p class="tiny">${date(o.scheduledFor)} · ${esc(o.state)} · ${esc(o.runId ?? 'no run')}</p>`,
                )
                .join('') || '<p class="tiny muted">No scheduled occurrences yet.</p>'
            }</details></article>`,
        )
        .join('') ||
      '<div class="listempty">No routines yet. Create a schedule or ask your Bot.</div>'
    }</div>`;
    $('#addroutine').onclick = () => routineDialog();
    document
      .querySelectorAll('[data-editroutine]')
      .forEach(
        (el) =>
          (el.onclick = () =>
            routineDialog(overview.routines.find((r) => r.id === el.dataset.editroutine))),
      );
    document.querySelectorAll('[data-runroutine]').forEach(
      (el) =>
        (el.onclick = action(async () => {
          await api(`/bots/${botId}/routines/${el.dataset.runroutine}/run`, {});
          toast('Routine request accepted');
          await refresh();
        })),
    );
    document.querySelectorAll('[data-pause]').forEach(
      (el) =>
        (el.onclick = action(async () => {
          const r = overview.routines.find((r) => r.id === el.dataset.pause);
          await api(`/bots/${botId}/routines/${r.id}`, {
            name: r.name,
            task: r.task,
            cron: r.cron,
            timezone: r.timezone,
            enabled: !r.enabled,
            revision: r.revision,
          });
          await refresh();
        })),
    );
  }
  if (tab === 'library') library.render(panel, overview, botId);
  if (tab === 'activity') {
    panel.innerHTML = `<div class="sectionhead"><h2>Activity & receipts</h2><span class="muted">Host acceptance, run outcomes and provider-reported token usage.</span></div><div class="stack">${
      overview.runs
        .slice()
        .reverse()
        .map(
          (r) =>
            `<article class="card"><div class="row spread"><h3>${esc(r.text.slice(0, 90))}</h3><span class="badge">${esc(r.state)}</span></div><p class="tiny muted">${date(r.acceptedAt)} · ${esc(r.mode)}<br>${esc(r.id)}${r.usage ? `<br>Reported tokens: ${esc(r.usage.totalTokens ?? 'unknown')} · ${r.elapsedMs} ms · ${r.cost?.basis === 'user_rates' ? `est. $${r.cost.usd} (your rates)` : 'cost unknown'}` : ''}</p>${r.reason ? `<p class="error">${esc(r.reason)}</p>` : ''}<div class="actions"><button class="small" data-receipts="${r.id}">Inspect receipts</button>${terminal(r.state) ? `<button class="small" data-retry="${r.id}">Run again</button>` : `<button class="small danger" data-cancel="${r.id}">Cancel task</button>`}</div></article>`,
        )
        .join('') || '<div class="listempty">Accepted tasks will appear here.</div>'
    }</div>`;
    document.querySelectorAll('[data-cancel]').forEach(
      (el) =>
        (el.onclick = action(async () => {
          await api(`/bots/${botId}/runs/${el.dataset.cancel}/cancel`, {});
          await refresh();
        })),
    );
    document.querySelectorAll('[data-retry]').forEach(
      (el) =>
        (el.onclick = action(async () => {
          const prior = overview.runs.find((r) => r.id === el.dataset.retry);
          await api(`/bots/${botId}/tasks`, {
            text: prior?.text ?? '',
            nonce: crypto.randomUUID(),
            conversationId: prior?.conversationId ?? conversationId,
          });
          toast('Task accepted. Results will appear in the conversation.');
          await refresh();
        })),
    );
    document.querySelectorAll('[data-receipts]').forEach(
      (el) =>
        (el.onclick = action(async () => {
          const v = await api(`/bots/${botId}/runs/${el.dataset.receipts}/events`);
          const empty = Array.isArray(v) && v.length === 0;
          modal(
            'Recorded receipts',
            empty
              ? '<p class="muted">No receipts were recorded for this run.</p>'
              : `<pre class="pre">${esc(JSON.stringify(v, null, 2))}</pre>`,
          );
        })),
    );
  }
}
function renderTranscript() {
  return transcript({
    $,
    esc,
    api,
    action,
    refresh,
    features,
    design,
    modal,
    bot: bot(),
    overview,
    history: historyView.entries,
    conversationId,
    historyCursor: historyView.cursor,
    historyStartIndex: historyView.startIndex,
    historyNotice: historyView.notice,
    loadEarlier: action(async () => {
      const selectedBot = botId,
        selectedConversation = conversationId,
        cursor = historyView.cursor;
      if (!cursor || !selectedBot || !selectedConversation) return;
      const page = await api(
        `/bots/${selectedBot}/conversations/${selectedConversation}/history?cursor=${encodeURIComponent(cursor)}&limit=200&direction=backward`,
      );
      if (selectedBot !== botId || selectedConversation !== conversationId) return;
      const result = historyView.earlier(`${selectedBot}:${selectedConversation}`, cursor, page);
      if (!result.ok) {
        if (result.error.tag === 'history_selection_changed') return;
        throw Error(result.error.message);
      }
      renderTranscript();
    }),
  });
}
async function downloadBotTemplate(current) {
  const template = await api(`/bots/${current.id}/template`);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(
    new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' }),
  );
  link.download = 'bot-template.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1500);
}
function shareBot(anchor) {
  document.getElementById('botmenu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'botmenu';
  menu.className = 'bot-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML =
    '<button type="button" role="menuitem" title="Downloads this Bot’s template on this computer. Orbit does not publish a template link.">Create a copy</button>';
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  menu.style.left = `${Math.max(margin, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - margin))}px`;
  const remove = () => {
    menu.remove();
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onPointer = (pointerEvent) => {
    if (!menu.isConnected || menu.contains(pointerEvent.target)) return;
    remove();
  };
  const onKey = (keyEvent) => {
    if (keyEvent.key !== 'Escape') return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    remove();
  };
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  menu.onclick = () => {
    remove();
    void action(async () => {
      await downloadBotTemplate(bot());
      toast('Template downloaded');
    })();
  };
}
function botBody(bot, name = bot.name) {
  return {
    name,
    purpose: bot.purpose,
    role: bot.role,
    color: bot.color,
    shape: bot.shape ?? null,
    modelId: bot.modelId ?? null,
    capabilities: bot.capabilities ?? ['memory', 'library', 'routines'],
    maxTurns: bot.maxTurns ?? 20,
    maxDurationSeconds: bot.maxDurationSeconds ?? 1800,
    tokenBudget: bot.tokenBudget ?? 200000,
    tokenQuota: bot.tokenQuota ?? null,
  };
}
function botMenu(bot, event) {
  document.getElementById('botmenu')?.remove();
  const owner = bot.accessRole === 'owner';
  const item = (actionName, label, enabled, title = '', danger = false) =>
    `<button type="button" role="menuitem" data-bot-action="${actionName}" ${enabled ? '' : 'disabled'} ${title ? `title="${esc(title)}"` : ''} ${danger ? 'class="danger"' : ''}>${esc(label)}</button>`;
  const menu = document.createElement('div');
  menu.id = 'botmenu';
  menu.className = 'bot-menu';
  menu.setAttribute('role', 'menu');
  const unread = item(
    'unread',
    'Mark as Unread',
    false,
    'Orbit does not keep an unread mark on a Bot.',
  );
  const rows = bot.pinned
    ? [
        item('pin', 'Unpin', owner),
        unread,
        item('copy', 'Copy conversation ID', true),
        item('hide', bot.hidden ? 'Show in sidebar' : 'Hide from sidebar', owner),
        item(
          'replace',
          'Replace with different Bot',
          false,
          'Orbit cannot swap a pinned Bot for another one.',
        ),
      ]
    : [
        item('pin', 'Pin', owner),
        item('section', 'Move to new section', false, 'Orbit has no Bot sections.'),
        unread,
        item('rename', 'Rename Bot', owner),
        item('copy', 'Copy conversation ID', true),
        item('hide', bot.hidden ? 'Show in sidebar' : 'Hide from sidebar', owner),
        item(
          'retire',
          'Retire Bot',
          owner,
          'Permanent deletion is not available. Retire stops new tasks and keeps history.',
          true,
        ),
      ];
  menu.innerHTML = [...rows, item('settings', 'Bot settings', true)].join('');
  document.body.appendChild(menu);
  const margin = 8;
  menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - margin))}px`;
  const remove = () => {
    menu.remove();
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onPointer = (pointerEvent) => {
    if (!menu.isConnected || menu.contains(pointerEvent.target)) return;
    remove();
  };
  const onKey = (keyEvent) => {
    if (keyEvent.key !== 'Escape') return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    remove();
  };
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  menu.onclick = (clickEvent) => {
    const button = clickEvent.target.closest('[data-bot-action]');
    if (!button || button.disabled) return;
    const current = state.bots.find((item) => item.id === bot.id) ?? bot;
    const act = button.dataset.botAction;
    remove();
    if (act === 'pin')
      return void action(async () => {
        await api(`/bots/${current.id}/navigation`, {
          pinned: !current.pinned,
          hidden: current.hidden,
        });
        await refresh();
      })();
    if (act === 'hide')
      return void action(async () => {
        await api(`/bots/${current.id}/navigation`, {
          pinned: current.pinned,
          hidden: !current.hidden,
        });
        await refresh();
      })();
    if (act === 'rename')
      return modal(
        'Rename Bot',
        field('Name', 'name', current.name, 'text', 'required maxlength="120"'),
        async (form) => {
          const latest = state.bots.find((item) => item.id === current.id) ?? current;
          await api(
            `/bots/${latest.id}`,
            { ...botBody(latest, form.get('name')), revision: latest.revision },
            'PATCH',
          );
          await refresh(true);
        },
        'Rename',
      );
    if (act === 'copy')
      return void action(async () => {
        let id = current.id === botId ? conversationId : null;
        if (!id) {
          const view = await api(`/bots/${current.id}/overview`);
          id = view.conversations?.[0]?.id ?? null;
        }
        if (!id) throw Error('This Bot has no conversation yet.');
        await copyText(id);
        toast('Conversation ID copied');
      })();
    if (act === 'retire')
      return modal(
        'Retire Bot',
        `<p>Retire <strong>${esc(current.name)}</strong>? New tasks and routines stop. History, library files and its Linux computer stay. Permanent deletion is not available.</p>`,
        async () => {
          await api(`/bots/${current.id}/retire`, {});
          if (botId === current.id) botId = null;
          await refresh(true);
        },
        'Retire Bot',
      );
    if (act === 'settings') botDialog(current);
  };
}
function chooseBotModel() {
  if (state.models.length) {
    botDialog(bot());
    $('#f-model').focus();
  } else settingsDialog();
}
const createColors = [
  ['#f4f4f5', 'White'],
  ['#18181b', 'Black'],
  ['#71717a', 'Gray'],
  ['#9a3412', 'Brown'],
  ['#dc2626', 'Red'],
  ['#f97316', 'Orange'],
  ['#d97706', 'Amber'],
  ['#eab308', 'Yellow'],
  ['#84cc16', 'Lime'],
  ['#16a34a', 'Green'],
  ['#0f766e', 'Teal'],
  ['#0891b2', 'Cyan'],
  ['#2563eb', 'Blue'],
  ['#1e3a8a', 'Navy'],
  ['#4f46e5', 'Indigo'],
  ['#7c3aed', 'Purple'],
  ['#c026d3', 'Magenta'],
  ['#db2777', 'Pink'],
];
function createBotDialog() {
  const initial = { name: 'Your Bot', color: '#2563eb', shape: 'hex' };
  modal(
    'Create New Bot',
    `<div class="create-bot-preview" id="botpreview">${mascot(initial, 'large', true)}</div><input id="f-name" name="name" type="text" required maxlength="120" placeholder="Name your Bot" aria-label="Name" autocomplete="off"><div class="create-bot-shapes" role="listbox" aria-label="Avatar shape">${mascotShapes.map(([id, label]) => `<button type="button" class="create-bot-shape${id === initial.shape ? ' selected' : ''}" data-shape="${id}" role="option" aria-selected="${id === initial.shape}" aria-label="${esc(label)}">${mascot({ name: label, color: initial.color, shape: id }, 'small', true)}</button>`).join('')}</div><div class="create-bot-colors" role="listbox" aria-label="Avatar color">${createColors.map(([color, label]) => `<button type="button" class="create-bot-color${color === initial.color ? ' selected' : ''}" data-color="${color}" role="option" aria-selected="${color === initial.color}" aria-label="${esc(label)}" style="--swatch:${color}"></button>`).join('')}</div><input type="hidden" name="color" id="f-color" value="${initial.color}"><input type="hidden" name="shape" id="f-shape" value="${initial.shape}">`,
    async (f) => {
      const name = String(f.get('name') ?? '').trim();
      const b = await api('/bots', {
        name,
        purpose: newBotPurpose,
        role: 'Help with what the owner describes.',
        color: f.get('color') || initial.color,
        shape: f.get('shape') || initial.shape,
        modelId: null,
        capabilities: ['memory', 'library', 'routines'],
        maxTurns: 20,
        maxDurationSeconds: 1800,
        tokenBudget: 200000,
        tokenQuota: null,
      });
      saveDraft();
      botId = b.id;
      conversationId = null;
      tab = 'details';
      historyView.reset();
      await refresh(true);
      return () => $('#composer')?.focus();
    },
    'Create',
    { className: 'create-bot-dialog' },
  );
  const name = $('#f-name');
  const submit = $('#modalform button[type="submit"]');
  const syncSubmit = () => {
    submit.disabled = !name.value.trim();
  };
  syncSubmit();
  name.addEventListener('input', syncSubmit);
  const paint = () => {
    const color = $('#f-color').value;
    const shape = $('#f-shape').value;
    $('#botpreview').innerHTML = mascot(
      { name: name.value.trim() || 'Your Bot', color, shape },
      'large',
      true,
    );
    for (const button of document.querySelectorAll('.create-bot-shape'))
      button.innerHTML = mascot(
        { name: button.getAttribute('aria-label'), color, shape: button.dataset.shape },
        'small',
        true,
      );
  };
  for (const button of document.querySelectorAll('.create-bot-shape'))
    button.onclick = () => {
      $('#f-shape').value = button.dataset.shape;
      for (const item of document.querySelectorAll('.create-bot-shape')) {
        const on = item === button;
        item.classList.toggle('selected', on);
        item.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      paint();
    };
  for (const button of document.querySelectorAll('.create-bot-color'))
    button.onclick = () => {
      $('#f-color').value = button.dataset.color;
      for (const item of document.querySelectorAll('.create-bot-color')) {
        const on = item === button;
        item.classList.toggle('selected', on);
        item.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      paint();
    };
  name.focus();
}
function botDialog(existing) {
  if (!existing) {
    createBotDialog();
    return;
  }
  modal(
    existing ? 'Bot settings' : 'Create a Bot',
    `<div class="bot-editor-intro" id="botpreview">${mascot(existing ?? { name: 'Your Bot', color: '#a9bca6' }, 'large', true)}<div><strong>A little direction goes a long way.</strong><p>Give your Bot a name and tell it how you like to work.</p></div></div>${field('Name', 'name', existing?.name ?? '', 'text', 'required maxlength="120"')}${field('Purpose', 'purpose', existing?.purpose ?? '', 'text', 'required')}${area('Role, responsibilities and boundaries', 'role', existing?.role ?? '')}${field('Avatar color', 'color', existing?.color ?? '#a9bca6', 'color')}<label for="f-shape">Avatar shape</label><select id="f-shape" name="shape"><option value="">Assigned from the Bot</option>${mascotShapes.map(([id, label]) => `<option value="${id}" ${existing?.shape === id ? 'selected' : ''}>${label}</option>`).join('')}</select><label for="f-model">Model configuration</label><select id="f-model" name="modelId"><option value="">Configure later</option>${state.models.map((m) => `<option value="${m.id}" ${m.id === existing?.modelId ? 'selected' : ''}>${esc(m.name)} · ${esc(m.model)} (${esc(m.connection)})</option>`).join('')}</select><details class="bot-advanced"><summary>Tools and task limits</summary><label>Granted capabilities</label><div class="checks">${['memory', 'library', 'routines', 'computer', 'delegation', 'extensions', 'knowledge', 'devices', 'coding'].map((c) => `<label><input name="capabilities" value="${c}" type="checkbox" ${(existing?.capabilities ?? ['memory', 'library', 'routines']).includes(c) ? 'checked' : ''}>${{ coding: 'T3 coding', extensions: 'Connected apps', delegation: 'Other Bots', knowledge: 'Knowledge', devices: 'Paired devices', memory: 'Memory', library: 'Library', routines: 'Routines', computer: 'Computer' }[c]}</label>`).join('')}</div><p class="tiny muted">Memory and library tools can write within this Bot. Routine creation and computer commands require action approval. Computer access needs a working Docker engine.</p>${field('Maximum model turns per task', 'maxTurns', existing?.maxTurns ?? 20, 'number', 'min="1" max="100" required')}${field('Task deadline (seconds)', 'maxDurationSeconds', existing?.maxDurationSeconds ?? 1800, 'number', 'min="10" max="86400" required')}${field('Reported token budget (may overshoot by one provider response)', 'tokenBudget', existing?.tokenBudget ?? 200000, 'number', 'min="100" max="10000000" required')}${field('Lifetime token quota, blank for none (run admission stops when reported usage reaches it)', 'tokenQuota', existing?.tokenQuota ?? '', 'number', 'min="1000"')}</details>${existing ? `<details><summary>Navigation & lifecycle</summary><div class="row wrap" style="margin-top:12px"><button type="button" id="pinbot">${existing.pinned ? 'Unpin' : 'Pin'}</button><button type="button" id="hidebot">${existing.hidden ? 'Unhide' : 'Hide'}</button><button type="button" id="copybot">Copy ID</button><button type="button" id="exportbot">Export template</button><button type="button" class="danger" id="retirebot">Retire Bot</button></div><p class="tiny muted">Retire stops admission and routines; preserves history, artifacts and the computer. Destructive deletion/reset is unavailable.</p></details>` : ''}`,
    async (f) => {
      const v = {
        name: f.get('name'),
        purpose: f.get('purpose'),
        role: f.get('role'),
        color: f.get('color'),
        shape: f.get('shape') || null,
        modelId: f.get('modelId') || null,
        capabilities: f.getAll('capabilities'),
        maxTurns: Number(f.get('maxTurns')),
        maxDurationSeconds: Number(f.get('maxDurationSeconds')),
        tokenBudget: Number(f.get('tokenBudget')),
        tokenQuota: f.get('tokenQuota') === '' ? null : Number(f.get('tokenQuota')),
      };
      const b = await api(
        existing ? `/bots/${existing.id}` : '/bots',
        existing ? { ...v, revision: existing.revision } : v,
        existing ? 'PATCH' : 'POST',
      );
      if (!existing) {
        saveDraft();
        botId = b.id;
        conversationId = null;
        tab = 'details';
        historyView.reset();
      }
      await refresh(true);
    },
    existing ? 'Publish revision' : 'Create Bot',
  );
  const updatePreview = () => {
    $('#botpreview').innerHTML =
      mascot(
        { name: $('#f-name').value || 'Your Bot', color: $('#f-color').value },
        'large',
        true,
      ) +
      '<div><strong>A little direction goes a long way.</strong><p>Give your Bot a name and tell it how you like to work.</p></div>';
  };
  $('#f-name').addEventListener('input', updatePreview);
  $('#f-color').addEventListener('input', updatePreview);
  if (existing) {
    $('#pinbot').onclick = action(async () => {
      await api(`/bots/${existing.id}/navigation`, {
        pinned: !existing.pinned,
        hidden: existing.hidden,
      });
      close();
      await refresh();
    });
    $('#hidebot').onclick = action(async () => {
      await api(`/bots/${existing.id}/navigation`, {
        pinned: existing.pinned,
        hidden: !existing.hidden,
      });
      close();
      await refresh();
    });
    $('#copybot').onclick = action(async () => {
      await copyText(existing.id);
      toast('Bot ID copied');
    });
    $('#exportbot').onclick = action(async () => {
      await downloadBotTemplate(existing);
      toast('Template downloaded');
    });
    $('#retirebot').onclick = action(async () => {
      await api(`/bots/${existing.id}/retire`, {});
      botId = null;
      close();
      await refresh(true);
    });
  }
}
function memoryDialog(m) {
  modal(
    m ? 'Edit memory' : 'Add memory',
    m
      ? `${area('Content', 'content', m.content)}<label>State</label><select name="state">${['active', 'archived', 'forgotten'].map((s) => `<option ${s === m.state ? 'selected' : ''}>${s}</option>`).join('')}</select><p class="tiny muted">Forget removes this memory and its prior revisions from retrieval. Existing conversation history, tool receipts and backups retain their own records.</p>`
      : `${field('Subject', 'subject', '', 'text', 'required')}${area('Fact or preference', 'content')}<label>Scope</label><select name="scope"><option value="bot">This Bot</option>${conversationId ? '<option value="conversation">Selected conversation only</option>' : ''}</select>${field('Source / provenance', 'source', 'User entry', 'text', 'required')}`,
    async (f) => {
      if (m)
        await api(
          `/bots/${botId}/memory/${m.id}`,
          { revision: m.revision, content: f.get('content'), state: f.get('state') },
          'PATCH',
        );
      else
        await api(`/bots/${botId}/memory`, {
          subject: f.get('subject'),
          content: f.get('content'),
          scope: f.get('scope'),
          source: f.get('source'),
          certainty: 'user_confirmed',
          ...(f.get('scope') === 'conversation' ? { conversationId } : {}),
        });
    },
  );
}
function routineDialog(r) {
  modal(
    r ? 'Edit routine' : 'New routine',
    `${field('Name', 'name', r?.name ?? '', 'text', 'required')}${area('Task', 'task', r?.task ?? '')}${field('Cron (minute hour day month weekday)', 'cron', r?.cron ?? '0 9 * * 1-5', 'text', 'required')}${field('IANA timezone', 'timezone', r?.timezone ?? state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, 'text', 'required')}<p class="tiny muted">Skip overlap; catch up one occurrence. The scheduler runs while the host is on, even when the browser is closed.</p>`,
    async (f) => {
      await api(`/bots/${botId}/routines${r ? '/' + r.id : ''}`, {
        ...Object.fromEntries(f),
        enabled: r?.enabled ?? true,
        ...(r ? { revision: r.revision } : {}),
      });
    },
  );
}
function uploadDialog(a, selectedBot = botId) {
  modal(
    a ? 'Publish a new revision' : 'Add a library file',
    `<label for="file">Choose a file (up to 6 MiB)</label><input id="file" type="file" required><p class="tiny muted">${a ? 'Old revision bytes are retained.' : 'Original bytes and filename are preserved.'}</p>`,
    async () => {
      const file = $('#file').files[0];
      if (file.size > 6 * 1024 * 1024) throw Error('File exceeds the 6 MiB upload limit');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await api(`/bots/${selectedBot}/artifacts`, {
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        content: btoa(binary),
        encoding: 'base64',
        ...(a ? { artifactId: a.id, expectedRevision: a.revision } : {}),
      });
    },
  );
}
function modelSettingsCard(m, showAdvanced) {
  const connection =
    m.authMode === 'chatgpt' ? `ChatGPT plan: ${esc(m.oauthState)}` : 'Custom connection';
  const rates =
    m.costInputPerM != null || m.costOutputPerM != null
      ? `<p class="tiny muted">Your rates: $${m.costInputPerM ?? '?'} / $${m.costOutputPerM ?? '?'} per 1M input/output tokens</p>`
      : '';
  return `<div class="card"><h3>${esc(m.name)}</h3><p class="tiny muted">${esc(m.model)} · ${connection}<br>Connection: ${esc(m.connection)}</p><div data-settings-advanced ${showAdvanced ? '' : 'hidden'}><p class="tiny muted">Protocol: ${esc(m.api)}<br>${esc(m.endpoint)}<br>Credential ${m.hasCredential ? 'stored' : 'not supplied'}</p></div>${rates}<button type="button" class="small" data-check="${m.id}">Test actual response</button>${m.authMode === 'chatgpt' ? `<button type="button" class="small" data-modelauth="${m.id}">${m.hasCredential ? 'Reconnect' : 'Sign in'}</button><button type="button" class="small" data-modeldisconnect="${m.id}">Disconnect</button><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage plan usage ↗</a>` : ''}</div>`;
}
function settingsDialog(initialSection = 'general') {
  modal(
    'Settings',
    settingsContent({ state, esc, field, themeControl, modelSettingsCard }),
    null,
    undefined,
    { className: 'settings-dialog', actions: false },
  );
  let settingsTicket = 0;
  let settingsChain = Promise.resolve();
  const settingsForm = dialog.querySelector('#modalform');
  const feedbackProblem = (value) => {
    if (!value) return '';
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password)
        return 'Enter a public https feedback page, or leave it empty.';
    } catch {
      return 'Enter a public https feedback page, or leave it empty.';
    }
    return '';
  };
  const queueSettingsSave = () => {
    const error = dialog.querySelector('#formerror');
    const feedback = String(new FormData(settingsForm).get('feedbackUrl') ?? '');
    const problem = feedbackProblem(feedback);
    if (problem) {
      error.textContent = problem;
      setTimeout(() => dialog.querySelector('[data-settings-tab="general"]')?.click(), 0);
      return;
    }
    error.textContent = '';
    const f = new FormData(settingsForm);
    const timezoneChoice = f.get('timezoneChoice');
    const timezoneAuto = timezoneChoice === 'auto';
    const hardwareAcceleration = f.has('hardwareAcceleration');
    const body = {
      theme: f.get('theme'),
      timezone: timezoneAuto ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezoneChoice,
      timezoneAuto,
      accent: f.get('accent'),
      language: f.get('language'),
      microphone: f.get('microphone'),
      hardwareAcceleration,
      showAdvanced: f.has('showAdvanced'),
      spellcheck: f.has('spellcheck'),
      feedbackUrl: feedback,
    };
    const ticket = ++settingsTicket;
    settingsChain = settingsChain
      .then(async () => {
        if (ticket !== settingsTicket) return;
        if (window.workshopDesktop?.setHardwareAcceleration)
          await window.workshopDesktop.setHardwareAcceleration(hardwareAcceleration);
        await api('/settings', body);
        await refresh();
      })
      .catch((error) => {
        if (dialog.open && ticket === settingsTicket)
          dialog.querySelector('#formerror').textContent = error.message;
      });
  };
  settingsForm.addEventListener('change', (event) => {
    if (event.target?.name) queueSettingsSave();
  });
  bindSettingsSections({
    dialog,
    api,
    esc,
    action,
    close,
    toast,
    selectedBot: botId,
    initialSection,
    openComputer: () => {
      tab = 'computer';
      detailsOpen = true;
      detailViews.set(detailKey(), tab);
      renderHeader();
      renderPanel();
    },
    replaceComputer: (operation) => {
      const computer = state.computers?.find((item) => item.botId === botId);
      if (!computer)
        throw Error(
          'This Bot has no Linux computer yet. Open the computer panel and prepare one first.',
        );
      close();
      modal(
        operation === 'reset' ? "Reset Bot's Computer" : "Update Bot's Computer",
        `<p>Library files, conversations, routines and memory stay on the host. The current computer generation is ${computer.generation}.</p><p class="tiny muted">${operation === 'reset' ? 'Reset starts a fresh desktop and browser. The old generation stays available for inspection.' : 'Update installs the current local image and keeps the saved files. The running Testing image is not rebuilt from here.'}</p>`,
        async () =>
          api(`/bots/${botId}/computer/${operation}`, { expectedGeneration: computer.generation }),
        operation === 'reset' ? 'Reset computer' : 'Update computer',
      );
    },
  });
  dialog.querySelector('[name="showAdvanced"]').onchange = (event) => {
    dialog.querySelectorAll('[data-settings-advanced]').forEach((el) => {
      el.hidden = !event.target.checked;
    });
  };
  $('#addmodel').onclick = () => {
    close();
    modelDialog();
  };
  $('#chatgptsignin').onclick = action(async () => {
    close();
    await modelSignIn.configure();
  });
  document
    .querySelectorAll('[data-modelauth]')
    .forEach((el) => (el.onclick = action(() => modelSignIn.reconnect(el.dataset.modelauth))));
  document
    .querySelectorAll('[data-modeldisconnect]')
    .forEach((el) => (el.onclick = () => modelSignIn.disconnect(el.dataset.modeldisconnect)));
  document.querySelectorAll('[data-check]').forEach(
    (el) =>
      (el.onclick = action(async () => {
        el.disabled = true;
        try {
          const r = await api(`/models/${el.dataset.check}/check`, {});
          toast(`Actual response received: ${r.text}`);
          await refresh();
          close();
          settingsDialog();
        } finally {
          el.disabled = false;
        }
      })),
  );
  $('#shutdownhost').onclick = () => {
    close();
    modal(
      'Stop the local host',
      '<p>Cancel loaded tasks and stop the API and scheduler. Queued tasks and data are retained. Docker computers remain running until stopped separately. Restart with scripts/start.ps1.</p>',
      async () => {
        await api('/shutdown', {});
        source?.close();
        app.innerHTML =
          '<div class="empty"><h1>Host stopped.</h1><p>Restart the local service to continue.</p></div>';
      },
      'Stop host',
    );
  };
  $('#backup').onclick = action(async () => {
    const r = await api('/backup', {});
    toast(`Backup created: ${r.path}`);
  });
  $('#logout').onclick = action(signOut);
}
async function signOut() {
  await api('/auth/logout', {});
  source?.close();
  close();
  await init();
}
function modelDialog() {
  modal(
    'Configure your model',
    `${field('Configuration name', 'name', '', 'text', 'required')}${field('Base URL (provider API root, usually ending /v1)', 'endpoint', '', 'url', 'required')}${field('Exact model ID', 'model', '', 'text', 'required')}<label>Protocol</label><select name="api"><option>openai-completions</option><option>openai-responses</option><option>anthropic-messages</option></select>${field('API key (private; optional for local endpoints)', 'apiKey', '', 'password', 'autocomplete="off"')}<p class="tiny muted">Key is encrypted in this workspace’s separate secret store. It is never added to the model prompt or returned by the configuration API. This personal deployment relies on your OS account to protect its local vault key.</p><div class="split">${field('Context window (tokens)', 'contextWindow', 128000, 'number', 'required min="1"')}${field('Maximum output tokens', 'maxTokens', 4096, 'number', 'required min="1"')}</div><div class="split">${field('Cost USD per 1M input tokens (optional)', 'costInputPerM', '', 'number', 'min="0" step="any"')}${field('Cost USD per 1M output tokens (optional)', 'costOutputPerM', '', 'number', 'min="0" step="any"')}</div><p class="tiny muted">Optional rates power host-computed cost estimates on runs and analytics. They are your own figures, not provider invoices.</p><div class="checks"><label><input type="checkbox" name="vision">Image input supported</label><label><input type="checkbox" name="reasoning">Reasoning model</label></div><p class="tiny muted">Saving does not verify a connection. Use Test actual response afterward. Provider-specific sampling and reasoning options are not yet exposed; no option is silently substituted.</p>`,
    async (f) => {
      await api('/models', {
        name: f.get('name'),
        endpoint: f.get('endpoint'),
        model: f.get('model'),
        api: f.get('api'),
        apiKey: f.get('apiKey'),
        contextWindow: Number(f.get('contextWindow')),
        maxTokens: Number(f.get('maxTokens')),
        ...(f.get('costInputPerM') !== '' ? { costInputPerM: Number(f.get('costInputPerM')) } : {}),
        ...(f.get('costOutputPerM') !== ''
          ? { costOutputPerM: Number(f.get('costOutputPerM')) }
          : {}),
        vision: f.has('vision'),
        reasoning: f.has('reasoning'),
      });
    },
    'Save configuration',
  );
}
function extensionsDialog() {
  void pluginManager.open().catch((e) => toast(e.message));
}

async function init() {
  const generation = ++authGeneration;
  authenticated = false;
  refreshRequested = rebuildRequested = false;
  clearTimeout(eventRefreshTimer);
  eventRefreshTimer = null;
  source?.close();
  const a = await api('/auth/status');
  if (generation !== authGeneration) return;
  if (!a.authenticated) {
    source?.close();
    features.stop();
    state = { bots: [], models: [], settings: {} };
    botId = conversationId = null;
    overview = {};
    historyView.reset();
    drafts.records.clear();
    drafts.pending.clear();
    detailViews.clear();
    pendingRoutines.clear();
    library.reset();
    accountMenu.reset();
    authScreen(a);
    return;
  }
  authenticated = true;
  await refresh(true);
  if (generation !== authGeneration || !authenticated) return;
  source?.close();
  source = new EventSource(`/api/events?cursor=${cursor}`);
  source.onopen = scheduleRefresh;
  source.onmessage = (e) => {
    if (generation !== authGeneration || !authenticated) return;
    cursor = Number(e.lastEventId);
    scheduleRefresh();
  };
  const requestedSection = new URLSearchParams(location.hash.slice(1)).get('settings');
  if (
    ['general', 'computer', 'permissions', 'vault', 'usage', 'updates'].includes(requestedSection)
  )
    settingsDialog(requestedSection);
  source.addEventListener('progress', (event) => {
    if (generation !== authGeneration || !authenticated) return;
    const p = JSON.parse(event.data);
    if (p.botId !== botId) return;
    const r = overview.runs?.find((r) => r.id === p.runId);
    if (!r || terminal(r.state)) return scheduleRefresh();
    if (p.revision <= r.revision) return;
    let partialText;
    if (p.snapshot !== undefined) partialText = p.snapshot;
    else if (p.partialEpoch === r.partialEpoch && p.offset === (r.partialText ?? '').length)
      partialText = r.partialText + p.delta;
    else if (p.delta === undefined && p.partialEpoch === r.partialEpoch)
      partialText = r.partialText;
    else return scheduleRefresh();
    Object.assign(r, {
      partialText,
      partialEpoch: p.partialEpoch,
      partialOpen: p.partialOpen,
      partialHasTools: p.partialHasTools,
      revision: p.revision,
      firstTextAt: p.firstTextAt ?? r.firstTextAt,
    });
    liveRuns.set(r.id, {
      partialText: r.partialText,
      partialEpoch: r.partialEpoch,
      partialOpen: r.partialOpen,
      partialHasTools: r.partialHasTools,
      revision: r.revision,
      firstTextAt: r.firstTextAt,
    });
    renderTranscript();
  });
  source.onerror = () => {
    if (generation !== authGeneration || !authenticated) return;
    const el = $('#chatstatus');
    if (el) el.textContent = 'Reconnecting to the host…';
  };
}
setInterval(async () => {
  if (polling || !$('#workspace') || dialog.open) return;
  polling = true;
  try {
    await refresh();
  } catch (e) {
    const el = $('#chatstatus');
    if (el) el.textContent = e.message;
  } finally {
    polling = false;
  }
}, 4000);
init().catch((e) => {
  app.innerHTML = `<div class="empty"><h1>Host unavailable</h1><p class="error">${esc(e.message)}</p><p class="muted">Start the local service, then reload this page.</p></div>`;
});

function renderAttachmentChips() {
  const el = $('#attachmentchips');
  if (!el) return;
  const owner = composerOwners.get($('#composer'));
  if (!owner) return;
  el.innerHTML = drafts
    .read(owner)
    .revisionIds.map((key) => {
      const r = overview.revisions.find((r) => r.id === key);
      return `<button type="button" class="small" data-removeattachment="${key}">${esc(r?.name ?? key)} ×</button>`;
    })
    .join('');
  document.querySelectorAll('[data-removeattachment]').forEach(
    (button) =>
      (button.onclick = () => {
        drafts.attachments(
          owner,
          drafts.read(owner).revisionIds.filter((key) => key !== button.dataset.removeattachment),
        );
        renderAttachmentChips();
      }),
  );
}
function attachDialog() {
  const owner = composerOwners.get($('#composer'));
  if (!owner || !isSelectedComposer(owner)) return;
  if (!owner.conversationId) {
    toast('Create a conversation first, then attach a library revision.');
    return;
  }
  modal(
    'Attach library revisions',
    `<p class="muted">Select exact text, JSON or PDF/Office document revisions. Document text is extracted with provenance when the task runs. Upload new files in Library first.</p><div class="stack">${
      overview.artifacts
        .map((a) => {
          const r = overview.revisions.find((r) => r.id === a.currentRevisionId);
          if (!r) return `<p class="muted">${esc(a.name)}: current revision unavailable.</p>`;
          const attachable = r.attachable === true;
          return `<label class="row"><input style="width:auto" type="checkbox" name="revisions" value="${r.id}" ${drafts.read(owner).revisionIds.includes(r.id) ? 'checked' : ''} ${attachable ? '' : 'disabled'}>${esc(a.name)} · SHA-256 ${esc(r.digest.slice(0, 12))}&hellip; · ${r.size} bytes · ${esc(r.mediaType)}</label>`;
        })
        .join('') || '<p class="muted">No files in this Bot’s library.</p>'
    }</div>`,
    async (f) => {
      drafts.attachments(owner, f.getAll('revisions'));
      if (isSelectedComposer(owner)) renderAttachmentChips();
    },
    'Attach selected',
  );
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
