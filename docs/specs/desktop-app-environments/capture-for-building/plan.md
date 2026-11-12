# Plan

1. Checkpoints: `versionAt` and `StateEnds` beside the state view's schema
   in `src/domain/desktop/desktopState.ts`, since the draft is domain code;
   `selectStateEnds` in `DesktopStateVersions.ts` turns names into positions
   and refuses under the calling operation. The export's plan, its task
   validation and the draft read every file through `versionAt`.
2. apt folders: `parseAptConfigShell` in `aptRepositories.ts` and
   `resolveAptLocations` in `AptRepositoryInventory.ts`, called once per
   Debian package with the host's folders as the fallback.
3. Launch: `applicationEnvironment` in `DesktopApplicationSession.ts` filters
   the environment the owned process is spawned with.
4. Identity: `host.hostname` and `host.user` in the capture schema and
   record; `src/domain/desktop/hostIdentity.ts` owns the matching rules, the
   replacements and the per-seed decision, used by the export and by the task
   refusal. The bundle files move to `DesktopExportFiles.ts`, which rewrites
   seeds as it copies them and writes the README last, listing them.
5. CLI options, the guides, this spec and its verification.
6. Tests first: domain rules, the seed and end scenario through the export
   and the draft, the export's scrub with a dconf database and a binary seed,
   apt folders from a stub and from real `apt-config`, the launch environment
   and the recorded host on Linux, and the CLI options; then Mousepad in the
   Ubuntu 24.04 container.
