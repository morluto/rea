export function modelSignInUI(ctx) {
  const { $, api, esc, modal, field, action, close, refresh, settings } = ctx;
  async function configure() {
    const catalog = await api('/model-signin/catalog');
    modal(
      'Use your ChatGPT plan',
      `${field('Connection name', 'name', 'My ChatGPT plan', 'text', 'required')}<label for="chatgptmodel">Model</label><select id="chatgptmodel" name="model">${catalog.map((m) => `<option value="${esc(m.id)}" ${m.id === 'gpt-6.1-sol' ? 'selected' : ''}>${esc(m.name)} · ${esc(m.id)}</option>`).join('')}</select><p class="muted">Sign in on OpenAI’s page and allow Orbit to use your eligible ChatGPT plan. Usage shares your plan’s limits. No API key is needed.</p><p class="tiny muted">This is Pi’s installed model catalog. A completed response verifies access to the model you select. Your ChatGPT conversations are not imported.</p>`,
      async (f) => {
        const model = await api('/model-signin', { name: f.get('name'), model: f.get('model') });
        const flow = await api(`/models/${model.id}/authorize`, {});
        return () => watch(flow);
      },
      'Continue with ChatGPT',
    );
  }
  async function reconnect(modelId) {
    const flow = await api(`/models/${modelId}/authorize`, {});
    close();
    watch(flow);
  }
  function watch(initial) {
    modal(
      'Sign in with ChatGPT',
      `<div id="modelauthflow"><p id="modelauthstatus" role="status"></p><a id="modelauthlink" class="button" target="_blank" rel="noopener noreferrer" hidden>Open OpenAI sign-in ↗</a><p class="tiny muted">Choose the ChatGPT account you want to use. Login and consent happen on OpenAI’s page.</p><details id="modelauthmanual" hidden><summary>Finish with a callback URL</summary><div id="modelauthprompt"></div><button type="button" id="modelauthanswer">Continue</button></details></div>`,
    );
    const target = $('#modelauthflow'),
      dialog = $('#dialog');
    let timer,
      promptId,
      ended = false;
    const finish = () => {
      ended = true;
      clearTimeout(timer);
      dialog.removeEventListener('cancel', onEscape);
    };
    const cancel = action(async () => {
      finish();
      await api(`/model-signin/flows/${initial.id}/cancel`, {});
      await refresh();
      close();
    });
    const onEscape = () => void cancel();
    dialog.addEventListener('cancel', onEscape);
    $('#closemodal').onclick = cancel;
    $('#cancelmodal').onclick = cancel;
    async function paint(value) {
      if (ended || !target.isConnected || !dialog.open) {
        if (!ended) {
          finish();
          void api(`/model-signin/flows/${initial.id}/cancel`, {}).catch(() => {});
        }
        return;
      }
      $('#modelauthstatus').textContent = value.message;
      const link = $('#modelauthlink');
      link.hidden = !value.authorizationUrl;
      if (value.authorizationUrl) link.href = value.authorizationUrl;
      if (value.prompt && promptId !== value.prompt.id) {
        promptId = value.prompt.id;
        $('#modelauthmanual').hidden = false;
        const p = value.prompt;
        $('#modelauthprompt').innerHTML =
          p.type === 'select'
            ? `<label for="modelauthvalue">${esc(p.message)}</label><select id="modelauthvalue">${p.options.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}</select>`
            : `<label for="modelauthvalue">${esc(p.message)}</label><input id="modelauthvalue" type="password" autocomplete="off" placeholder="${esc(p.placeholder ?? '')}">`;
        $('#modelauthanswer').onclick = action(async () => {
          const input = $('#modelauthvalue');
          await api(`/model-signin/flows/${initial.id}/answer`, { promptId, value: input.value });
          input.value = '';
          $('#modelauthmanual').hidden = true;
        });
      }
      if (value.state === 'connected') {
        finish();
        await refresh();
        close();
        settings();
        return;
      }
      if (['cancelled', 'failed'].includes(value.state)) {
        finish();
        $('#modelauthmanual').hidden = true;
        return;
      }
      timer = setTimeout(async () => {
        try {
          await paint(await api(`/model-signin/flows/${initial.id}`));
        } catch (e) {
          if (target.isConnected) $('#modelauthstatus').textContent = e.message;
          finish();
        }
      }, 600);
    }
    void paint(initial);
  }
  function disconnect(modelId) {
    close();
    modal(
      'Disconnect ChatGPT',
      '<p>Forget this connection’s local authorization. Bots using it will need another model or a new sign-in. Requests already submitted may still finish.</p>',
      async () => api(`/models/${modelId}/disconnect`, {}),
      'Disconnect',
    );
  }
  return { configure, reconnect, disconnect };
}
