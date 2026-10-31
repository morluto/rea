import { copyText } from './clipboard.js';
export function collaborationUI(ctx) {
  const { $, api, esc, modal, field, area, action, close, toast } = ctx;
  async function open() {
    const c = await api('/collaboration');
    modal(
      'People, teams & rooms',
      `<p class="muted">Access is explicit. Viewers can read a shared Bot; operators can submit work using that Bot’s existing grants. Only its owner changes its configuration or computer control.</p><div class="row wrap"><button type="button" id="inviteperson">Create invitation</button><button type="button" id="createteam">New team</button><button type="button" id="sharebot">Share a Bot</button><button type="button" id="createroom">New room</button></div><h3 style="margin-top:24px">Rooms</h3><div class="stack">${c.rooms.map((r) => `<div class="card row spread"><div><h3>${esc(r.name)}</h3><span class="tiny muted">Bot ${esc(ctx.state().bots.find((b) => b.id === r.botId)?.name ?? r.botId)}</span></div><button type="button" data-room="${r.id}">Open</button></div>`).join('') || '<p class="muted">No accessible rooms.</p>'}</div><h3 style="margin-top:24px">Teams</h3>${
        c.teams
          .map(
            (t) =>
              `<div class="card"><h3>${esc(t.name)}</h3>${c.memberships
                .filter((m) => m.teamId === t.id)
                .map(
                  (m) =>
                    `<p class="tiny muted">${esc(c.accounts.find((a) => a.id === m.accountId)?.name ?? m.accountId)} · ${esc(m.state)} ${m.role !== 'owner' && m.state === 'active' ? `<button type="button" class="small" data-team="${t.id}" data-revokemember="${m.id}">Revoke</button>` : ''}</p>`,
                )
                .join('')}</div>`,
          )
          .join('') || '<p class="muted">No teams.</p>'
      }<h3 style="margin-top:24px">Bot shares you own</h3>${c.shares.map((s) => `<p class="tiny">${esc(ctx.state().bots.find((b) => b.id === s.botId)?.name ?? s.botId)} → ${esc(c.accounts.find((a) => a.id === s.accountId)?.name ?? c.teams.find((t) => t.id === s.teamId)?.name ?? 'unknown')} · ${esc(s.role)} · ${esc(s.state)} ${s.state === 'active' ? `<button type="button" class="small" data-revokeshare="${s.id}">Revoke</button>` : ''}</p>`).join('')}`,
    );
    $('#inviteperson').onclick = action(async () => {
      const invite = await api('/invites', {});
      const link = location.origin + '/#invite=' + invite.token;
      close();
      modal(
        'Private invitation',
        `<p>One use, expires ${new Date(invite.expiresAt).toLocaleString()}. Share this link privately with the person joining this local workspace.</p><input id="invitelink" type="password" readonly value="${esc(link)}"><button type="button" id="copyinvite" style="margin-top:12px">Copy private link</button><p class="tiny muted">The app remains bound to loopback. This link works on the same computer unless you separately configure secure network hosting.</p>`,
      );
      $('#copyinvite').onclick = action(async () => {
        await copyText(link);
        toast('Private invitation copied');
      });
    });
    $('#createteam').onclick = () => {
      close();
      modal(
        'New team',
        `${field('Team name', 'name', '', 'text', 'required')}<label>Members</label><div class="checks">${c.accounts.map((a) => `<label><input name="accounts" value="${a.id}" type="checkbox">${esc(a.name)}</label>`).join('')}</div>`,
        async (f) => {
          await api('/teams', { name: f.get('name'), accountIds: f.getAll('accounts') });
        },
      );
    };
    $('#sharebot').onclick = () => {
      close();
      modal(
        'Share Bot access',
        `<label>Bot</label><select name="botId">${ctx
          .state()
          .bots.filter((b) => b.accessRole === 'owner')
          .map((b) => `<option value="${b.id}">${esc(b.name)}</option>`)
          .join(
            '',
          )}</select><label>Recipient</label><select name="recipient">${c.accounts.map((a) => `<option value="account:${a.id}">${esc(a.name)}</option>`).join('')}${c.teams.map((t) => `<option value="team:${t.id}">Team: ${esc(t.name)}</option>`).join('')}</select><label>Role</label><select name="role"><option value="viewer">Viewer · read Bot history and resources</option><option value="operator">Operator · submit work using existing Bot grants</option></select>`,
        async (f) => {
          const [type, key] = f.get('recipient').split(':');
          await api(`/bots/${f.get('botId')}/shares`, {
            [type === 'team' ? 'teamId' : 'accountId']: key,
            role: f.get('role'),
          });
        },
      );
    };
    $('#createroom').onclick = () => {
      close();
      modal(
        'New room',
        `${field('Room name', 'name', '', 'text', 'required')}<label>Bot</label><select name="botId">${ctx
          .state()
          .bots.filter((b) => b.accessRole !== 'viewer')
          .map((b) => `<option value="${b.id}">${esc(b.name)}</option>`)
          .join(
            '',
          )}</select><label>Team (members also need access to the Bot)</label><select name="teamId"><option value="">No team restriction</option>${c.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>`,
        async (f) => {
          await api('/rooms', {
            name: f.get('name'),
            botId: f.get('botId'),
            ...(f.get('teamId') ? { teamId: f.get('teamId') } : {}),
          });
        },
      );
    };
    document.querySelectorAll('[data-room]').forEach(
      (b) =>
        (b.onclick = action(async () => {
          close();
          await room(b.dataset.room);
        })),
    );
    document.querySelectorAll('[data-revokemember]').forEach(
      (b) =>
        (b.onclick = action(async () => {
          await api(`/teams/${b.dataset.team}/members/${b.dataset.revokemember}`, {});
          close();
          await open();
        })),
    );
    document.querySelectorAll('[data-revokeshare]').forEach(
      (b) =>
        (b.onclick = action(async () => {
          const s = c.shares.find((s) => s.id === b.dataset.revokeshare);
          await api(`/bots/${s.botId}/shares`, {
            ...(s.accountId ? { accountId: s.accountId } : { teamId: s.teamId }),
            role: s.role,
            state: 'revoked',
          });
          close();
          await open();
        })),
    );
  }
  async function room(roomId) {
    const value = await api(`/rooms/${roomId}/messages`);
    modal(
      value.room.name,
      `<div id="roommessages" style="max-height:40vh;overflow:auto"></div><label>Message</label><textarea name="text" required></textarea><label class="row"><input type="checkbox" name="askBot" style="width:auto">Ask this room’s Bot to respond</label>`,
      async (f) => {
        await api(`/rooms/${roomId}/messages`, {
          text: f.get('text'),
          askBot: f.has('askBot'),
          nonce: crypto.randomUUID(),
        });
        return () => room(roomId);
      },
      'Send to room',
    );
    const render = async () => {
      const v = await api(`/rooms/${roomId}/messages`);
      if (!$('#roommessages')) return;
      let html = '';
      for (const m of v.messages) {
        html += `<article class="message user"><span class="who">${esc(m.accountId)} · ${new Date(m.createdAt).toLocaleString()}</span>${esc(m.text)}</article>`;
        if (m.runId) {
          const o = await api(`/bots/${v.room.botId}/overview`);
          const run = o.runs.find((r) => r.id === m.runId);
          if (run) {
            const history = await api(
              `/bots/${v.room.botId}/conversations/${run.conversationId}/history`,
            );
            html += history
              .filter((h) => h.runId === run.id && h.role === 'assistant')
              .map(
                (h) =>
                  `<article class="message"><span class="who">Bot · ${esc(run.state)}</span>${esc(
                    typeof h.content === 'string'
                      ? h.content
                      : h.content
                          .filter((c) => c.type === 'text')
                          .map((c) => c.text)
                          .join('\n'),
                  )}</article>`,
              )
              .join('');
          }
        }
      }
      if ($('#roommessages')) $('#roommessages').innerHTML = html;
    };
    await render();
    const timer = setInterval(() => {
      void render().catch((e) => {
        clearInterval(timer);
        toast(e.message);
      });
    }, 1500);
    $('#dialog').addEventListener('close', () => clearInterval(timer), { once: true });
  }
  return { open };
}
