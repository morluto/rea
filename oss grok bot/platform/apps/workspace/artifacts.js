export async function artifactPreview(revisionId, ctx) {
  const { api, esc, modal, overview, botId } = ctx,
    r = overview.revisions.find((r) => r.id === revisionId);
  let preview,
    documentNote = '';
  try {
    const response = await api(`/bots/${botId}/artifacts/${revisionId}/preview`);
    preview = response.content;
    if (response.documentState)
      documentNote = `<p class="tiny muted">Extracted document text (${esc(response.documentState)}${response.contentTruncated ? ', truncated for preview' : ''}) via ${esc(response.extractedBy ?? '')}. ${(response.extractionLimitations ?? []).map(esc).join(' ')}</p>`;
  } catch (e) {
    preview = e.message;
  }
  const revisions = overview.revisions.filter((v) => v.artifactId === r.artifactId);
  modal(
    r.name,
    `<p class="tiny muted">SHA-256 ${esc(r.digest)}<br>${r.size} bytes · ${esc(r.provenance)}</p>${documentNote}${r.mediaType === 'text/html' ? '<button type="button" id="renderartifact">Open interactive preview</button><button type="button" id="playartifact">Play with CDN &amp; mouse</button><p class="tiny muted">Runs this exact HTML revision in a sandbox with an opaque origin. No product API/tool bridge, forms, popups or top-level navigation. Default preview blocks network access. Play mode permits scripts from jsDelivr/unpkg and mouse capture; Esc releases the mouse. Only use Play for code you trust. Embedded frames and product access stay blocked.</p><div id="artifactframe"></div>' : ''}<details ${r.mediaType === 'text/html' ? '' : 'open'}><summary>Text / source</summary><pre class="pre">${esc(preview)}</pre></details><h3>Versions</h3>${revisions.map((v) => `<p class="tiny">${new Date(v.createdAt).toLocaleString()} · ${esc(v.name)} · <a href="/api/bots/${botId}/artifacts/${v.id}/download">Download original</a></p>`).join('')}`,
  );
  const button = document.querySelector('#renderartifact');
  document.querySelector('#dialog').oncancel = (event) => {
    if (!document.querySelector('#artifactframe iframe')) return;
    event.preventDefault();
    if (document.fullscreenElement) void document.exitFullscreen();
  };
  if (button)
    button.onclick = () => {
      document.querySelector('#artifactframe').innerHTML =
        `<iframe title="Sandboxed artifact" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/api/bots/${botId}/artifacts/${r.id}/render" style="width:100%;height:480px;background:white;border:1px solid var(--line);margin-top:16px"></iframe>`;
      button.disabled = true;
    };
  const play = document.querySelector('#playartifact');
  if (play)
    play.onclick = () => {
      document.querySelector('#artifactframe').innerHTML =
        '<p class="tiny muted">Play mode: CDN code enabled. Click inside the game to play; press Esc to release the mouse.</p>' +
        '<iframe title="Sandboxed artifact" sandbox="allow-scripts allow-pointer-lock" allowfullscreen referrerpolicy="no-referrer" src="/api/bots/' +
        botId +
        '/artifacts/' +
        r.id +
        '/render?play=1" style="width:100%;height:560px;background:white;border:1px solid var(--line);margin-top:16px"></iframe>' +
        '<button type="button" id="artifactfullscreen">Fullscreen game</button>';
      document.querySelector('#artifactfullscreen').onclick = async () => {
        try {
          await document.querySelector('#artifactframe iframe').requestFullscreen();
        } catch (error) {
          const notice = document.createElement('p');
          notice.className = 'notice';
          notice.setAttribute('role', 'alert');
          notice.textContent =
            'Fullscreen is unavailable: ' +
            error.message +
            '. You can keep playing in this preview.';
          document.querySelector('#artifactframe').append(notice);
        }
      };
    };
}
