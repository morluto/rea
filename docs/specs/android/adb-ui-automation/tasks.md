# Android UI tasks and verification

Recorded during review on 2026-11-14. Checked implementation items describe the
current source and controlled tests, not real-device certification or historical
maintainer approval.

## Implemented boundaries

- [x] R1–R2: bind observation tools to the shared ADB service while leaving runner
      installation/lifetime with the operator and the action contract unregistered.
- [x] R3–R4: validate complete runner/snapshot/node scope, caller-selected IDs,
      retained freshness and coverage across normal and recovered observations.
- [x] R5: private request-body transport, documented text exclusions, fixed
      protocol/capture allowances and actionable capacity recovery.
- [x] R6: device serialization, separate local-probe ownership, cancellation
      during final acknowledgement, retained cleanup and lost-acknowledgement retry.
- [x] R7: classify only validated action reports as known; retain unknown-outcome
      warnings and replay gates for invalid or response-less completions.

## Executed local validation in this review

- [x] 229 focused ADB provider, UI and launcher tests passed after merging main.
- [x] Final 112 UI and function-detail boundary tests passed after adopting
      upstream recovery and schema ownership.
- [x] `npm run check:fast` and `npm run docs:check` passed for that merged runtime.
- [x] Experiment-owner follow-ups passed four Vitest runner cases, fast checks,
      test discovery, documentation checks and production-site route verification.
- [ ] Confirm exact-head CI and inspect new automated or human findings after
      the final push. Keep monitoring after green rather than treating it as approval.

## Remaining independent evidence and decisions

- [ ] R1, R3–R7: rerun real Android runner/fixture workflows with recorded device,
      SDK, runner instance/version and actual observation/mutation scope.
- [ ] R5–R6: rerun native Windows/macOS launch, preparation and cleanup scenarios.
      Simulated native-boundary controls do not establish real-host behavior.
- [ ] Obtain and link the maintainer scope decision and required verification
      before any public action registration, distribution or authority expansion.
- [ ] Human owner reviews and owns the final diff and validation limitations.
      An agent must not complete the author's readiness declaration on their behalf.

Commands and workflow details belong to the
[usage guide](../../../guides/android/adb-ui-automation.md) and
[development testing guide](../../../development/testing.md), not a duplicated
provider-verification claim here.
