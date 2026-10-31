import { mascot, wordmark, renderMascotContainer } from './mascots.js';
import { icon } from './icons.js';
export const newBotPurpose = 'Waiting to hear what you want.';
export function workspaceUI(ctx) {
  const { $, app, esc, modal } = ctx;
  let sideSignature = '',
    headerSignature = '';
  const homeSignatures = new WeakMap();
  const getState = ctx.state;
  function shell() {
    sideSignature = '';
    headerSignature = '';
    app.innerHTML = `<div class="layout" data-ui><button class="nav-scrim" id="navscrim" aria-label="Close navigation" tabindex="-1"></button><aside id="navigation" aria-label="Workspace navigation"><div class="sidebar-top"><a class="brand" href="/" id="brandhome" aria-label="Orbit home">${wordmark()}</a><button class="iconbutton" id="quickswitch" aria-label="Search" title="Search (Ctrl K)">${icon('search')}</button><button class="iconbutton" id="newbot" aria-label="New Bot" title="New Bot">${icon('plus')}</button></div><div class="sidebar-scroll"><div class="botlist" id="botlist"></div></div><div class="sidefoot"><button class="host-indicator" id="hostindicator" hidden></button><details class="tools-disclosure"><summary>Workspace tools</summary><div class="toolmenu"><button class="quiet" id="extensions">${icon('spark')}<span class="sidebarlabel">Plugins</span></button><button class="quiet" id="workspacehome">${icon('home')}<span>Your workspace</span></button></div></details><div class="account-row"><button class="account-button" id="settings" aria-label="Account menu" aria-haspopup="menu" aria-controls="account-menu" aria-expanded="false"><span class="account-initial">${esc(getState().account?.name?.[0]?.toUpperCase() ?? 'O')}</span><span class="account-meta"><strong>${esc(getState().account?.name ?? 'Your workspace')}</strong></span></button><button class="iconbutton" id="connectapps" aria-label="Connect apps" title="Connect apps">${icon('grid')}</button></div></div></aside><main class="main"><div class="chat-column"><header class="top" id="header"></header><section class="workspace" id="workspace"></section></div><aside class="bot-panels" id="botpanels" aria-label="Conversation details" hidden><div class="details-actions"><button class="iconbutton" id="sharebotcopy" aria-label="Share" title="Share">${icon('share')}</button><button class="iconbutton" id="morebotviews" aria-label="More Bot views" title="More Bot views">${icon('menu')}</button><button class="iconbutton" id="closedetails" aria-label="Close details" title="Close details">&#215;</button></div><div id="botprofile"></div><nav class="tabs" id="tabs" aria-label="Conversation details"></nav><section class="detail-view" id="details-view" role="tabpanel" aria-labelledby="detail-tab-details" data-detail-view="details"><div class="content" id="details-panel"></div></section><section class="detail-view" id="library-view" role="tabpanel" aria-labelledby="detail-tab-library" data-detail-view="library" hidden><div class="content" id="library-panel"></div></section><section class="detail-view" id="computer-view" role="tabpanel" aria-labelledby="detail-tab-computer" data-detail-view="computer" hidden><div class="content" id="computer-panel"></div></section></aside></main></div>`;
    if (window.workshopDesktop)
      void window.workshopDesktop
        .info()
        .then((info) => {
          document.documentElement.classList.toggle(
            'desktop-overlay',
            !!info.windowControlsOverlay,
          );
          const indicator = $('#hostindicator');
          if (!indicator) return;
          indicator.dataset.ready = 'true';
          indicator.hidden = !getState().settings.showAdvanced;
          indicator.textContent =
            info.mode === 'remote' ? 'Remote primary host' : 'This computer is primary';
          indicator.title = info.host ?? 'Orbit';
          indicator.onclick = () => $('#remotefeature')?.click();
        })
        .catch(() => {});
    $('#brandhome').onclick = (e) => {
      e.preventDefault();
      ctx.chooseBot(null);
    };
    $('#workspacehome').onclick = () => ctx.chooseBot(null);
    $('#newbot').onclick = () => ctx.newBot();
    $('#settings').onclick = () => ctx.accountMenu();
    $('#extensions').onclick = () => ctx.extensions();
    $('#connectapps').onclick = () => ctx.extensions();
    $('#closedetails').onclick = () => ctx.closeDetails();
    $('#morebotviews').onclick = moreBotViews;
    $('#sharebotcopy').onclick = (event) => ctx.shareBot(event.currentTarget);
    $('#quickswitch').onclick = quickSwitch;
    $('#navscrim').onclick = () => mobile(false);
    sidebar();
    header();
    syncMobile();
  }
  function sidebar() {
    if (!$('#botlist')) return;
    const state = getState();
    if ($('#hostindicator'))
      $('#hostindicator').hidden =
        !$('#hostindicator').dataset.ready || !state.settings.showAdvanced;
    const bots = state.bots.filter((b) => !b.retired);
    const pinned = bots.filter((b) => b.pinned && !b.hidden),
      regular = bots.filter((b) => !b.pinned && !b.hidden),
      hidden = bots.filter((b) => b.hidden);
    const signature = JSON.stringify([
      ctx.botId(),
      ctx.showHidden(),
      bots.map((b) => [
        b.id,
        b.name,
        b.purpose,
        b.preview,
        b.color,
        b.shape,
        b.pinned,
        b.activity,
        b.hidden,
      ]),
    ]);
    if (signature === sideSignature) return;
    sideSignature = signature;
    const button = (b, tile = false) => {
      const line =
        b.preview ||
        (b.activity?.state && b.activity.state !== 'idle' ? b.activity.label : b.purpose);
      return `<button class="bot ${tile ? 'pinned-bot' : ''} ${b.id === ctx.botId() ? 'selected' : ''}" data-bot="${b.id}" aria-label="Open ${esc(b.name)}" ${b.id === ctx.botId() ? 'aria-current="page"' : ''}>${mascot(b, tile ? 'large' : 'mini')}<span class="label"><strong>${esc(b.name)}</strong>${tile ? '' : `<small class="bot-state bot-state-${b.activity?.state ?? 'idle'}">${esc(line || '')}</small>`}</span></button>`;
    };
    renderMascotContainer(
      $('#botlist'),
      `${pinned.length ? `<div class="pinned-grid" role="group" aria-label="Pinned Bots">${pinned.map((b) => button(b, true)).join('')}</div>` : ''}<div class="regular-bots">${regular.map((b) => button(b)).join('')}</div>${hidden.length ? `<button class="hidden-bots-toggle" id="togglehidden" aria-expanded="${ctx.showHidden()}"><span>Hidden Bots</span><span>${ctx.showHidden() ? '&#8964;' : hidden.length}</span></button><div class="hidden-bots" ${ctx.showHidden() ? '' : 'hidden'}>${hidden.map((b) => button(b)).join('')}</div>` : ''}${!bots.length ? '<p class="sidebar-empty">No Bots yet.</p>' : ''}`,
    );
    $('#togglehidden')?.addEventListener('click', () => {
      ctx.toggleHidden();
      sidebar();
    });
    $('#botlist')
      .querySelectorAll('[data-bot]')
      .forEach((button) => {
        button.onclick = () => ctx.chooseBot(button.dataset.bot);
        button.oncontextmenu = (event) => {
          event.preventDefault();
          ctx.botMenu(
            bots.find((b) => b.id === button.dataset.bot),
            event,
          );
        };
      });
    $('#workspacehome')?.classList.toggle('selected', !ctx.botId());
  }
  function header() {
    const state = getState(),
      b = state.bots.find((b) => b.id === ctx.botId()),
      tab = ctx.tab();
    const signature = JSON.stringify([
      b?.id,
      b?.revision,
      b?.activity,
      tab,
      ctx.detailsOpen(),
      b ? null : state.summary?.notifications,
    ]);
    if (signature === headerSignature) return;
    headerSignature = signature;
    renderMascotContainer(
      $('#header'),
      `<button class="iconbutton mobile-menu" id="navtoggle" aria-label="Open navigation" aria-controls="navigation" aria-expanded="false">${icon('menu', 22)}</button>${b ? `<button class="conversation-title" id="botdetails" aria-label="View conversation details" aria-expanded="${ctx.detailsOpen()}">${mascot(b, 'mini')}<h1>${esc(b.name)}</h1></button>` : `<div class="home-heading"><h1>Your workspace</h1><button class="iconbutton" id="homenotifications" aria-label="Notifications">${icon('bell')}</button><button class="iconbutton" id="headernewbot" aria-label="New Bot">${icon('plus')}</button></div>`}`,
    );
    $('#navtoggle').onclick = () => mobile(true);
    $('#botdetails')?.addEventListener('click', () => ctx.toggleDetails());
    $('#headernewbot')?.addEventListener('click', () => ctx.newBot());
    $('#homenotifications')?.addEventListener('click', () => $('#notificationsfeature')?.click());
    const panels = $('#botpanels');
    panels.hidden = !b || !ctx.detailsOpen();
    document.querySelector('.main').classList.toggle('details-open', !!b && ctx.detailsOpen());
    if (b) {
      renderMascotContainer(
        $('#botprofile'),
        `<button class="profile-avatar" id="editbotavatar" aria-label="Edit Bot avatar">${mascot(b, 'large')}</button><button class="bot-profile-name" id="editbotname" aria-label="Edit Bot name">${esc(b.name)}</button>`,
      );
      $('#editbotavatar').onclick = $('#editbotname').onclick = () => ctx.botSettings(b);
    } else $('#botprofile').replaceChildren();
    const primary = ['library', 'computer'].includes(tab) ? tab : 'details';
    $('#tabs').innerHTML = b
      ? ['details', 'library', 'computer']
          .map(
            (t) =>
              `<button class="tab ${primary === t ? 'active' : ''}" id="detail-tab-${t}" role="tab" aria-selected="${primary === t}" aria-controls="${t}-view" tabindex="${primary === t ? 0 : -1}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`,
          )
          .join('')
      : '';
    $('#tabs')
      .querySelectorAll('[data-tab]')
      .forEach((button) => (button.onclick = () => ctx.changeTab(button.dataset.tab)));
    $('#tabs').setAttribute('role', 'tablist');
    $('#tabs').onkeydown = (event) => {
      const tabs = [...$('#tabs').querySelectorAll('[data-tab]')];
      const index = tabs.indexOf(event.target);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      const target = tabs[next].dataset.tab;
      ctx.changeTab(target);
      $(`#detail-tab-${target}`)?.focus();
    };
    syncMobile();
  }
  function moreBotViews() {
    modal(
      'Bot views',
      `<div class="stack">${[
        ['details', 'Details'],
        ['general', 'Bot settings & identity'],
        ['queue', 'Queue'],
        ['routines', 'Routines'],
        ['memory', 'Memory'],
        ['knowledge', 'Knowledge'],
        ['analytics', 'Analytics'],
        ['activity', 'Activity & receipts'],
      ]
        .map(([tab, label]) => `<button type="button" data-bot-view="${tab}">${label}</button>`)
        .join('')}</div>`,
    );
    document.querySelectorAll('[data-bot-view]').forEach(
      (button) =>
        (button.onclick = () => {
          ctx.close();
          ctx.changeTab(button.dataset.botView);
        }),
    );
  }
  function home(pane) {
    const state = getState();
    const signature = JSON.stringify([
      state.bots,
      state.models.map((m) => [m.id, m.connection]),
      state.summary,
      state.settings.theme,
    ]);
    if (homeSignatures.get(pane) === signature) return;
    homeSignatures.set(pane, signature);
    const bots = state.bots.filter((b) => !b.retired && !b.hidden),
      summary = state.summary ?? {},
      hasModel = state.models.length > 0;
    renderMascotContainer(
      pane,
      `<div class="workspace-home">${!hasModel ? '<div class="model-setup-row"><span>Connect a model to start chatting.</span><button class="text-action" id="setupmodel">Set up model</button></div>' : ''}${!bots.length ? `<section class="first-bot"><div class="first-bot-art" aria-hidden="true">${mascot({ id: 'first-bot', color: '#d97757' }, 'hero', true)}</div><div class="first-bot-copy"><h2>Create a Bot.</h2><p>Choose its role, model and tools.</p><button class="primary" id="firstbot">Create your first Bot</button></div></section>` : `<section class="home-bots"><div class="home-section-title"><h2>Your Bots</h2>${summary.waiting ? `<span>${summary.waiting} waiting for you</span>` : ''}</div><div class="bot-gallery">${bots.map((b) => `<button class="bot-portrait" data-home-bot="${b.id}"><span class="bot-portrait-stage">${mascot(b, 'large')}</span><span class="bot-portrait-info"><strong>${esc(b.name)}</strong><span>${esc(b.purpose)}</span><small class="bot-state bot-state-${b.activity.state}">${esc(b.activity.label)}</small></span></button>`).join('')}</div></section>`}${summary.nextRoutine ? `<div class="next-routine">${icon('clock', 16)}<span>${esc(summary.nextRoutine.name)}<small>${new Date(summary.nextRoutine.nextAt).toLocaleString()}</small></span></div>` : ''}</div>`, // taste-skill-ignore: user-mandated Claude brand asset, see release report
    );
    $('#firstbot')?.addEventListener('click', () => ctx.newBot());
    $('#setupmodel')?.addEventListener('click', () => ctx.settings());
    document
      .querySelectorAll('[data-home-bot]')
      .forEach((el) => (el.onclick = () => ctx.chooseBot(el.dataset.homeBot)));
  }
  function emptyChat(b) {
    const model = !b.modelId
      ? '<button type="button" class="text-action" id="chatsetupmodel">Choose a model</button>'
      : '';
    if (b.purpose === newBotPurpose)
      return `<div class="conversation-empty conversation-intro"><div class="conversation-mascot">${mascot({ ...b, activity: { state: 'idle', label: b.name } }, 'large', true)}</div><article class="message assistant"><div class="message-identity">${mascot({ ...b, activity: { state: 'idle', label: b.name } }, 'mini', true)}<span>${esc(b.name)}</span></div><div class="markdown-body"><p>What do you want me to do?</p></div></article>${model}</div>`;
    return `<div class="conversation-empty"><div class="conversation-mascot">${mascot(b, 'large')}</div><h2>What would you like to do?</h2>${model}</div>`;
  }
  function bindChat() {
    $('#chatsetupmodel')?.addEventListener('click', () => ctx.chooseModel());
  }

  function mobile(open) {
    document.body.classList.toggle('nav-open', open);
    syncMobile();
    if (open) $('#navigation').querySelector('button')?.focus();
    else $('#navtoggle')?.focus();
  }
  function syncMobile() {
    const small = matchMedia('(max-width:960px)').matches,
      open = document.body.classList.contains('nav-open');
    if ($('#navigation')) {
      $('#navigation').inert = small && !open;
      $('#navigation').setAttribute('aria-hidden', String(small && !open));
    }
    $('#navtoggle')?.setAttribute('aria-expanded', String(open));
    const panelOverlay =
      matchMedia('(max-width:640px)').matches && ctx.detailsOpen() && !!ctx.botId();
    if (document.querySelector('.chat-column'))
      document.querySelector('.chat-column').inert = panelOverlay;
    if (panelOverlay && document.activeElement?.closest('.chat-column'))
      $('#closedetails')?.focus();
  }
  function quickSwitch() {
    const s = getState();
    modal(
      'Search',
      `<label class="sr-only" for="switchquery">Search</label><div class="switch-input">${icon('search', 20)}<input id="switchquery" placeholder="Search" autocomplete="off"></div><div id="switchresults" class="switch-results"></div>`,
    );
    const bots = s.bots
      .filter((b) => !b.retired)
      .map((b) => ({
        label: b.name,
        description: b.preview || b.purpose || '',
        bot: b,
        kind: 'bot',
        run: () => ctx.chooseBot(b.id),
      }));
    const tools = [
      ['Your workspace', 'All your Bots', () => ctx.chooseBot(null)],
      ...[
        ['New Bot', 'newbot'],
        ['Settings & models', 'settings'],
        ['Connections', 'connectionsfeature'],
        ['Mail & calendar', 'mailfeature'],
        ['Devices', 'devicesfeature'],
        ['People & rooms', 'peoplefeature'],
        ['Notifications', 'notificationsfeature'],
        ['Analytics', 'analyticsfeature'],
      ].map(([label, target]) => [
        label,
        'Workspace',
        () => (target === 'settings' ? ctx.settings() : $('#' + target)?.click()),
      ]),
    ].map(([label, description, run]) => ({ label, description, kind: 'tool', run }));
    const render = () => {
      const query = $('#switchquery').value.trim().toLowerCase(),
        filtered = (query ? [...bots, ...tools] : bots)
          .filter((i) => `${i.label} ${i.description}`.toLowerCase().includes(query))
          .slice(0, 12);
      $('#switchresults').innerHTML =
        filtered
          .map(
            (i, n) =>
              `<button type="button" data-switch="${n}">${i.bot ? mascot(i.bot) : icon('chevron', 18)}<span><strong>${esc(i.label)}</strong><small>${esc(i.description)}</small></span></button>`,
          )
          .join('') || '<p class="muted">No matching Bots or tools.</p>';
      document.querySelectorAll('[data-switch]').forEach(
        (b) =>
          (b.onclick = () => {
            const item = filtered[Number(b.dataset.switch)];
            ctx.close();
            item.run();
          }),
      );
    };
    $('#switchquery').oninput = render;
    $('#switchquery').onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.querySelector('#switchresults [data-switch]')?.click();
      }
    };
    render();
    requestAnimationFrame(() => $('#switchquery')?.focus());
  }
  window.addEventListener('resize', syncMobile);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && $('#workspace')) {
      e.preventDefault();
      ctx.close();
      quickSwitch();
    }
    if (e.key === 'Escape' && document.querySelector('#account-menu:popover-open')) return;
    if (e.key === 'Escape' && document.body.classList.contains('nav-open')) mobile(false);
    else if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
      const disclosures = [
        ...document.querySelectorAll(
          '.composer-actions[open],.conversation-picker[open],.tools-disclosure[open]',
        ),
      ];
      if (disclosures.length) disclosures.forEach((element) => (element.open = false));
      else if (ctx.detailsOpen()) ctx.closeDetails();
    }
    if (e.key === 'Tab' && document.body.classList.contains('nav-open')) {
      const controls = [...$('#navigation').querySelectorAll('button,input,summary,a')].filter(
          (el) => el.getClientRects().length && !el.disabled,
        ),
        first = controls[0],
        last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  return { shell, sidebar, header, home, emptyChat, bindChat, quickSwitch };
}
