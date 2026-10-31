export function learningUI(ctx) {
  const { $, api, esc, modal, field, area, action, close, toast } = ctx;
  async function open() {
    const botId = ctx.botId(),
      bot = ctx.state().bots.find((value) => value.id === botId);
    if (!bot) return toast('Select a Bot first.');
    const recipes = await api('/bots/' + botId + '/recipes');
    modal(
      'Taught tasks',
      '<p>Teach a reusable checklist in your own words, optionally referencing a completed task. This does not record your browser or grant new permissions.</p>' +
        (bot.accessRole === 'owner'
          ? '<button type="button" id="teachnew">Teach a task</button>'
          : '') +
        '<div class="stack">' +
        recipes
          .map(
            (recipe) =>
              '<article class="card"><h3>' +
              esc(recipe.title) +
              '</h3><p>' +
              esc(recipe.whenToUse) +
              '</p><p class="tiny muted">Revision ' +
              recipe.revision +
              ' - ' +
              (recipe.enabled ? 'Enabled' : 'Disabled') +
              '</p><details><summary>Instructions</summary><pre class="pre">' +
              esc(recipe.instructions) +
              '</pre></details><div class="row wrap">' +
              (recipe.enabled && bot.accessRole !== 'viewer'
                ? '<button type="button" data-recipe-run="' + recipe.id + '">Run task</button>'
                : '') +
              (bot.accessRole === 'owner'
                ? '<button type="button" data-recipe-edit="' +
                  recipe.id +
                  '">Edit</button><button type="button" data-recipe-export="' +
                  recipe.id +
                  '">Export template</button>'
                : '') +
              '</div></article>',
          )
          .join('') +
        '</div>',
    );
    $('#teachnew')?.addEventListener('click', () => edit(botId));
    document.querySelectorAll('[data-recipe-edit]').forEach(
      (button) =>
        (button.onclick = () =>
          edit(
            botId,
            recipes.find((value) => value.id === button.dataset.recipeEdit),
          )),
    );
    document.querySelectorAll('[data-recipe-export]').forEach(
      (button) =>
        (button.onclick = () => {
          const recipe = recipes.find((value) => value.id === button.dataset.recipeExport);
          const blob = new Blob(
            [
              JSON.stringify(
                {
                  schemaVersion: 1,
                  title: recipe.title,
                  whenToUse: recipe.whenToUse,
                  instructions: recipe.instructions,
                },
                null,
                2,
              ),
            ],
            { type: 'application/json' },
          );
          const url = URL.createObjectURL(blob),
            link = document.createElement('a');
          link.href = url;
          link.download = 'orbit-taught-task.json';
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }),
    );
    document.querySelectorAll('[data-recipe-run]').forEach(
      (button) =>
        (button.onclick = () => {
          const recipe = recipes.find((value) => value.id === button.dataset.recipeRun);
          modal(
            'Run ' + recipe.title,
            area('Input for this run', 'input'),
            async (form) => {
              const conversationId = ctx.conversationId();
              if (!conversationId) throw Error('Open a conversation first.');
              await api('/bots/' + botId + '/recipes/' + recipe.id + '/run', {
                conversationId,
                nonce: crypto.randomUUID(),
                revision: recipe.revision,
                input: form.get('input'),
              });
              toast('Task accepted. Results will appear in the conversation.');
            },
            'Run taught task',
          );
        }),
    );
  }
  function edit(botId, recipe = null) {
    const examples = (ctx.overview().runs ?? [])
      .filter((run) => run.state === 'settled' && !run.hostAction)
      .slice(-20);
    modal(
      recipe ? 'Edit taught task' : 'Teach a task',
      field('Task name', 'title', recipe?.title ?? '', 'text', 'required') +
        area('When should this be used?', 'whenToUse', recipe?.whenToUse ?? '') +
        area('Steps, checks and expected output', 'instructions', recipe?.instructions ?? '') +
        '<label for="recipeexample">Completed example (optional)</label><select id="recipeexample" name="exampleRunId"><option value="">No example</option>' +
        examples
          .map(
            (run) =>
              '<option value="' +
              run.id +
              '" ' +
              (recipe?.exampleRunId === run.id ? 'selected' : '') +
              '>' +
              esc(run.text.slice(0, 90)) +
              '</option>',
          )
          .join('') +
        '</select><label class="check"><input type="checkbox" name="enabled" ' +
        (!recipe || recipe.enabled ? 'checked' : '') +
        '>Enabled</label>' +
        '<p class="tiny muted">Only your instructions and example milestone references are saved. Credentials, private tool arguments and conversation history are not copied into the template. Review your instructions before exporting.</p>',
      async (form) => {
        await api('/bots/' + botId + '/recipes' + (recipe ? '/' + recipe.id : ''), {
          title: form.get('title'),
          whenToUse: form.get('whenToUse'),
          instructions: form.get('instructions'),
          exampleRunId: form.get('exampleRunId') || null,
          enabled: form.has('enabled'),
          ...(recipe ? { revision: recipe.revision } : {}),
        });
        return open;
      },
      'Save taught task',
    );
  }
  return { open };
}
