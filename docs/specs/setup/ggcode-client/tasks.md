# ggcode client registration — tasks

- [x] `SupportedClients`: ggcode definition (detection, standalone sequence
      format, fallback + superseded paths, no home override).
- [x] `GgcodeConfigurationYaml`: strict standalone parser, legacy mapping
      parser, server table, sequence editor with formatting/comment/anchor
      and alias-source preservation.
- [x] `ClientConfigurationDocument`: parse/serialize wiring, stdio entry,
      fallback layering and source-path reporting.
- [x] `ClientRegistrationStatus`: empty `type` -> stdio normalization;
      non-stdio stale handling.
- [x] `SetupClientConfiguration`: superseded seeding (never reseed),
      fallback + superseded ownership refusal, tool-families override of
      invalid stored env values.
- [x] `Uninstall`: remove only the `rea` entry across both layouts.
- [x] Alias and ownership hardening from review: aliased names in edit and
      unnamed gates, shared `copyYamlAliasSource` reuse, superseded-source
      ownership check.
- [x] Skill destination `~/.ggcode/skills` in the bundled skill's supported
      client list.
- [x] Boundary and application suites (see spec acceptance); docs updates
      (installation client table, client-configuration section).

Retrospective notes are intentionally omitted; the pull request and its
review threads carry the discussion record.
