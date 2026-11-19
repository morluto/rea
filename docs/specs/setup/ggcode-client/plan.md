# ggcode client registration — plan

1. Define the `ggcode` client in `SupportedClients`: detection marker
   `~/.ggcode`, standalone `mcp_servers.yaml` target with the YAML-sequence
   format, `fallbackConfigPath` for the legacy in-main section, and
   `supersededConfigPath` as the seed source for a freshly created target.
2. Add `GgcodeConfigurationYaml` as the single dialect owner: strict
   sequence-only parser for the standalone file, separate legacy mapping
   parser for fallback/seeding/uninstall, server-table builder (Map-based,
   duplicates and prototype names fail closed), and a sequence editor that
   upserts/deletes one named entry while retaining comments, order, anchors,
   and alias sources (reusing `copyYamlAliasSource`).
3. Wire parse/serialize into `ClientConfigurationDocument` and add the stdio
   registration entry; layer reads as fallback < standalone with the fallback
   reporting its own source path, and mark the fallback as the writable source
   only while the standalone file is absent.
4. Normalize the explicit empty `type` to stdio in `ClientRegistrationStatus`
   and treat non-stdio types as stale, matching the other type-carrying
   dialects.
5. Seed a freshly created standalone file from `supersededConfigPath`
   (never an existing target); extend the ownership blocker to refuse setup
   and uninstall when a legacy `rea` entry from either the fallback or the
   superseded source launches another tool; allow `--tool-families` to
   override an invalid stored `REA_MCP_TOOL_FAMILIES` value.
6. Uninstall removes only the `rea` entry through the same dialect owner,
   including the legacy mapping layout.
7. Docs: installation client table, client-configuration ggcode section,
   bundled skill's supported client list.
