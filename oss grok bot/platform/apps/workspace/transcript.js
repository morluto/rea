import { copyText } from './clipboard.js';
import { markdown } from './markdown.js';
import { artifactPreview } from './artifacts.js';
import { mascot } from './mascots.js';
import { icon } from './icons.js';
const signatures = new WeakMap();
const terminal = (s) => ['settled', 'cancelled', 'failed', 'interrupted'].includes(s);
const toolLabels = {
  memory_save: 'Save memory',
  memory_search: 'Search memory',
  library_publish: 'Publish a file',
  library_read: 'Read a file',
  library_list: 'Find files',
  routine_create: 'Create a routine',
  routine_list: 'List routines',
  routine_outcome: 'Record a routine outcome',
  reminder_create: 'Set a reminder',
  library_search: 'Search library content',
  coding_start: 'Start a T3 coding task',
  coding_list: 'List coding tasks',
  coding_status: 'Check coding task status',
  coding_send: 'Message the coding session',
  bot_inventory: 'List delegation targets',
  computer_observe: 'Look at the computer',
  computer_command: 'Run a workspace job',
  computer_input: 'Use the computer',
  computer_manage: 'Manage the computer',
  ask_user: 'Ask you a question',
  report_progress: 'Task milestone',
  delegate_task: 'Work with another Bot',
};
export function transcript(ctx) {
  const {
      $,
      esc,
      api,
      action,
      refresh,
      features,
      design,
      bot,
      overview,
      history,
      conversationId,
      historyCursor,
      historyStartIndex,
      historyNotice,
      loadEarlier,
    } = ctx,
    el = $('#transcript');
  if (!el) return;
  const runs = overview.runs.filter((r) => r.conversationId === conversationId),
    active = runs.find((r) => !terminal(r.state)),
    pending = overview.approvals.filter((a) => a.state === 'pending'),
    signature = JSON.stringify([
      conversationId,
      bot.id,
      bot.revision,
      historyCursor ?? null,
      historyNotice ?? null,
      history.map((m) => m.entryId),
      runs.map((r) => [
        r.id,
        r.state,
        r.partialText,
        r.partialOpen,
        r.partialHasTools,
        r.milestones,
        r.reason,
        r.result,
      ]),
      pending.map((a) => [a.id, a.revision]),
      overview.waits?.map((w) => [w.id, w.revision]),
      overview.reminders?.map((reminder) => [reminder.id, reminder.revision, reminder.pinned]),
      overview.codingTasks,
    ]);
  if (signatures.get(el) !== signature) {
    signatures.set(el, signature);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    const top = el.getBoundingClientRect().top;
    const anchor = [...el.children].find(
      (node) => node.dataset.entry && node.getBoundingClientRect().bottom > top,
    );
    const anchorTop = anchor?.getBoundingClientRect().top;
    const textOf = (m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
    const when = (m) => {
      if (!m.at) return '';
      const t = new Date(m.at);
      return Number.isNaN(t.getTime()) ? '' : t.toLocaleString();
    };
    const message = (m, key = m.entryId) =>
      `<article class="message ${m.role === 'user' ? 'user' : 'assistant'}" data-entry="${esc(key)}">${m.role === 'assistant' ? `<div class="message-identity">${mascot({ ...bot, activity: { state: 'idle', label: bot.name } }, 'mini', true)}<span>${esc(bot.name)}</span></div>` : ''}<div class="${m.role === 'user' ? 'user-prose' : 'markdown-body'}">${m.role === 'user' ? esc(textOf(m)) : markdown(m.stopReason === 'error' && !runById.get(m.runId)?.budgetStopped ? 'The provider request failed. See task activity.' : textOf(m), { botId: bot.id, revisions: overview.revisions, runId: m.runId })}</div><div class="message-actions">${when(m) ? `<span class="tiny muted">${esc(when(m))}</span>` : ''}<button type="button" class="small" data-copymessage>Copy</button><button type="button" class="small" data-readmessage>Read aloud</button></div></article>`;
    const activityEntry = (m) => {
      if (m.role === 'toolResult')
        return `<details class="action-result" data-entry="${esc(m.entryId)}"><summary>${icon(m.isError ? 'bolt' : 'check', 13)}${m.isError ? 'Failed: ' : ''}${esc(toolLabels[m.toolName] ?? m.toolName ?? 'Action result')}<span>Result</span></summary><pre>${esc(JSON.stringify(m.content, null, 2))}</pre></details>`;
      return (
        (m.content ?? [])
          .filter?.((c) => c.type === 'toolCall')
          .map(
            (c) =>
              `<details class="action-result"><summary>${icon('bolt', 13)}${esc(toolLabels[c.name] ?? c.name)}<span>Arguments</span></summary><pre>${esc(JSON.stringify(c.arguments, null, 2))}</pre></details>`,
          )
          .join('') ?? ''
      );
    };
    const entries = [],
      runById = new Map(runs.map((r) => [r.id, r])),
      represented = new Set();
    const timeline = [];
    for (const entry of history) {
      const run = runById.get(entry.runId);
      if (!run) timeline.push({ message: entry });
      else if (!represented.has(run.id)) {
        represented.add(run.id);
        timeline.push({ run });
      }
    }
    // Receipts with no canonical messages remain visible within the loaded time range.
    // Older settled runs must not fabricate prompts outside the requested history page.
    const boundary = Date.parse(history[0]?.at ?? '');
    for (const run of [...runs].sort((a, b) => a.acceptedAt - b.acceptedAt)) {
      if (
        represented.has(run.id) ||
        (terminal(run.state) && historyStartIndex > 0 && !(run.acceptedAt >= boundary))
      )
        continue;
      const index = timeline.findIndex((item) => {
        const time = item.message ? Date.parse(item.message.at ?? '') : item.run.acceptedAt;
        return time > run.acceptedAt;
      });
      timeline.splice(index < 0 ? timeline.length : index, 0, { run });
    }
    const notified = (overview.reminders ?? [])
      .filter(
        (reminder) => reminder.conversationId === conversationId && reminder.state === 'notified',
      )
      .sort((a, b) => a.notifiedAt - b.notifiedAt);
    for (const reminder of notified) {
      const index = timeline.findIndex((item) => {
        const time = item.message
          ? Date.parse(item.message.at ?? '')
          : (item.run?.acceptedAt ?? Number.POSITIVE_INFINITY);
        return time > reminder.notifiedAt;
      });
      timeline.splice(index < 0 ? timeline.length : index, 0, { reminder });
    }
    for (const item of timeline) {
      if (item.reminder) {
        entries.push(
          message(
            {
              role: 'assistant',
              content: item.reminder.message,
              at: new Date(item.reminder.notifiedAt).toISOString(),
            },
            `reminder-${item.reminder.id}`,
          ),
        );
        continue;
      }
      if (item.message) {
        entries.push(
          item.message.role === 'toolResult' ? activityEntry(item.message) : message(item.message),
        );
        continue;
      }
      const r = item.run;
      if (r.hostAction) {
        entries.push(
          `<article class="connected-action card" data-entry="action-${r.id}"><div class="row spread"><h3>${esc(r.hostAction.operation)}</h3><span class="badge">${esc(r.state)}</span></div><p>${esc(r.text)}</p>${r.result ? `<details><summary>Provider response</summary><pre class="pre">${esc(JSON.stringify(r.result, null, 2))}</pre></details>` : ''}</article>`,
        );
        continue;
      }
      const messages = history.filter((m) => m.runId === r.id),
        responses = messages.filter((m) => m.role === 'assistant' && textOf(m).trim()),
        first = responses[0],
        final = terminal(r.state) ? responses.at(-1) : null,
        user = messages.find((m) => m.role === 'user');
      if (user) entries.push(message(user));
      else if (!messages.length)
        entries.push(message({ role: 'user', content: r.text }, `request-${r.id}`));
      if (first) entries.push(message(first));
      for (const milestone of r.milestones ?? [])
        entries.push(
          `<div class="task-milestone" title="Bot update" data-entry="milestone-${esc(milestone.id)}">${icon('check', 13)}<span>${esc(milestone.text)}</span></div>`,
        );
      const details = messages
        .map(
          (m) =>
            `${m.role === 'assistant' && m !== first && m !== final && textOf(m).trim() ? `<div class="activity-note markdown-body">${markdown(textOf(m))}</div>` : ''}${activityEntry(m)}`,
        )
        .join('');
      const alreadyRecorded =
        responses.at(-1) && textOf(responses.at(-1)).trim() === (r.partialText ?? '').trim();
      const live =
        !terminal(r.state) && r.partialText && !(r.partialOpen === false && alreadyRecorded);
      const hiddenLive = live && first && r.partialHasTools;
      const count = messages.filter(
        (m) => m.role === 'toolResult' && m.toolName !== 'report_progress',
      ).length;
      if (details || !terminal(r.state) || r.state === 'cancelled')
        entries.push(
          `<details class="run-activity" data-entry="activity-${r.id}"><summary>${icon('chevron', 13)}<span>${!terminal(r.state) ? ({ queued: 'Queued', preparing: 'Starting', waiting_approval: 'Approval needed', waiting_input: 'Waiting for you', waiting_child: 'Working with another Bot', cancelling: 'Stopping' }[r.state] ?? 'Working') : r.state === 'cancelled' ? 'Stopped' : 'Activity'}</span>${count ? `<small>${count} ${count === 1 ? 'action' : 'actions'}</small>` : ''}</summary><div class="activity-body">${details}${hiddenLive ? `<div class="activity-note markdown-body">${markdown(r.partialText)}</div>` : ''}${!details && !hiddenLive ? '<p class="muted">Task accepted. Waiting for the next update.</p>' : ''}</div></details>`,
        );
      if (final && final !== first) entries.push(message(final));
      else if (live && !hiddenLive)
        entries.push(
          `<article class="message assistant streaming" data-entry="partial-${r.id}"><div class="message-identity">${mascot(bot, 'mini', true)}<span>${esc(bot.name)}</span></div><div class="markdown-body">${markdown(r.partialText)}</div></article>`,
        );
      if (r.reason)
        entries.push(
          `<div class="run-notice" data-entry="notice-${r.id}"><strong>${r.state === 'failed' ? 'Task failed' : esc(r.state)}</strong><p>${esc(r.reason)}</p></div>`,
        );
    }
    const pinHost = $('#chatpins');
    if (pinHost) {
      const shown = [...notified].filter((reminder) => reminder.pinned !== false).reverse().slice(0, 3);
      pinHost.hidden = shown.length === 0;
      pinHost.innerHTML =
        shown
          .map(
            (reminder) =>
              `<button type="button" class="chat-pin" data-pin-open="${esc(reminder.id)}" aria-label="Pinned message">${icon('pin', 16)}<span class="chat-pin-text">${esc(reminder.message)}</span></button>`,
          )
          .join('') +
        '<div class="pin-sheet" id="pinsheet" hidden><button type="button" class="pin-sheet-close" data-pin-close aria-label="Close">×</button><p></p><div class="pin-sheet-actions"><button type="button" data-unpin>' +
        icon('pinOff', 16) +
        '<span>Unpin</span></button><button type="button" data-goto><span>Go to message</span>' +
        icon('arrow', 16) +
        '</button></div></div>';
      el.style.paddingTop = shown.length ? `${56 + shown.length * 40}px` : '';
      const sheet = pinHost.querySelector('#pinsheet');
      const jump = (id) => {
        const target = el.querySelector(`[data-entry="reminder-${CSS.escape(id)}"]`);
        if (!target) return;
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.remove('pin-flash');
        void target.offsetWidth;
        target.classList.add('pin-flash');
      };
      for (const button of pinHost.querySelectorAll('[data-pin-open]'))
        button.onclick = () => {
          const reminder = shown.find((item) => item.id === button.dataset.pinOpen);
          if (!reminder) return;
          sheet.hidden = false;
          sheet.dataset.id = reminder.id;
          sheet.querySelector('p').textContent = reminder.message;
        };
      sheet.querySelector('[data-pin-close]').onclick = () => {
        sheet.hidden = true;
      };
      sheet.querySelector('[data-goto]').onclick = () => {
        const id = sheet.dataset.id;
        sheet.hidden = true;
        if (id) jump(id);
      };
      sheet.querySelector('[data-unpin]').onclick = action(async () => {
        const id = sheet.dataset.id;
        if (!id) return;
        await api(`/bots/${bot.id}/reminders/${id}/unpin`, {});
        sheet.hidden = true;
        await refresh();
      });
    }
    for (const task of overview.codingTasks ?? []) {
      if (task.conversationId === conversationId && task.result)
        entries.push(
          '<article class="message assistant" data-entry="coding-' +
            esc(task.id) +
            '"><div class="message-identity">' +
            mascot(bot, 'mini', true) +
            '<span>' +
            esc(bot.name) +
            ' - T3 coding result</span></div><h3>' +
            esc(task.title) +
            '</h3><div class="markdown-body">' +
            markdown(task.result, { botId: bot.id, revisions: overview.revisions }) +
            '</div><p class="tiny muted">T3 reports ' +
            esc(task.state) +
            '. Returned automatically by the host; claims are not independently verified. Thread: ' +
            esc(task.threadId) +
            '</p></article>',
        );
    }
    entries.push(
      ...pending.map(
        (a) =>
          `<article class="approval-card" data-entry="approval-${a.id}"><div class="approval-title">${icon('bolt', 18)}<h3>A quick check before I do this.</h3></div><p>${esc(toolLabels[a.tool] ?? a.tool)}</p><p class="approval-description">${esc(a.description ?? '')}</p><details open><summary>Review the exact action</summary><pre class="pre">${esc(JSON.stringify(a.args, null, 2))}</pre></details><div class="approval-footer"><span>Only this action. Expires ${new Date(a.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</span><div class="row"><button class="small" data-deny="${a.id}">Deny</button><button class="primary small" data-approve="${a.id}">Approve</button></div></div></article>`,
      ),
    );
    const template = document.createElement('template');
    const earlier = historyCursor
      ? `<div class="center" style="margin-bottom:12px"><button type="button" class="small" data-loadearlier>Load earlier messages</button></div>`
      : '';
    template.innerHTML =
      (historyNotice ? `<p class="history-notice" role="status">${esc(historyNotice)}</p>` : '') +
      earlier +
      (entries.join('') || design.emptyChat(bot));
    const old = new Map(
      [...el.children].filter((n) => n.dataset.entry).map((n) => [n.dataset.entry, n]),
    );
    let cursor = el.firstChild;
    for (const fresh of [...template.content.childNodes]) {
      const key = fresh.dataset?.entry,
        prior = key && old.get(key);
      let node = fresh;
      if (prior) {
        if (key.startsWith('partial-')) {
          const body = prior.querySelector('.markdown-body'),
            next = fresh.querySelector('.markdown-body');
          if (body.innerHTML !== next.innerHTML) body.innerHTML = next.innerHTML;
          node = prior;
        } else if (prior.tagName === 'DETAILS' && fresh.tagName === 'DETAILS') {
          const expanded = new Set(
            [...prior.querySelectorAll('details[open][data-entry]')].map((el) => el.dataset.entry),
          );
          fresh.open = prior.open;
          for (const detail of fresh.querySelectorAll('details[data-entry]'))
            detail.open = expanded.has(detail.dataset.entry);
          if (prior.innerHTML !== fresh.innerHTML) prior.innerHTML = fresh.innerHTML;
          node = prior;
        } else if (history.some((m) => m.entryId === key) || prior.outerHTML === fresh.outerHTML)
          node = prior;
      }
      if (node === cursor) cursor = cursor.nextSibling;
      else el.insertBefore(node, cursor);
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    if (atBottom) el.scrollTop = el.scrollHeight;
    else if (anchor?.isConnected) el.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    for (const button of el.querySelectorAll('[data-loadearlier]'))
      button.onclick = async () => {
        button.disabled = true;
        button.textContent = 'Loading earlier messages...';
        try {
          await loadEarlier?.();
        } finally {
          if (button.isConnected) {
            button.disabled = false;
            button.textContent = 'Load earlier messages';
          }
        }
      };
    for (const [attr, decision] of [
      ['approve', 'approved'],
      ['deny', 'denied'],
    ])
      document.querySelectorAll(`[data-${attr}]`).forEach(
        (button) =>
          (button.onclick = action(async () => {
            const a = pending.find((a) => a.id === button.dataset[attr]);
            button.disabled = true;
            await api(`/bots/${bot.id}/approvals/${a.id}`, { decision, revision: a.revision });
            await refresh();
          })),
      );
    for (const pre of el.querySelectorAll('.markdown-body pre'))
      if (!pre.querySelector('button')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'copy-code';
        button.innerHTML = icon('copy', 13) + 'Copy';
        button.onclick = action(async () => {
          await copyText(pre.querySelector('code')?.textContent ?? '');
          button.textContent = 'Copied';
          setTimeout(() => {
            button.innerHTML = icon('copy', 13) + 'Copy';
          }, 1800);
        });
        pre.append(button);
      }
    for (const button of el.querySelectorAll('[data-readmessage]'))
      button.onclick = action(async () => {
        const card = button.closest('article.message');
        const text = card?.querySelector('.markdown-body, .user-prose')?.innerText ?? '';
        if (!window.speechSynthesis) throw Error('Speech synthesis is unavailable in this browser');
        if (!text.trim()) throw Error('There is no message text to read aloud');
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
        button.textContent = 'Speaking';
        setTimeout(() => {
          button.textContent = 'Read aloud';
        }, 1800);
      });
    for (const button of el.querySelectorAll('[data-copymessage]'))
      button.onclick = action(async () => {
        const card = button.closest('article.message');
        await copyText(card?.querySelector('.markdown-body, .user-prose')?.innerText ?? '');
        button.textContent = 'Copied';
        setTimeout(() => {
          button.textContent = 'Copy';
        }, 1800);
      });
    el.querySelectorAll('[data-artifact-revision]').forEach((link) => {
      link.onclick = action(async (event) => {
        event.preventDefault();
        await artifactPreview(link.dataset.artifactRevision, {
          api,
          esc,
          modal: ctx.modal,
          overview,
          botId: bot.id,
        });
      });
    });
    design.bindChat();
  }
  features.chat();
  $('#stoprun').hidden = !active;
  $('#stoprun').onclick = action(async () => {
    await api(`/bots/${bot.id}/runs/${active.id}/cancel`, {});
    await refresh();
  });
  $('#chatstatus').dataset.state = active ? active.state : bot.modelId ? 'idle' : 'unconfigured';
  $('#chatstatus').textContent = active
    ? ({
        queued: 'Queued',
        preparing: 'Starting',
        running: 'Working',
        waiting_approval: 'Approval needed',
        waiting_input: 'Waiting for your answer',
        waiting_child: 'Working with another Bot',
        cancelling: 'Stopping',
      }[active.state] ?? 'Working')
    : bot.modelId
      ? 'Enter to send · Shift+Enter for a new line'
      : 'Choose a model in Settings to start a conversation';
}
