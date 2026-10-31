export function codingUI(ctx) {
  const { $, api, esc, modal, field, area, action, close } = ctx;
  async function configure() {
    const config = await api('/coding/config');
    close();
    modal(
      'T3 coding connection',
      '<p>Use the installed T3 CLI and one existing Git project folder named orbit. T3 owns its model accounts, threads and managed worktrees; Orbit does not copy credentials.</p>' +
        '<label><input type="checkbox" name="enabled" ' +
        (config.enabled ? 'checked' : '') +
        '> Enable coding handoffs</label>' +
        field(
          'Shared orbit project folder',
          'projectRoot',
          config.projectRoot,
          'text',
          'required',
        ) +
        field('Worktree base branch', 'baseRef', config.baseRef, 'text', 'required') +
        field(
          'T3 provider instance (optional; set with model)',
          'provider',
          config.provider ?? '',
        ) +
        field('T3 model (blank uses project default)', 'model', config.model ?? '') +
        '<details><summary>Local T3 CLI</summary>' +
        field('T3 executable', 'executable', config.executable, 'text', 'required') +
        field('Bundled CLI entrypoint (blank for standalone t3)', 'entrypoint', config.entrypoint) +
        '</details>',
      async (form) => {
        await api('/coding/config', { ...Object.fromEntries(form), enabled: form.has('enabled') });
      },
      'Validate & save',
    );
  }
  async function open() {
    const botId = ctx.botId();
    const bot = ctx.state().bots.find((item) => item.id === botId);
    const tasks = bot ? await api('/bots/' + botId + '/coding') : [];
    modal(
      'T3 coding',
      '<p>All coding stays in the shared <strong>orbit</strong> T3 project. Each task gets a separate managed worktree. Coding continues independently of the Orbit chat run.</p>' +
        (ctx.state().account.isAdmin
          ? '<button type="button" id="codingconfigure">Connection settings</button>'
          : '') +
        (!bot
          ? '<p>Select a Bot first.</p>'
          : !bot.capabilities.includes('coding')
            ? '<p>Enable T3 coding in this Bot settings under Tools and task limits.</p>'
            : '<button type="button" id="codingnew">New coding task</button>') +
        '<div class="stack">' +
        tasks
          .map(
            (task) =>
              '<article class="card"><h3>' +
              esc(task.title) +
              '</h3><p>' +
              esc(task.state) +
              (task.observedAt
                ? ' - last checked ' + esc(new Date(task.observedAt).toLocaleString())
                : '') +
              '</p><p class="tiny muted">' +
              esc(task.worktreePath ?? task.branch) +
              '</p>' +
              (task.reason ? '<p>' + esc(task.reason) + '</p>' : '') +
              (task.monitorError
                ? '<p role="status">Automatic check: ' + esc(task.monitorError) + '</p>'
                : '') +
              (task.result
                ? '<details><summary>Returned result</summary><pre class="pre">' +
                  esc(task.result) +
                  '</pre></details>'
                : '') +
              '<button type="button" data-coding-task="' +
              task.id +
              '">Refresh status & results</button></article>',
          )
          .join('') +
        '</div><p class="tiny muted">Use T3 for permission prompts, questions, stopping work and the full thread history. Orbit Stop does not stop independent T3 work.</p>',
    );
    $('#codingconfigure')?.addEventListener('click', action(configure));
    $('#codingnew')?.addEventListener('click', () => {
      close();
      modal(
        'New T3 coding task',
        field('Task title', 'title', '', 'text', 'required') +
          area('Coding objective and acceptance checks', 'task') +
          '<p>T3 will create a new thread and worktree. No publication or deployment is authorized by this handoff.</p>',
        async (form) => {
          await api('/bots/' + botId + '/coding', {
            ...Object.fromEntries(form),
            ...(ctx.conversationId() ? { conversationId: ctx.conversationId() } : {}),
            nonce: crypto.randomUUID(),
          });
          return open;
        },
        'Hand off to T3',
      );
    });
    document.querySelectorAll('[data-coding-task]').forEach((button) => {
      button.onclick = action(async () => {
        const result = await api(
          '/bots/' + botId + '/coding/' + button.dataset.codingTask + '/inspect',
          {},
        );
        close();
        modal(
          result.task.title,
          '<p>' +
            esc(result.task.state) +
            '</p><p class="tiny">T3 thread: ' +
            esc(result.task.threadId ?? 'unconfirmed') +
            '<br>Worktree: ' +
            esc(result.task.worktreePath ?? 'not yet confirmed') +
            '</p><p>' +
            esc(result.limitation) +
            '</p><pre class="pre">' +
            esc(JSON.stringify(result.messages, null, 2)) +
            '</pre>' +
            (result.task.threadId ? area('Follow-up message', 'message') : ''),
          result.task.threadId
            ? async (form) => {
                await api('/bots/' + botId + '/coding/' + result.task.id + '/send', {
                  message: form.get('message'),
                  nonce: crypto.randomUUID(),
                });
              }
            : null,
          'Send follow-up',
        );
      });
    });
  }
  return { open };
}
