# Does diagonal movement make the player faster?

In Relay garden's movement primitive, full diagonal input and full straight input
cover the same distance away from the world edges. REA locates the calculation in
minified JavaScript; reading those bytes explains the rule, and executable
comparisons check a separate implementation.

This is a controlled, self-authored example. The same project authored the
reference and the playable game; the original implementing agent knew the target.
It is not a blind evaluation or a reconstruction of a commercial game.

[Play the example](https://thedesignfounder.github.io/dreamlayer-game-assets/demo/)
· [Source](https://github.com/TheDesignFounder/dreamlayer-game-assets)
· [How it was made](https://dreamlayer.io/blog/rea-game-assets)
· [Gameplay recording](https://github.com/user-attachments/assets/155db219-8f74-47af-9079-94cac8a6d77e)
· [Recorded investigation](https://github.com/user-attachments/assets/6a79bb7e-a246-4a77-b272-339116e5dd93)
· [Recording transcript](https://github.com/TheDesignFounder/dreamlayer-game-assets/releases/download/relay-garden-videos-20261016/rea-investigation-transcript.md)

## Prepare the reference

The checkpoint below pins REA 6.5.0 and esbuild 0.25.12. Use Node.js 22.19 or newer
on the 22.x line. No native analysis engine is needed.

```sh
git clone https://github.com/TheDesignFounder/dreamlayer-game-assets.git
cd dreamlayer-game-assets
git checkout b0627c520c61df13ae81ac08f42fbc197edfdccf
npm ci
```

The analysis target is `reference/artifact/`, containing a small HTML page and
`game.min.js`, with no source map. Editable reference source is outside that
directory. The [target record](https://github.com/TheDesignFounder/dreamlayer-game-assets/blob/b0627c520c61df13ae81ac08f42fbc197edfdccf/reference/target.json)
identifies its self-authored origin, MIT license and build procedure.

`game.min.js` SHA-256:
`d454ffb5bd82c40d69f414b2520d3752b1f0911abd12f176c3216ff99017b7a1`.
The directory's REA root digest is different because it also includes `index.html`.

## Ask one question

With REA connected to your coding agent, an example prompt is:

> Use REA to inspect reference/artifact in this repository. Does diagonal input
> change movement speed, and what happens after a long frame? Show the source
> range and caller evidence. Separate what REA returns from your interpretation,
> and keep unresolved facts visible.

For the recorded MCP run, the agent used a local SDK client connected to the
project's installed server with `node node_modules/rea-agents/scripts/rea.mjs mcp`.
This did not modify agent registration. See [installation](installation.md) for
your client's setup. A skill installation alone does not connect a server.

Call `analyze_javascript_application` with:

```json
{
  "input_path": "/absolute/path/to/dreamlayer-game-assets/reference/artifact",
  "detail": "complete"
}
```

The path above is a placeholder; replace it with your checkout's absolute path.
The returned `normalized_result.semantic_graph.nodes` contains a property-read
node whose `properties.property_path` includes `hypot`. Its `function_node_id`
identifies function `i`, with source range line 1, columns 0–188. These coordinates
use one-based lines, zero-based columns and an exclusive end.

Keep that analysis in the same MCP connection. To trace the function's callers,
pass the returned Evidence ID and function node ID:

```json
{
  "application": {
    "kind": "retained-evidence",
    "evidence_id": "ev_REPLACE_WITH_ANALYSIS_ID"
  },
  "query": {
    "seed": {
      "kind": "semantic-node",
      "node_id": "jsrg_node_REPLACE_WITH_FUNCTION_ID"
    },
    "direction": "callers"
  }
}
```

The placeholders are intentionally not valid IDs. Use the actual response values;
the [recorded exchanges](relay-garden-verification.md) show this run's values.
`trace_javascript_semantics` returned `status: "found"`, two traversed nodes, one
caller relation and eight relevant unknowns. Retained references avoid resending
the complete analysis. They belong to the live server connection.

A control query using `seed: {"kind": "literal", "value": 180}` and direction
`callers` returned no seed match with partial coverage. That did not prove the
constant was absent. Reading the function range provided the useful next step.

## Interpret the returned source range

These are the exact selected bytes from `game.min.js`:

```text
function i(s,e,t){let n=Math.hypot(e.x,e.y),r=Math.max(1,n),o=Math.max(0,Math.min(t,.05));return{x:Math.max(16,Math.min(944,s.x+e.x/r*180*o)),y:Math.max(16,Math.min(524,s.y+e.y/r*180*o))}}
```

The agent reads this as:

```text
divisor = max(1, hypot(input.x, input.y))
elapsed = clamp(seconds, 0, 0.05)
x = clamp(x + input.x / divisor * 180 * elapsed, 16, 944)
y = clamp(y + input.y / divisor * 180 * elapsed, 16, 524)
```

For finite numeric inputs, the input vector is normalized only when its length
exceeds one. A smaller analog input retains its strength. A long frame advances
at most 0.05 seconds of movement. Position is then clamped to the world bounds.
These arithmetic conclusions come from reading the bytes; REA's static graph does
not prove them or execute the target.

## Compare with the original artifact

Run the existing CLI recipe and tests from the project directory:

```sh
npm run investigate
npm test
npm run validate:assets
```

The investigation script verifies the target digest, analyzes the artifact,
selects the function from REA's returned graph and traces its callers. Its public
CLI operations are:

```sh
npx --no-install rea-agents analyze-javascript-application "$PWD/reference/artifact" --json
npx --no-install rea-agents trace-javascript-semantics "$PWD/.local/trace-request.json" --json
```

`npm run investigate` creates `.local/trace-request.json`, supplying the complete
analysis Evidence inline because the CLI commands use separate processes. Full
unmodified records remain in `.local/`. The script also refreshes the project's
public excerpt; this is labeled as an excerpt, not an importable Evidence record.

Eight Node tests passed in the verification run, including 2,000 deterministic
comparisons of `demo/mechanics.js` with the artifact's `advance` export. Additional
checks exercise world bounds and negative, long and analog inputs. From a point
away from the world edges:

| Input                    | Elapsed time | Distance moved |
| ------------------------ | ------------ | -------------- |
| Full right               | 0.05 seconds | 9 pixels       |
| Full right and down      | 0.05 seconds | 9 pixels       |
| Half right               | 0.05 seconds | 4.5 pixels     |
| Full right after a stall | 2 seconds    | 9 pixels       |

The test runner executes the self-authored artifact and reconstruction. The REA
analysis itself is static. These finite comparisons do not prove equivalence for
every JavaScript value, and obstacle sliding and later game rules are outside the
recovered movement primitive.

## Add artwork while keeping the rule

DreamLayer generated the example's courtyard and matching object sheet, then
removed the sheet's background. An import script cropped the objects and added
transparent padding. These are new images; REA's investigation concerns movement.
The renderer keeps the player's logical collision radius independent of the image
dimensions. Drones, shields, collectibles and the time limit are new game design.

Run `npm start`, open <http://127.0.0.1:4177/demo/>, and use the arrow keys or
on-screen controls. Pause and switch between Artwork and Geometry: the position,
collected cells and time stay the same. Stop the server with `Ctrl+C`.

Playing with bundled images needs no account or API key. Creating new images is
an optional external workflow requiring DreamLayer credentials and credits. The
[asset workflow](https://github.com/TheDesignFounder/dreamlayer-game-assets/blob/b0627c520c61df13ae81ac08f42fbc197edfdccf/docs/asset-workflow.md)
and [generation records](https://github.com/TheDesignFounder/dreamlayer-game-assets/blob/b0627c520c61df13ae81ac08f42fbc197edfdccf/assets/generation-records.json)
document preparation, provenance and cost. No generation is needed to repeat this
case.

## Verification scope

See the [verification record](relay-garden-verification.md) for the MCP exchanges,
CLI results, tested environment, resource measurements, cleanup and limitations.
The 30-second video shows gameplay. The separate 86-second investigation video
follows a prepared sequence using real MCP calls and test output; it is a guided
repeat, not an autonomous investigation. The closing promotional note is omitted
from this edit; tool output and timing are unchanged. This is a bounded additional example for [#778](https://github.com/morluto/rea/issues/778);
it does not complete that issue's demo portfolio or replace its starter work in
[#1704](https://github.com/morluto/rea/pull/1704).
