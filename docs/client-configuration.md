# Client configuration and troubleshooting

Use this reference when a client's configuration paths, profiles, trust settings,
or schema limits affect REA. Start with [installation and setup](installation.md)
for the reviewed setup transaction and [client IDs](installation.md#supported-agents).
The versioned verification notes below describe their stated runs; live service
acceptance is verified only where explicitly recorded.

## GitHub Copilot CLI

For GitHub Copilot CLI 1.0.95, `gpt-4.1` model metadata can block ordinary
chat with REA's full input-schema profile before sending a model request
(`compaction_static_context_blocked`; [#1554](https://github.com/morluto/rea/issues/1554)).
For the native offline OpenAI-compatible BYOK adapter, full-profile chat and
analysis also passed with a distinct `COPILOT_PROVIDER_MODEL_ID` such as
`rea-gpt-4.1`, `COPILOT_PROVIDER_WIRE_MODEL=gpt-4.1`, and that distinct ID selected
through `copilot --model rea-gpt-4.1`. The local fixture requested
`COPILOT_PROVIDER_MAX_PROMPT_TOKENS=1000000`; configure the limit supported by
your backend. This keeps every full schema and the actual wire model intact.
It does not establish the effective client budget or fix the built-in-ID path.
The existing compact profile passed native chat and analysis with the complete
tool inventory on Linux using a loopback model fixture. After setup, add
`"REA_MCP_INPUT_SCHEMA_PROFILE": "compact"` to the `env` object of the
`mcpServers.rea` entry in Copilot's `mcp-config.json`, preserving its other
settings, then restart the client. Compact advertisements can reduce nested
schema constraints; REA still validates complete canonical inputs. Full-profile
`gpt-5.4` metadata is also verified locally. Live model API acceptance and
Windows remain unverified; see [native client verification](testing.md).

## Claude Code

Claude Code normally defers MCP tool definitions through tool search. It
[turns tool search off](https://code.claude.com/docs/en/mcp#configure-tool-search)
when `ANTHROPIC_BASE_URL` points to a non-first-party host, such as DeepSeek's
Anthropic-compatible endpoint. It then sends every REA tool's name, description
and input schema with every request
([#2019](https://github.com/morluto/rea/issues/2019)). On main at 04089d5be,
with 172 tools, that payload measured about 496 KB with the default profile and
about 290 KB with `compact`. By the o200k and cl100k tokenizers, that is roughly
120k and 68k tokens. Compaction cannot remove tool definitions. If they nearly
fill the window Claude Code assumes, the context refills after every compaction
and Claude Code reports that autocompact is thrashing. To avoid this:

- Make Claude Code assume the model's actual context window. DeepSeek's Claude
  Code guide selects `deepseek-flash[1m]`; the `[1m]` suffix makes Claude Code
  assume a one-million-token window. For other unrecognized model IDs, set
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the window the provider documents.
- If the endpoint forwards `tool_reference` blocks, set `ENABLE_TOOL_SEARCH=true`
  to restore deferred loading. DeepSeek's Anthropic API guide does not list
  `tool_reference` among its supported content blocks, so this setting may cause
  its requests to fail.
- To shrink the upfront catalog, add
  `"REA_MCP_INPUT_SCHEMA_PROFILE": "compact"` to the `env` object of the
  `mcpServers.rea` entry in `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json`
  when that variable is set), then restart Claude Code. Setup keeps this
  override.

The sizes above come from REA's own `tools/list`. A live Claude Code session
against DeepSeek's API is unverified.

## Pi

For [Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md),
setup writes a `type: "stdio"` entry under `mcpServers.rea` in the user-level
`~/.pi/agent/mcp.json` and installs the bundled skill under `~/.agents/skills`.
Use `rea setup --client pi --dry-run --json` to inspect the plan, then
`rea setup --client pi --yes --json` to approve it. Check the registration with
`rea doctor --client pi --json`. Pi reads `mcp.json` as strict JSON, like its
own loader: comments, trailing commas, a byte-order mark, or an empty existing
file are invalid, and setup reports them instead of rewriting the file. Repair
such a file to plain JSON first, then rerun setup.

Setup follows Pi's `PI_CODING_AGENT_DIR`: unset or empty selects the default;
`~` and `~/` expand to the home directory; absolute paths and file URLs select
that directory; relative paths stay relative to the command's working directory.
On Windows, native paths, `~\`, and Git Bash/MSYS, Cygwin, and WSL drive paths
are normalized as Pi does. Run REA and Pi from the same working directory when
using a relative override. Pi has no profiles: `OMP_PROFILE`, `PI_PROFILE`,
`PI_CONFIG_DIR`, and OMP's `enabledServers`/`disabledServers` lists do not affect
Pi registration. Doctor accepts an omitted `type` for stdio but reports a
non-stdio type as invalid; `enabled: false` stays disabled.

REA configures only the user scope. Pi also reads `.pi/mcp.json` in trusted
projects; a same-name project entry can replace the user entry or override its
enabled state and exposure. Check that file if the user registration is aligned
but unavailable in a project. An extension that registers `/mcp` can replace
Pi's built-in MCP support and use its own configuration instead. Run `/reload`
in an existing Pi session after changing servers outside the session.

## Qwen Code

For Qwen Code, setup registers `rea` in the `mcpServers` table of the
user-level `~/.qwen/settings.json`, or `$QWEN_HOME/settings.json` when configured.
Setup and doctor follow Qwen Code's tilde and working-directory-relative home
overrides. Qwen Code also discovers personal skills in `~/.agents/skills`,
where setup installs the bundled workflow.

## Gemini CLI

Gemini CLI uses `$GEMINI_CLI_HOME/.gemini/settings.json` when that home override
is nonempty, including its shared personal skills at
`$GEMINI_CLI_HOME/.agents/skills`. Setup and doctor check MCP allow/exclude
policies from system defaults, user settings, trusted workspace settings, and
system overrides. Workspace trust follows `GEMINI_CLI_TRUST_WORKSPACE`,
`GEMINI_RESTRICTED_MODE`, the effective `security.folderTrust.enabled` setting,
and the selected `trustedFolders.json` (including
`GEMINI_CLI_TRUSTED_FOLDERS_PATH`). Settings in an untrusted workspace do not
participate. A workspace or system `mcpServers.rea` replaces the entire user
entry; setup stops if the winning definition conflicts with its planned entry.
Review those files manually: setup never edits administrator/workspace settings
or grants workspace trust. Trust supplied only by a running IDE is outside this
standalone CLI check.

## Codex and Devin

Codex treats an unset or empty `CODEX_HOME` as `~/.codex`. Devin honors
`XDG_CONFIG_HOME` for its `devin/mcp_config.json` on non-Windows systems.

## OMP

For OMP, setup writes a `type: "stdio"` entry to the user-level
`~/.omp/agent/mcp.json`. It follows `PI_CONFIG_DIR` and
`PI_CODING_AGENT_DIR` (relative to the setup working directory), and the profile selected by `OMP_PROFILE` or
`PI_PROFILE` (`~/.omp/profiles/<name>/agent/mcp.json`). Setup also removes
`rea` from that file's `disabledServers` list, which would otherwise hide the
registration. Doctor treats an `enabled: false` entry as active when
`enabledServers` lists `rea`, as OMP does, unless `disabledServers` also lists
it. Run setup under each profile that should load REA.

## Hermes

For Hermes, setup writes a `mcp_servers.rea` entry to `config.yaml`, preserving
comments and unrelated settings. It resolves that file from `HERMES_HOME`, else
from the platform default Hermes itself uses — `%LOCALAPPDATA%\hermes` on
Windows, `~/.hermes` elsewhere — including any `HERMES_DATA_DIR_SUFFIX`. Hermes
connects an entry unless `enabled` is false, so setup states `enabled: true`.

Hermes personal skills install under the active Hermes home's `skills` directory.
Setup, doctor and uninstall follow the root's `active_profile` selection, as
plain Hermes CLI commands do. An explicit `HERMES_HOME` pointing to
`profiles/<name>` selects that named profile directly. An invalid, missing or
deleted sticky profile is reported instead of writing into the default home;
repair the profile or run `hermes profile use default` before retrying.
REA follows `HERMES_HOME` whitespace trimming, environment-variable expansion,
and home expansion before resolving that profile. Setup previews the resolved
configuration and skill destinations; doctor and uninstall use those same paths.

## Qoder CLI

For [Qoder](https://docs.qoder.com/cli/mcp-reference), setup writes
`mcpServers.rea` into the user-level `~/.qoder/settings.json` (the
`QODER_CONFIG_DIR` override is honored). Entries carry `command`, `args`, and
`env`; stdio is the default transport. Qoder CLI discovers personal skills
from `~/.qoder/skills` (following `QODER_CONFIG_DIR` when set), so setup
installs its skill copy there.

## Trae

For [Trae](https://docs.trae.ai/ide/add-mcp-servers), setup writes
`mcpServers.rea` into the user-scope `mcp.json` under Trae's VS Code-style
user directory (`%APPDATA%\Trae\User` on Windows,
`~/Library/Application Support/Trae/User` on macOS, and
`~/.config/Trae/User` elsewhere). Entries carry `command`, `args`, and
`env`; stdio is the default transport. Trae discovers personal skills from
`~/.trae/skills` (`%userprofile%\.trae\skills` on Windows), so setup
installs its skill copy there.

The user-level MCP paths follow the editor's VS Code layout. Trae's official
documentation describes the raw JSON editor without specifying those paths;
loading this registration in Trae remains unverified.

## ZCode

For [ZCode](https://zcode.z.ai/en/docs/mcp-services), setup registers `rea` in the nested `mcp.servers` table of the
user-level `~/.zcode/cli/config.json`. Entries carry `command`, `args`, and
`env` without a transport discriminator. ZCode discovers personal skills from
`~/.zcode/skills` rather than the shared directory, so setup installs its
skill copy there.

ZCode reads the user-scope `~/.agents/mcp.json` fallback only while the native
`.zcode` config defines no servers at all, with no merging. When setup writes
the first native server into an empty table, it copies the fallback's
`mcpServers` entries into the native table so they keep loading, and leaves
the fallback file untouched. Existing REA environment overrides are preserved
when refreshing its command. A malformed or unreadable fallback file fails setup instead of
being silently suppressed; repair or remove it and rerun. ZCode disables a
server with `enable: false` on its entry; doctor reports such a registration
as stale, and rerunning setup removes the flag to repair it. Native configuration
uses strict JSON; setup refuses comments, trailing commas and a BOM rather than
writing a registration ZCode cannot load.

## DeepSeek Harness

DeepSeek Harness registers MCP clients through a Cordis YAML patch sequence
rather than a `mcpServers` object. `rea setup --client dsh` appends (or
replaces) the REA entry in the home patch `$DSH_HOME/cordis.patch.yml`
(`~/.dsh/cordis.patch.yml` when `DSH_HOME` is unset), preserving unrelated
patches and comments. `rea doctor --client dsh` checks that same entry id.
`rea uninstall` removes it by scanning supported clients; uninstall takes no
`--client` flag. The home patch applies to every Harness profile, so the
registration is written once and no per-profile edit is needed. The written
entry is:

```yaml
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: /absolute/path/to/node
        args: ["/absolute/path/to/rea/scripts/rea.mjs", mcp]
```

Setup preserves caller-owned Cordis expressions and replaces launcher fields
with literal values that doctor can verify. It refuses to edit an expression
that produces the entire REA config, or a group-targeted REA insertion. Use a
literal config and a root-level insertion as shown above.

For a global npm installation, the launcher is under
`$(npm root -g)/rea-agents/scripts/rea.mjs`. Restart Harness after setup; it
exposes tools as `mcp__rea__<tool_name>`. Run `rea setup --skill --dry-run`,
review the destination, then `rea setup --skill --yes` to install the workflow
in `~/.agents/skills` (`$DSH_AGENTS_HOME/skills` when configured); Harness
discovers that directory, and its native `skill` tool can load
`reverse-engineer-anything`.

REA's optional [native client verification](testing.md#end-to-end-integration-and-golden-evidence)
checks headless chat, skill loading, all tool input schemas and actual analysis
using the installed Harness and a local model fixture. This establishes the
Harness integration, with live DeepSeek API compatibility remaining unverified.
See the [Harness MCP guide](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/mcp/mcp-client/README.md)
for its native configuration contract.

## Other client settings

For OpenCode, setup writes the V1 `mcp.rea` entry, which OpenCode V1 and V2
both load. If the configuration already uses OpenCode V2's native
`mcp.servers` table, setup registers REA there instead and replaces any earlier
`mcp.rea` entry from REA. Setup honors `OPENCODE_CONFIG_DIR` and
`OPENCODE_CONFIG`, preferring the later-loaded JSONC file when both JSON and
JSONC exist. The ordinary XDG global configuration still participates when a
custom directory is selected. Doctor checks the merged user registration; uninstall removes
REA-owned entries from every applicable user file so an older entry cannot
become active again. Malformed applicable files block setup before changes.

Grok Build loads `[mcp_servers.rea]` from `$GROK_HOME/config.toml`, or from
`~/.grok/config.toml` when `GROK_HOME` is unset or empty. Setup edits that server
table, `[mcp_servers.rea.env]`, and a root `disabled_mcp_servers` entry that
names `rea`. It sets `startup_timeout_sec = 30` and leaves every other name
in that list. The shared skill installed under `~/.agents/skills` is already
on Grok Build's skill path.

Grok Bot (`grok_bot`) is detected from `~/.grokbot`, or from `SAND_DATA_ROOT`
when that value is an absolute path. A relative or empty `SAND_DATA_ROOT`
stays on `~/.grokbot`. That directory is not the connector store. Grok Bot
keeps connectors in the signed-in account and runs them on its hosted
computer. It does not import `mcp.json` from the data directory, and it does
not attach a stdio server running on this machine. Setup does not call the
account connector API, does not write a registration file, and does not report
the data directory as aligned. Ask the Grok Bot chat to add a custom MCP
server named `rea` that runs on the Bot's computer:

```bash
npx -y rea-agents@<version> mcp
```

Do not put credentials in that command or its arguments. `rea doctor --client grok_bot`
reports this manual step. `rea uninstall` does not remove the account connector.
