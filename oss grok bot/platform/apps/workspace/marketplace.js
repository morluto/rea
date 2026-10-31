export function marketplaceUI(ctx) {
  const { $, api, esc, modal, field, action, toast } = ctx;
  async function open() {
    const templates = await api('/marketplace/templates');
    modal(
      'Bot template marketplace',
      '<p class="muted">Shared Bot templates in this workspace. Installing validates the template as a new Bot; installs are recorded per template.</p><div class="stack">' +
        (templates
          .map(
            (t) =>
              '<article class="card"><h3>' +
              esc(t.name) +
              '</h3><p class="tiny muted">' +
              esc(t.purpose ?? '') +
              (t.notes && t.notes !== t.purpose ? '<br>Release notes: ' + esc(t.notes) : '') +
              '<br>v' +
              esc(String(t.version)) +
              ' · installed ' +
              t.installs +
              ' times' +
              '<br>Capabilities: ' +
              esc((t.capabilities ?? []).join(', ') || 'none') +
              '</p><div class="row wrap"><button type="button" data-install="' +
              t.id +
              '" data-name="' +
              esc(t.name) +
              '">Install as new Bot</button></div></article>',
          )
          .join('') ||
          '<p class="muted">No shared templates yet. Publish one from a Bot below.</p>') +
        '</div><h3 style="margin-top:20px">Publish current Bot</h3>' +
        field('Version', 'version', '1.0.0', 'text', 'required') +
        field('Release notes', 'notes', '', 'text') +
        '<div class="row"><button type="button" id="publishbot">Publish selected Bot</button></div>',
      null,
      'Close',
    );
    document.querySelectorAll('[data-install]').forEach(
      (b) =>
        (b.onclick = () =>
          modal(
            'Install template',
            '<p class="muted">Installs a validated copy as a new Bot in this workspace.</p>' +
              field('New Bot name', 'name', b.dataset.name ?? '', 'text', 'required'),
            async (form) => {
              const bot = await api('/marketplace/templates/' + b.dataset.install + '/install', {
                name: form.get('name'),
              });
              toast('Installed as ' + bot.name);
              return () => open();
            },
            'Install',
          )),
    );
    $('#publishbot').onclick = action(async () => {
      const botId = ctx.botId();
      if (!botId) throw Error('Select a Bot first');
      const version = document.querySelector('#f-version').value;
      const notes = document.querySelector('#f-notes').value;
      const template = await api(`/marketplace/templates/${botId}/publish`, { version, notes });
      toast('Published ' + template.name);
      await open();
    });
  }
  return { open };
}
