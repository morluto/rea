export function librarySearchUI(ctx) {
  const { $, api, esc, modal, field, action, toast, close } = ctx;
  function open() {
    const botId = ctx.botId();
    if (!botId) return toast('Select a Bot first.');
    modal(
      'Search library',
      '<p>Search current UTF-8 text revisions and extracted PDF/Office document text for a phrase. Results retain exact revision identity and digest; document offsets refer to extracted text. Other binary files are explicitly listed as unsearched; this is literal search, not semantic search.</p>' +
        field('Search phrase', 'query', '', 'text', 'required') +
        '<div id="librarysearchresults"></div><div class="row" style="margin-top:12px"><button type="button" id="thesemantic">Semantic similarity</button></div>',
      async (form) => {
        const query = form.get('query');
        return async () => results(botId, query);
      },
      'Search',
    );
    $('#thesemantic')?.addEventListener('click', () => semanticOpen(botId));
  }
  async function results(botId, query, cursor = null, previous = []) {
    const page = await api('/bots/' + botId + '/library-search', {
      query,
      ...(cursor ? { cursor } : {}),
    });
    const pages = [...previous, page];
    modal(
      'Library results',
      '<p>' +
        esc(query) +
        '</p><div class="stack">' +
        pages
          .flatMap((value) => value.matches)
          .map(
            (match) =>
              '<article class="card"><h3>' +
              esc(match.name) +
              '</h3><pre class="pre">' +
              esc(match.excerpt) +
              '</pre><p class="tiny muted">Revision ' +
              esc(match.revisionId) +
              '<br>SHA-256 ' +
              esc(match.digest) +
              '</p><a href="/api/bots/' +
              botId +
              '/artifacts/' +
              match.revisionId +
              '/download">Download this exact revision</a></article>',
          )
          .join('') +
        '</div><p class="tiny muted">' +
        pages.reduce((count, value) => count + value.examined.length, 0) +
        ' revisions examined. ' +
        (page.nextCursor ? 'More revisions remain.' : 'End of this search snapshot.') +
        '</p>' +
        pages
          .flatMap((value) => value.examined)
          .filter((value) => value.coverage === 'not_searched')
          .map(
            (value) =>
              '<p class="tiny muted">Not searched: ' +
              esc(value.name) +
              ' - ' +
              esc(value.reason) +
              '</p>',
          )
          .join('') +
        (page.nextCursor
          ? '<button type="button" id="librarysearchmore">Search next page</button>'
          : '') +
        '<p class="tiny muted">Only one excerpt per matching revision is shown. Download the source for full context.</p>',
    );
    $('#librarysearchmore')?.addEventListener(
      'click',
      action(async () => results(botId, query, page.nextCursor, pages)),
    );
  }
  async function semanticOpen(botId) {
    const config = await api('/bots/' + botId + '/semantic');
    modal(
      'Semantic similarity',
      `<p>${esc(config.detail ?? '')}</p><p class="tiny muted">Mode: ${esc(config.mode)} · ${config.mode === 'local' ? 'deterministic token-hash cosine similarity' : 'vectors from ' + esc(config.endpoint ?? '') + ' model ' + esc(config.model ?? '')}. Binary files without extractable text are unsearched.</p>` +
        field('Similarity query', 'query', '', 'text', 'required') +
        '<div class="row wrap" style="margin-top:12px"><button type="button" id="semanticconfig">Similarity model settings</button></div><div id="semanticresults"></div>',
      async (form) => {
        const query = form.get('query');
        const result = await api('/bots/' + botId + '/semantic/search', { query, limit: 8 });
        return () => semanticResults(result);
      },
      'Rank',
    );
    $('#semanticconfig').onclick = () => semanticConfig(botId, config);
  }
  async function semanticResults(result) {
    $('#semanticresults').innerHTML =
      '<div class="stack">' +
      (result.matches
        .map(
          (m) =>
            '<article class="card"><h3>' +
            esc(m.name) +
            '</h3><p class="tiny muted">Score ' +
            esc(m.score) +
            ' · ' +
            esc(result.model) +
            '</p><pre class="pre">' +
            esc(m.excerpt) +
            '</pre><p class="tiny muted">Revision ' +
            esc(m.revisionId) +
            '<br>SHA-256 ' +
            esc(m.digest) +
            '</p></div>',
        )
        .join('') || '<p class="muted">No similar revisions.</p>') +
      '</div><p class="tiny muted">' +
      esc(result.method) +
      '</p>';
  }
  function semanticConfig(botId, config) {
    modal(
      'Similarity model settings',
      `<p class="tiny muted">Local mode needs no credentials. Endpoint mode sends plain extracted text to your embeddings URL; the API key is stored in the separate secret store and never shown.</p><label>Mode</label><select id="f-mode"><option value="local"${config.mode === 'local' ? ' selected' : ''}>Local token-hash similarity</option><option value="endpoint"${config.mode === 'endpoint' ? ' selected' : ''}>Neural endpoint</option></select>` +
        field('Embeddings URL (endpoint mode)', 'endpoint', config.endpoint ?? '', 'url') +
        field('Embeddings model (endpoint mode)', 'model', config.model ?? '', 'text') +
        field('API key (endpoint mode, optional)', 'apiKey', '', 'password', 'autocomplete="off"'),
      async (form) => {
        await api('/bots/' + botId + '/semantic/config', {
          mode: document.querySelector('#f-mode').value,
          ...(form.get('endpoint') ? { endpoint: form.get('endpoint') } : {}),
          ...(form.get('model') ? { model: form.get('model') } : {}),
          ...(form.get('apiKey') ? { apiKey: form.get('apiKey') } : {}),
          ...(config.revision != null ? { revision: config.revision } : {}),
        });
        toast('Similarity settings saved');
        return () => semanticOpen(botId);
      },
      'Save similarity settings',
    );
  }
  return { open };
}
