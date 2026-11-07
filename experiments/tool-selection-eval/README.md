# rea-tool-eval

Measures which REA MCP tool an agent picks FIRST for a natural-language task. Tools are never executed.

## Setup

```bash
npm install            # pins rea-agents in dependencies for reproducible runs
export ANTHROPIC_API_KEY=...
```

By default, the harness resolves and launches the locally installed `rea-agents` package entry point, avoiding drift from external `@latest` releases.

## Audit (no API key)

```bash
npx tsx run.ts --audit
```

Prints tool count, approximate token cost, largest definitions, and the most similar description pairs.

To evaluate an explicit REA build or pass custom server paths with spaces, set `REA_MCP_CMD` (as a quoted command string or JSON argument array):

```bash
REA_MCP_CMD='node "scripts/rea.mjs" mcp' npx tsx run.ts --audit
# Or with a JSON argument array:
REA_MCP_CMD='["node", "scripts/rea.mjs", "mcp"]' npx tsx run.ts --audit
```

## Eval

```bash
npx tsx run.ts --fixtures fixtures.example.json --trials 3 --out report.json
```

Flags:

- `--model`: Model identifier (defaults to `EVAL_MODEL` or `claude-sonnet-5-5`).
- `--trials`: Number of trials per task (positive integer, default `3`).
- `--concurrency`: Worker concurrency (positive integer, default `4`).
- `--choice`: `any` (force tool selection) or `auto` (allow text response).
- `--temperature`: Model temperature (non-negative number, default `0`).
- `--catalog`: `subset` (default) or `full`.
- `--subset-size`: Target number of tools in subset mode (positive integer, default `60`).
- `--force`: Override the 150K token safety guard for large catalogs.

## Fixture format

```json
{
  "id": "wasm-01",
  "prompt": "...",
  "expected": ["inspect_wasm_artifact"],
  "tags": ["static"]
}
```

`expected` is any-of: every listed tool counts as a correct first call. Expected names are checked against the live catalog, so a renamed tool fails loudly instead of silently scoring 0%.

## Design notes and limitations

- **First-call only**: Tasks that legitimately start with a session/setup tool must list it in `expected`.
- **Subset mode**: Presents expected tools + their 4 nearest-neighbour tools (by description Jaccard similarity) + deterministic FNV-1a filler.
  The full catalog is ~195K estimated tokens, which is why `full` refuses to run without `--force`. Subset accuracy is an upper bound on full-catalog accuracy.
- **Trial resilience**: Completed trials are written incrementally to the report as they finish. If an API request fails, failed tasks are recorded with error details and a partial report is preserved before exiting.
- **Audit & input provenance**: Reports record effective settings, fixture prompts, presented tool definitions, and stable SHA-256 hashes of ordered tools and fixtures for reliable comparisons.
- Results are nondeterministic; use `--trials` and compare pass rates, not single runs.
