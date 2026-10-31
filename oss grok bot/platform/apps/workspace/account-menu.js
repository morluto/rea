import { copyText } from './clipboard.js';
import { icon } from './icons.js';
import { wordmark } from './mascots.js';

export function accountMenuUI(ctx) {
  const { app, esc, modal, action, api, settings, signOut, toast } = ctx;
  let menu = null,
    trigger = null;
  function closeSubmenus() {
    for (const element of menu?.querySelectorAll('[data-account-submenu]') ?? [])
      element.hidden = true;
    for (const button of menu?.querySelectorAll('[data-submenu]') ?? [])
      button.setAttribute('aria-expanded', 'false');
  }
  function close(focus = false) {
    closeSubmenus();
    if (menu?.matches(':popover-open')) menu.hidePopover();
    trigger?.setAttribute('aria-expanded', 'false');
    if (focus) trigger?.focus();
  }
  function submenu(name, focus = false) {
    closeSubmenus();
    const element = menu.querySelector(`[data-account-submenu="${name}"]`);
    element.hidden = false;
    menu.querySelector(`[data-submenu="${name}"]`).setAttribute('aria-expanded', 'true');
    if (focus) element.querySelector('button:not(:disabled),a').focus();
  }
  function help() {
    modal(
      'Help Center',
      '<h3>Start a conversation</h3><p>Open Settings, then General and Models. Connect your own model and test its response. Create a Bot, choose its model and send your first message.</p><h3>Use a computer</h3><p>Keep Docker running on your primary computer. Prepare the Linux image, then start a Bot’s computer. Open its live viewer, take control to use it yourself, and hand back when finished. Pause and stop preserve its saved files.</p><h3>Files and routines</h3><p>Library keeps original files and versions. Routines and reminders run while the primary host is awake. Closing the desktop window keeps the host running; Quit stops it.</p><h3>Feedback</h3><p>Set a public HTTPS feedback page in Settings → General → Advanced to enable the feedback link. Opening that page does not automatically upload workspace data.</p>',
    );
  }
  function shortcuts() {
    modal(
      'Keyboard shortcuts',
      `<dl class="shortcut-list">${[
        ['Ctrl + K', 'Search Bots and workspace tools'],
        ['Enter', 'Send the current message'],
        ['Shift + Enter', 'New line in a message'],
        ['Escape', 'Close the current menu, dialog or panel'],
        ['Arrow keys', 'Navigate menu items and settings tabs'],
        ...(window.workshopDesktop ? [['Ctrl + Q', 'Quit Orbit normally']] : []),
      ]
        .map(([key, description]) => `<div><dt><kbd>${key}</kbd></dt><dd>${description}</dd></div>`)
        .join('')}</dl>`,
    );
  }
  async function about() {
    const native = window.workshopDesktop ? await window.workshopDesktop.info() : null;
    const health = await api('/health');
    const version = native?.version ?? health.version;
    modal(
      'Orbit',
      `<div class="about-content"><div class="about-logo">${wordmark()}</div><h3>Orbit</h3><p>Version ${esc(version)}</p><p class="muted">Independent personal Bot workspace</p><button type="button" id="copyversioninfo">Copy version info</button></div>`,
      null,
      undefined,
      { className: 'about-dialog' },
    );
    document.querySelector('#copyversioninfo').onclick = action(async () => {
      await copyText(
        `Orbit ${version}\nHost ${health.version}\nPlatform ${native?.platform ?? 'web'}`,
      );
      toast('Version info copied');
    });
  }
  function open() {
    trigger = document.querySelector('#settings');
    if (menu?.matches(':popover-open')) {
      close(true);
      return;
    }
    if (!menu?.isConnected) {
      menu = document.createElement('div');
      menu.id = 'account-menu';
      menu.className = 'account-menu';
      menu.setAttribute('popover', 'auto');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Account');
      app.append(menu);
      menu.addEventListener('toggle', (event) => {
        if (event.currentTarget === menu && event.newState === 'closed') {
          trigger?.setAttribute('aria-expanded', 'false');
          closeSubmenus();
        }
      });
    }
    const state = ctx.state();
    const feedback = state.settings.feedbackUrl;
    menu.innerHTML = `<button type="button" role="menuitem" data-account-action="usage">${icon('chart', 16)}<span>Usage &amp; Billing</span></button><button type="button" role="menuitem" data-account-action="devices">${icon('device', 16)}<span>Connect another device</span></button><div class="account-submenu-row"><button type="button" role="menuitem" data-submenu="support" aria-haspopup="menu" aria-expanded="false">${icon('settings', 16)}<span>Support</span>${icon('chevron', 14)}</button><div class="account-submenu" role="menu" aria-label="Support" data-account-submenu="support" hidden><button type="button" role="menuitem" data-account-action="help">Help Center</button><button type="button" role="menuitem" data-account-action="shortcuts">Keyboard shortcuts</button>${feedback ? `<a role="menuitem" data-account-feedback href="${esc(feedback)}" target="_blank" rel="noopener noreferrer">Send Feedback</a>` : '<button type="button" role="menuitem" disabled title="Set a feedback page in General → Advanced">Send Feedback</button>'}<button type="button" role="menuitem" data-account-action="about">About</button></div></div><button type="button" role="menuitem" data-account-action="settings">${icon('settings', 16)}<span>Settings</span></button><hr><div class="account-submenu-row"><button type="button" role="menuitem" data-submenu="switch" aria-haspopup="menu" aria-expanded="false">${icon('arrow', 16)}<span>Switch account</span>${icon('chevron', 14)}</button><div class="account-submenu" role="menu" aria-label="Switch account" data-account-submenu="switch" hidden><button type="button" role="menuitemradio" aria-checked="true" disabled>${esc(state.account?.name ?? 'Current account')}</button><button type="button" role="menuitem" data-account-action="logout">Sign out to switch</button></div></div><button type="button" role="menuitem" data-account-action="logout">${icon('arrow', 16)}<span>Log out</span></button>`;
    for (const button of menu.querySelectorAll('[data-submenu]')) {
      button.onclick = () => submenu(button.dataset.submenu, true);
      button.onpointerenter = () => submenu(button.dataset.submenu);
    }
    const actions = {
      usage: () => settings('usage'),
      devices: () => document.querySelector('#remotefeature')?.click(),
      help,
      shortcuts,
      about,
      settings: () => settings('general'),
      logout: signOut,
    };
    for (const button of menu.querySelectorAll('[data-account-action]')) {
      button.onclick = action(async () => {
        close();
        await actions[button.dataset.accountAction]();
      });
      if (!button.closest('[data-account-submenu]')) button.onpointerenter = closeSubmenus;
    }
    menu.querySelector('[data-account-feedback]')?.addEventListener('click', () => close());
    menu.onkeydown = (event) => {
      if (event.key === 'Tab') {
        close(true);
        event.stopPropagation();
        return;
      }
      const parent = event.target.closest('[data-account-submenu]');
      if (event.key === 'Escape' || (event.key === 'ArrowLeft' && parent)) {
        event.preventDefault();
        event.stopPropagation();
        if (parent) {
          const name = parent.dataset.accountSubmenu;
          closeSubmenus();
          menu.querySelector(`[data-submenu="${name}"]`).focus();
        } else close(true);
        return;
      }
      if (event.key === 'ArrowRight' && event.target.dataset.submenu) {
        event.preventDefault();
        event.stopPropagation();
        submenu(event.target.dataset.submenu, true);
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const container = parent ?? menu;
      const items = [...container.querySelectorAll('button:not(:disabled),a')].filter(
        (item) => item.closest('[data-account-submenu]') === parent,
      );
      const index = items.indexOf(event.target),
        next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    const bounds = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - 244))}px`;
    menu.style.bottom = `${Math.max(8, innerHeight - bounds.top + 4)}px`;
    menu.style.top = 'auto';
    menu.showPopover();
    trigger.setAttribute('aria-expanded', 'true');
    menu.querySelector('[role="menuitem"]').focus();
  }
  return {
    open,
    reset() {
      close();
      menu?.remove();
      menu = null;
      trigger = null;
    },
  };
}
