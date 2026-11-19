# ggcode client registration

## Problem and outcome

ggcode reads MCP servers from `~/.ggcode/mcp_servers.yaml`, a top-level YAML
sequence of named entries (`- name: rea` with `type` / `command` / `args` /
`env`; an empty `type` connects as stdio). It migrates a legacy
`mcp_servers` section of the main `~/.ggcode/ggcode.yaml` into that
standalone file and honors the section only while the file is absent.
Previously `rea setup` and `rea doctor` had no dialect for this format, so
ggcode users had to hand-register REA.

After this feature, `npx rea-agents setup` (or `rea setup --client ggcode`)
detects ggcode from `~/.ggcode`, registers the `rea` stdio server in the
standalone file, and reports aligned/stale/missing in doctor like every
other supported client, with the same plan-approve-apply flow and backups.

## Requirements

- `SupportedClients` defines `ggcode` with the standalone YAML-sequence
  format. `~/.ggcode/ggcode.yaml` is a lower-precedence fallback read layer
  (a legacy in-main registration reports correctly) and, via
  `supersededConfigPath`, the seed source for a freshly created standalone
  file. An existing standalone target is never reseeded, so a deleted entry
  cannot resurrect from the inert legacy section. ggcode has no home-directory
  override.
- `GgcodeConfigurationYaml` owns the dialect: it parses the standalone
  sequence layout strictly (a mapping root is unreadable) and the legacy
  mapping layout only through the fallback/superseded/uninstall paths, builds
  the synthetic `mcp_servers` server table, and upserts/deletes one named
  sequence entry while retaining formatting, order, comments, and alias
  sources. Aliased names (`name: *anchor`) resolve through the same boundary
  the editors use; aliased names are not unnamed entries. Malformed items,
  duplicate server names, and prototypes (`__proto__`) fail closed.
- Ownership: a legacy `rea` entry that launches another tool blocks setup and
  uninstall (`registration_ownership`) whether it is reachable through the
  fallback layer or the superseded seed source.
- `ClientRegistrationStatus` normalizes ggcode's explicit empty `type` to
  stdio before alignment checks; a non-stdio `type` is stale/invalid like the
  other type-carrying dialects. Doctor reports the file a fallback-layer
  registration was actually read from.
- Stored-configuration validation cannot permanently block repair: an invalid
  legacy `REA_MCP_TOOL_FAMILIES` value is overridable by
  `rea setup --tool-families` rather than failing before the override applies.
- Skill installs to `~/.ggcode/skills`, which ggcode discovers (it also reads
  the shared `~/.agents/skills` destination).
- REA only ever writes the standalone `~/.ggcode/mcp_servers.yaml` (with a
  `.rea.backup` recovery backup); it never writes `~/.ggcode/ggcode.yaml`.
  Uninstall removes only the `rea` entry.

## Acceptance

`tests/boundary/filesystem/ggcodeClientConfiguration.test.ts` and the
application-layer `GgcodeConfigurationYaml` / `SetupClientConfiguration` /
`Uninstall` suites cover: standalone sequence parse/serialize with comments,
order, anchors, and alias preservation; strict rejection of mapping roots in
the standalone file; legacy fallback and superseded seeding (including env
retention, unnamed-entry refusal, and never-reseed); duplicate and
`__proto__` names; aliased names in edit and setup gates; empty-`type`
normalization; ownership refusal from both fallback and superseded sources;
fallback source-path reporting in doctor; tool-families override of invalid
stored values; and uninstall removing only `rea`.

## Out of scope

Writing to `~/.ggcode/ggcode.yaml`, and real-client verification beyond the
local run described in the pull request.
