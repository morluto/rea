export function personalVaultUI(ctx) {
  const { $, api, esc, modal, field, action, toast } = ctx;
  const labels = { login: 'Login', contact: 'Contact info', card: 'Card' };
  const fields = {
    login: ['origin', 'username', 'password'],
    contact: ['name', 'email', 'phone', 'address'],
    card: ['holder', 'number', 'expiry', 'cvc'],
  };
  const names = {
    origin: 'Website origin',
    username: 'Username',
    password: 'Password (private)',
    name: 'Full name',
    email: 'Email',
    phone: 'Phone',
    address: 'Address',
    holder: 'Cardholder',
    number: 'Card number (private)',
    expiry: 'Expiry',
    cvc: 'Security code (private; optional)',
  };
  async function open() {
    const items = await api('/vault');
    modal(
      'Personal vault',
      '<p>Private local storage for your own logins, contacts and cards. Items are encrypted and are not exposed to Bots or automatically filled into websites. Keep your workspace backups private.</p>' +
        '<div class="row wrap">' +
        Object.entries(labels)
          .map(
            ([kind, label]) =>
              '<button type="button" data-vault-new="' +
              kind +
              '">Add ' +
              label.toLowerCase() +
              '</button>',
          )
          .join('') +
        '</div><label for="vaultsearch">Search vault</label><input id="vaultsearch" type="search"><div class="stack">' +
        items
          .map(
            (item) =>
              '<article class="card" data-vault-item="' +
              item.id +
              '"><h3>' +
              esc(item.label) +
              '</h3><p>' +
              esc(labels[item.kind]) +
              (item.origin ? ' - ' + esc(item.origin) : '') +
              (item.last4 ? ' - ending ' + esc(item.last4) : '') +
              '</p><div class="row wrap"><button type="button" data-vault-edit="' +
              item.id +
              '">Edit metadata</button><button type="button" data-vault-reveal="' +
              item.id +
              '">Reveal privately</button>' +
              (item.kind === 'login'
                ? '<button type="button" data-vault-fill="' +
                  item.id +
                  '">Fill into Bot computer</button>'
                : '') +
              '<button type="button" data-vault-remove="' +
              item.id +
              '">Remove</button></div></article>',
          )
          .join('') +
        '</div><p class="tiny muted">Removal deletes the active local secret, not copies already held in backups or database journals. There is no OS-keychain, hardware-key or payment-autofill claim.</p>',
    );
    $('#vaultsearch').oninput = (event) =>
      document.querySelectorAll('[data-vault-item]').forEach((row) => {
        row.hidden = !row.textContent.toLowerCase().includes(event.target.value.toLowerCase());
      });
    document
      .querySelectorAll('[data-vault-new]')
      .forEach((button) => (button.onclick = () => edit(button.dataset.vaultNew)));
    document.querySelectorAll('[data-vault-edit]').forEach(
      (button) =>
        (button.onclick = () => {
          const item = items.find((value) => value.id === button.dataset.vaultEdit);
          modal(
            'Edit ' + item.label,
            '<p>To update private fields, choose Reveal privately first.</p>' +
              field('Label', 'label', item.label, 'text', 'required'),
            async (form) => {
              await api('/vault/' + item.id, {
                kind: item.kind,
                label: form.get('label'),
                revision: item.revision,
              });
              return open;
            },
            'Save label',
          );
        }),
    );
    document.querySelectorAll('[data-vault-reveal]').forEach(
      (button) =>
        (button.onclick = () => {
          const item = items.find((value) => value.id === button.dataset.vaultReveal);
          modal(
            'Reveal private ' + labels[item.kind].toLowerCase(),
            '<p>Show this item in the local Orbit window? Screen sharing, screenshots or anyone watching your screen may capture it. It is not sent to a Bot.</p>',
            async () => {
              const revealed = await api('/vault/' + item.id + '/reveal', {});
              return () => edit(item.kind, revealed);
            },
            'Reveal to me',
          );
        }),
    );
    document.querySelectorAll('[data-vault-fill]').forEach(
      (button) =>
        (button.onclick = () => {
          const item = items.find((value) => value.id === button.dataset.vaultFill);
          const bots = (ctx.state().bots ?? []).filter((b) =>
            (b.capabilities ?? []).includes('computer'),
          );
          if (!bots.length) return toast('No Bot has the computer capability enabled.');
          modal(
            'Fill into Bot computer',
            `<p>Choose the Bot whose Linux computer receives the saved login for “${esc(item.label)}”. Typing needs your approval and the secret is never shown.</p><label>Bot computer</label><select id="f-bot">${bots.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select>`,
            async () => {
              const { approval } = await api('/vault/' + item.id + '/fill', {
                botId: document.querySelector('#f-bot').value,
              });
              toast('Fill requested. Approve it under Activity & receipts.');
              return null;
            },
            'Request fill',
          );
        }),
    );
    document.querySelectorAll('[data-vault-remove]').forEach(
      (button) =>
        (button.onclick = () => {
          const item = items.find((value) => value.id === button.dataset.vaultRemove);
          modal(
            'Remove ' + item.label,
            '<p>Remove this vault item from active storage?</p>',
            async () => {
              await api('/vault/' + item.id + '/remove', { revision: item.revision });
              return open;
            },
            'Remove item',
          );
        }),
    );
  }
  function edit(kind, item = null) {
    modal(
      item ? 'Private ' + labels[kind].toLowerCase() : 'Add ' + labels[kind].toLowerCase(),
      field('Label', 'label', item?.label ?? '', 'text', 'required autocomplete="off"') +
        fields[kind]
          .map((key) =>
            field(
              names[key],
              key,
              item?.fields?.[key] ?? '',
              ['password', 'number', 'cvc'].includes(key)
                ? 'password'
                : key === 'origin'
                  ? 'url'
                  : 'text',
              'autocomplete="off"',
            ),
          )
          .join('') +
        '<p class="tiny muted">These values stay in the encrypted personal vault. Bots do not receive them.</p>',
      async (form) => {
        await api('/vault' + (item ? '/' + item.id : ''), {
          kind,
          label: form.get('label'),
          fields: Object.fromEntries(
            fields[kind]
              .filter((key) => form.get(key) || !['password', 'number', 'cvc'].includes(key))
              .map((key) => [key, form.get(key)]),
          ),
          ...(item ? { revision: item.revision } : {}),
        });
        toast('Saved privately.');
        return open;
      },
      'Save privately',
    );
  }
  return { open };
}
