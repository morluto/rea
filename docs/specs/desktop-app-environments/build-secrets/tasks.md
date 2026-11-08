# Tasks

- [x] Record the outcome, requirements and non-goals.
- [x] Handles, value rules, spellings, the scan and redaction in
      `buildSecrets.ts` (secret files, export scan; `buildSecrets.test.ts`).
- [x] Read, list and keep a handle's file under the ownership and permission
      rules (secret files; `BuildSecretFiles.test.ts`).
- [x] Type a secret by its handle with `type_secret`, REA shaping its result
      and refusals (`type_secret`; `computerActions.test.ts`,
      `buildSecretsMcp.test.ts`).
- [x] Redact typed values in the action log, the witness record and every
      build tool result (action log, results and records;
      `DesktopBuildActionLog.test.ts`, `buildWitness.test.ts`,
      `buildSecretsMcp.test.ts`).
- [x] Scan the bundle for every secret before writing it, and refuse one
      that holds any (export scan; `buildSecretsMcp.test.ts`).
- [x] Document the tools, the skill and the build computer guide.
- [x] Run the KeePassXC build, export and witness on an arm64 host and record
      it in `verification.md`.
- [x] Withhold the sign-in window's files and those named: the class's
      settings, `env.toml`, the README, the draft and the task admission
      (withheld state; `appWithheld.test.ts`, `DesktopExportWithheld.test.ts`,
      `ExportedAppPython.test.ts`).
- [x] Keep withheld files as secrets on the host, supply a bundle's settings
      to its witness and record consent (withheld state, witness, consent;
      `buildWithheldMcp.test.ts`).
- [x] Preserve unmarked token-shaped values and scan declared handles.

- [x] Run the KeePassXC and Typora withheld-state builds and record them in
      `verification.md`.
- [x] Fix the review's gaps: refuse a sign-in window a walk may have missed a
      change in, and dconf keys the window changed; refuse a gzip file too
      large to check; keep each withheld file under a handle of its own; name
      settings Python takes (withheld state, export scan;
      `appWithheld.test.ts`, `DesktopExportWithheld.test.ts`,
      `DesktopBuildSecrets.test.ts`, `buildSecretsMcp.test.ts`,
      `buildWithheldMcp.test.ts`).
- [x] Match the start of a secret only before the `…` of one of REA's own
      cuts, whose lengths the producers share, and redact the app's stderr and
      the capture's progress before quoting their end (results and records;
      `buildSecrets.test.ts`, `DesktopBuildOutputRead.test.ts`).
- [ ] Follow-up: redact each typed secret before anything cuts a value, in the
      build computer's draft and the export's task checks as on the host, then
      drop the matching of a cut's start (results and records).
