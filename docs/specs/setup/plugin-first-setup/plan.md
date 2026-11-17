# Implementation plan

## Boundary and contract

`preferPluginSetup` in `src/application/SetupPluginHost.ts` decides whether
requested registration settings can live in a client plugin.
`PluginSetupHost` owns routing, approval gating, rechecks, cancellation and
cleanup composition. Client CLIs own marketplace state;
`SetupPluginClient` adapts Codex and Claude Code plugin commands;
`CursorLocalPlugin` owns the downloadable local Cursor installation under
`~/.cursor/plugins/local/rea`.

Shared bootstrap inventory and Cursor layout constants live in
`scripts/lib/cli-runtime-files.mjs` and `scripts/lib/cursor-plugin-bundle.mjs`.
`CursorLocalPlugin` imports those runtime values; `turbo.json` `compile.inputs`
must list both files so warm builds invalidate when the inventory or layout
changes.

`src/cli/setupCommands.ts` wires `--cursor-plugin` and computes
`preferPlugins` before `PluginSetupHost` caches a client route.

## Incremental work

1. Add plugin routing that preserves direct registrations and
   plugin-incompatible settings.
2. Prefer Codex and Claude Code marketplace plugins after plan approval.
3. Add opt-in Cursor local-plugin download, staging, validation and publication.
4. Carry cancellation and owned cleanup through mixed-client and installer
   lifetimes; retain plugin readiness advice in setup diagnostics.
5. Document operator behavior in the installation guide and keep the feature
   record current with implemented acceptance coverage.

## Effects and compatibility

Additive setup routing and an opt-in Cursor local installation path. Existing
direct integrations remain direct. No new analysis provider, target-execution
authority or ambient environment persistence is introduced.
