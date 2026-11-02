# Jarvis

A small local assistant that drives REA. Say `reverse engineer https://example.com` (add `and clone it`) and Jarvis will:

1. Launch a **clean, throwaway Chrome profile** (loopback DevTools only) and open the page.
2. Scroll the page while REA observes the session over CDP, then run `inspect-web-page`, `analyze-web-bundle`, and `capture-web-screenshot`.
3. Save Evidence JSON and a `report.md` to `jarvis/teardowns/<id>/`, update `index.json`, and append to long-term memory (`memory.md`).
4. With "clone": ask the model for a single-file `index.html`, save it to `clone/`, and test it in headless Chrome (no script errors, non-empty DOM).

REA itself is untouched: Jarvis calls the same CLI workflows an MCP agent would (`scripts/rea.mjs`).

## Run

```powershell
npm ci
npm run build:cached     # REA must be built; on Windows see native/windows/README.md
npm run jarvis           # http://127.0.0.1:4777
npm run jarvis:test
```

Requires Node 24+ (runs the `.ts` sources directly) and a Chrome-family browser (override with `JARVIS_CHROME`).

## Model backend (optional)

Keys come from environment variables or an optional, gitignored `jarvis/.env` (copy `jarvis/.env.example`, add `OPENAI_API_KEY=your-key`, no quotes). Nothing is committed. Note: if your checkout is in a synced folder such as Google Drive, `.env` will sync there.

| Variable | Backend |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic (default `claude-sonnet-4-5`) |
| `OPENAI_API_KEY` | OpenAI (default `gpt-4.1`) |
| `GITHUB_MODELS_TOKEN` or `GITHUB_TOKEN` | GitHub Models (needs `models:read`) |
| `JARVIS_MODEL_BACKEND` / `JARVIS_MODEL` | Force `anthropic`/`openai`/`copilot`, override the model |

Without a key, teardowns still run and produce a deterministic Evidence digest; summaries, chat and clones need a key.

## Other settings

`JARVIS_PORT` (4777), `JARVIS_CDP_PORT` (9333), `JARVIS_VAULT`, `JARVIS_HEADED=1` (visible browser), `JARVIS_OBSERVATION_MS` (12000), `JARVIS_REA_CLI`.

The UI binds to 127.0.0.1 only and rejects foreign `Host`/`Origin` headers. One job runs at a time. Only analyse sites you are permitted to analyse.
