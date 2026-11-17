# Plugin-first client setup

Pull request: https://github.com/morluto/rea/pull/7619

## Problem and outcome

New Codex and Claude Code integrations used only direct MCP registration and a
separate skill copy, even when those clients already own a marketplace plugin.
Cursor had no setup path that could publish a local plugin from the running
`rea-agents` release. Setup must prefer client-owned plugins when every selected
registration setting can live there, keep Cursor on the direct path by default,
and offer an explicit opt-in for a downloaded local Cursor plugin—without
changing existing direct integrations or expanding analysis authority.

[Agent plugins and marketplaces](../../../getting-started/installation.md#agent-plugins-and-marketplaces)
describes current operator-facing behavior. This directory is the feature
specification, implementation plan and task list. Installation instructions do
not replace these files.

## Requirements

1. Prefer client plugins for Codex and Claude Code when
   `preferPluginSetup` is true: skill installation remains enabled, no explicit
   skill-client destinations are selected, and no tool-family, catalog-profile,
   desktop-build or AgentEnv registration setting requires the direct path.
2. Keep `rea setup --client cursor` on direct MCP registration and skill
   installation by default. Route Cursor through the local-plugin path only when
   `--cursor-plugin` is selected, or when an already-installed matching local
   plugin is observed on an ordinary rerun.
3. Preview the exact plan and require approval before any marketplace command,
   npm download, configuration write or plugin publication. Preserve existing
   direct registrations and explicit direct, provider, Hopper and
   plugin-incompatible registration choices without invoking the plugin manager
   for those clients.
4. Defer Claude Code inventory until approval because that command can migrate
   client settings. Codex clients without plugin commands retain the Bun-capable
   direct fallback. Require a supported standalone Node only on actual plugin
   routes; do not install or upgrade Node.
5. Opt-in Cursor installation uses existing npm to download the exact running
   `rea-agents` version with lifecycle scripts disabled, stages under a private
   root, and validates shared metadata, bootstrap files, runtime, skill and icon
   before publishing to `~/.cursor/plugins/local/rea`. Preserve foreign, edited,
   linked, incomplete or differently versioned destinations with repair
   instructions.
6. Recheck plugin versus direct-registration state after approval and before
   publication. Keep Cursor's command scope alive across mixed-client marketplace
   operations; join installer cleanup before removing staging. Failed cleanup
   stays owned and retryable. Carry cancellation through discovery, approval and
   final checks; stop later writes and preserve completed effects, rollback and
   backup facts in diagnostics.
7. Retain selected client-owned plugin readiness checks in `doctor.pluginChecks`
   and include failed checks' repair advice in `remediation`. Local readiness
   verifies package and configuration, not live IDE tool availability.

## Acceptance

- Unit and host tests cover `preferPluginSetup` routing, Cursor opt-in versus
  default direct path, preservation of existing direct and plugin-incompatible
  settings, approval gating, cancellation and owned cleanup retry.
- Acceptance covers public Codex and Claude Code plugin installation after
  approval, idempotent reruns, and Cursor local-plugin setup boundaries that the
  fixture protocols can reproduce.
- Documentation under Agent plugins and marketplaces matches the implemented
  routing, approval, preservation and Cursor opt-in behavior.
- Compile cache inputs include every `scripts/lib` runtime module that
  `src/application` imports for bundled plugin values.

## Non-goals

Marketplace submission, account-level Claude plugins, Cursor Marketplace sync,
installing or upgrading Node/npm/Java/Ghidra/Homebrew, mutating analysis-provider
authority, target execution, or claiming live IDE tool availability from local
package checks.
