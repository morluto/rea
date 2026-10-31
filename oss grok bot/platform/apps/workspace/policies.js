export function policiesUI(ctx) {
  const { $, api, esc, modal, field, action, toast } = ctx;
  async function open() {
    const connections = await api('/connections');
    modal(
      'Custom action rules',
      '<p>Describe the rule for yourself, then bind it to an exact account, operation and Bot. Descriptions are not interpreted as permissions. Deny wins; Ask first wins over Allow. Built-in capability, account, schema and grant checks always apply.</p><div class="stack">' +
        connections
          .map(
            (connection) =>
              '<article class="card"><h3>' +
              esc(connection.name) +
              '</h3><p>' +
              esc(connection.accountLabel) +
              '</p>' +
              (connection.rules ?? [])
                .map(
                  (rule) =>
                    '<p>' +
                    esc(rule.description) +
                    '<br><span class="tiny muted">' +
                    esc(rule.operation) +
                    ' - ' +
                    esc(rule.behavior) +
                    ' - ' +
                    (rule.botIds.length
                      ? rule.botIds.length + ' selected Bots'
                      : 'all granted Bots') +
                    '</span> <button type="button" class="small" data-rule-remove="' +
                    rule.id +
                    '" data-rule-connection="' +
                    connection.id +
                    '">Remove rule</button></p>',
                )
                .join('') +
              '<button type="button" data-rule-add="' +
              connection.id +
              '">Add rule</button>' +
              (connection.oauth
                ? ' <button type="button" data-catalog-update="' +
                  connection.id +
                  '">Update available tools</button>'
                : '') +
              '</article>',
          )
          .join('') +
        '</div>',
    );
    document.querySelectorAll('[data-rule-add]').forEach(
      (button) =>
        (button.onclick = () => {
          const connection = connections.find((value) => value.id === button.dataset.ruleAdd);
          const bots = ctx.state().bots.filter((bot) => connection.botIds.includes(bot.id));
          modal(
            'Add rule: ' + connection.name,
            field('Rule description', 'description', '', 'text', 'required') +
              '<label for="ruleoperation">Exact operation</label><select id="ruleoperation" name="operation">' +
              connection.discoveredTools
                .map((operation) => '<option>' + esc(operation.name) + '</option>')
                .join('') +
              '</select><label for="rulebehavior">Behavior</label><select id="rulebehavior" name="behavior"><option value="ask">Ask first</option><option value="deny">Deny</option><option value="allow">Allow automatically</option></select>' +
              '<label for="rulebot">Bot scope</label><select id="rulebot" name="botId"><option value="">All currently and subsequently granted Bots</option>' +
              bots
                .map((bot) => '<option value="' + bot.id + '">' + esc(bot.name) + '</option>')
                .join('') +
              '</select>' +
              '<p class="tiny muted">Allow is a standing grant for this exact operation and account, not approval for everything described in prose. Changing rules invalidates pending connector snapshots.</p>',
            async (form) => {
              await api('/connections/' + connection.id + '/rules', {
                revision: connection.revision,
                rules: [
                  ...(connection.rules ?? []),
                  {
                    description: form.get('description'),
                    operation: form.get('operation'),
                    behavior: form.get('behavior'),
                    botIds: form.get('botId') ? [form.get('botId')] : [],
                    enabled: true,
                  },
                ],
              });
              return open;
            },
            'Save rule',
          );
        }),
    );
    document.querySelectorAll('[data-rule-remove]').forEach(
      (button) =>
        (button.onclick = action(async () => {
          const connection = connections.find(
            (value) => value.id === button.dataset.ruleConnection,
          );
          await api('/connections/' + connection.id + '/rules', {
            revision: connection.revision,
            rules: (connection.rules ?? []).filter((rule) => rule.id !== button.dataset.ruleRemove),
          });
          await open();
        })),
    );
    document.querySelectorAll('[data-catalog-update]').forEach(
      (button) =>
        (button.onclick = () => {
          const connection = connections.find((value) => value.id === button.dataset.catalogUpdate);
          modal(
            'Update ' + connection.name + ' tools',
            '<p>Load the current built-in operation catalog for this provider. Existing named operation policies are retained. New operations start with Ask first. Existing credentials and account identity are unchanged; a pending action with an older catalog must be reviewed again.</p>',
            async () => {
              const updated = await api('/oauth/connections/' + connection.id + '/catalog', {
                revision: connection.revision,
              });
              toast(
                updated.discoveredTools.length + ' tools available; new tools require approval.',
              );
              return open;
            },
            'Update tool catalog',
          );
        }),
    );
  }
  return { open };
}
