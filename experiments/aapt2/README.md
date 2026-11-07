# AAPT2 resource workflow experiment

This unshipped experiment evaluates APK inspection, direct compile/link and Apktool
rebuild with a caller-selected AAPT2 binary. Public integration remains subject
to the scope decision in [CONTRIBUTING.md](../../CONTRIBUTING.md#contribution-scope).
It complements the Android roadmap (#717); split-set identity is separately
discussed in #1813.

Hardening this experiment does not promote it to a production provider. The
public surface, general caller-project admission and artifact-production
authority still need an explicit maintainer decision. No new compile, link or
rebuild CLI/MCP contracts are registered or included in the package allowlist.

## Run

```sh
npm ci
npm run build:cached
node --test experiments/command-scope.test.mjs experiments/aapt2/prototype.test.mjs
node experiments/aapt2/verify.mjs --aapt2 /tools/aapt2 --apktool /tools/apktool \
  --framework /sdk/android.jar --output /lab/aapt2-result
```

The output directory must not exist. The experiment creates resource fixtures,
compiles and links a new APK, inspects badging/resources/string pools/configurations
and compiled XML, then decodes and rebuilds a copy with Apktool. It preserves
fixture, decoded-project, framework and linked-APK identities. Result APKs are
not signed or signature-verified by this workflow. A receipt retains tool output,
selected arguments, artifact hashes and timing; failed runs keep their output.
Failure receipts retain earlier commands, bounded stdout/stderr snapshots,
exit/signal observations, truncation flags and reported cleanup diagnostics.
Compound failures retain their members without serializing live process owners
or the ambient environment. Terminal failures report the receipt path/publication
status and compact failure facts, not a second expanded copy of producer output
or Node's inspection of live cleanup capabilities.

## Ownership and failure handling

- Output admission is exclusive. Existing directories are refused without
  writing a receipt into somebody else's destination. Once a new directory is
  owned, fixture/framework preflight failures also produce a failure receipt;
  identities that were not observed are not invented.
- File hashing uses the shared descriptor owner, cancellation signal and retained
  close capabilities. Available source, framework, artifact and command facts
  survive later failures. A failed receipt write preserves the original failure
  rather than replacing it with the publication error.
- The command scope seals new admission when its callback finishes and joins
  accepted asynchronous preparation before cleanup. `SIGINT`/`SIGTERM` handlers
  remain installed through final cleanup, including repeated signals. Cleanup
  uses its own physical stop boundary rather than the cancelled caller signal.
  The first cancellation reason and independent primary/cleanup failures remain
  distinguishable; only unresolved owners are retried. Settled command failures
  remain owned even if the callback continues with later successful work or
  throws its own independent error. Successful diagnostics are not retained by
  that failure ledger; expected nonzero exits use explicit `acceptNonZeroExit`.
- SDK AAPT2 may print its version on stderr. Receipts retain the channel of each
  recognized version declaration; an unrecognized or conflicting declaration
  leaves the selected version unknown (`null`). Raw command diagnostics remain
  available independently of that interpretation.
- Apktool's existing version interpreter owns version admission and advisory
  limitations. The fixture uses the documented [2.x build protocol](https://apktool.org/docs/2.x/cli-parameters/)
  (`--use-aapt2 --aapt`) or [3.x protocol](https://apktool.org/docs/cli-parameters/)
  (`--aapt`, without the removed `--use-aapt2`). Unknown, pre-2.7 and future major
  versions are refused before compilation rather than assigned guessed flags.
- MCP connection and calls receive cancellation. Both client and transport close
  are attempted without discarding an earlier verification failure. Successful
  parity and negative-input observations survive a later finalization failure.

The tests include real OS signals during a controlled retained-owner finalizer,
in addition to cancellation of an actual owned child. Controlled cleanup outcomes
do not establish a naturally occurring OS cleanup denial or native Windows behavior.

The real automated test is opt-in and reports a named skip without prerequisites:

```sh
REA_AAPT2_PROBE_COMMAND=/tools/aapt2 \
REA_AAPT2_PROBE_FRAMEWORK=/sdk/android.jar \
REA_APKTOOL_COMMAND=/tools/apktool \
node --test experiments/command-scope.test.mjs experiments/aapt2/prototype.test.mjs
```

## Fixture verification — 2026-10-22

Linux, Node 24.18.0/npm 11.16.0, existing OpenJDK 17.0.20.1, SDK AAPT2
`2.19-10229193` and Android 35 completed the workflow with both Apktool
`2.7.0-dirty` and `3.0.3`. Each passed inspection, default/German string round
trips, malformed-resource/missing-framework refusals and existing decode CLI/MCP
parity. Source, framework, original decoded tree and linked/rebuilt artifact
identities were rechecked within each run; rebuilt APK bytes are not claimed
deterministic across runs. The real automated lane was enabled for both tools.

Before selecting the documented 3.x protocol, the real 3.0.3 producer rejected
`--use-aapt2` with exit 1. The failed run retained its command history and observed
input/artifact identities. A separate initial attempt selected a nonexistent
framework path and was refused before any producer, also with a failure receipt.

The 3.0.3 JAR was downloaded only into the local verification lab and matched the
official release's SHA-256
`dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423`.
No host tool installation/upgrade, signing, device install or APK execution was
performed. The existing version interpreter's advisory limitations remain visible
for `2.7.0-dirty`; the fixture run does not establish its patches or suitability
for untrusted APKs.

Standalone completed warm-filesystem runs, with new Node/JVM processes and output
directories, measured:

| Apktool     | Run | Elapsed (s) | CPU (s) | Sampled family RSS estimate (bytes) |
| ----------- | --- | ----------- | ------- | ----------------------------------- |
| 2.7.0-dirty | 1   | 36.58       | 42.32   | 1,296,805,888                       |
| 2.7.0-dirty | 2   | 36.25       | 41.48   | 1,269,366,784                       |
| 3.0.3       | 1   | 14.30       | 32.84   | 1,034,665,984                       |
| 3.0.3       | 2   | 14.45       | 32.31   | 1,037,520,896                       |

CPU is the completed payload's POSIX `RUSAGE_CHILDREN` delta, excluding the
observer. Memory is a 10 ms PID/start-identity-bound descendant RSS census of the
verifier, REA CLI/MCP processes and discovered children including JVMs. It excludes
the observer and unrelated workloads, can miss short-lived processes and can
double-count shared mappings; it is **not an exact kernel whole-family peak**.
Cold runs, actual agent tokens and a comparable completed pre-fix baseline are
unmeasured. Different Apktool versions and the historical cgroup run below are
not a before/after performance comparison; no speed or memory improvement is claimed.

## Historical verification

Linux with AAPT2 `2.19-10229193` (SDK build-tools 34.0.0), Android 35 framework,
Apktool `2.7.0-dirty`, OpenJDK 25.0.4.1 and Node 24.18.0 passed compile/link,
inspection and rebuilding. Default/German strings survived the round trip.
Malformed resources and missing frameworks were refused. Existing
`decode_android_resources` CLI/MCP results agreed for the generated APK.
Tests also cover output collisions and persisted failure/truncation receipts.
Cancellation waits for a marker from the actual child, authenticates its process
start identity with the run token and confirms that exact process has exited
before any fallback test cleanup.

Debian's `2.19-debian` AAPT2 rejected the Android 35 framework with an ARSC layout
error. The version prefix alone is therefore insufficient compatibility evidence;
future contracts must retain actual selected tool/framework identity.

An indicative warm-cache run took 61.19 s elapsed and 34.73 s host CPU, with a
839,786,496-byte payload-exit cgroup memory peak. Payload cleanup was verified;
final whole-scope counters were unavailable after scope exit. The observer is
included, and agent tokens are unmeasured. UI verification ran concurrently on the
same pinned CPU; cold measurements and comparative baselines are unmeasured.

## Remaining scope

These checks use controlled, resource-only fixtures, not arbitrary APKs or caller
projects. Other framework/tool versions, code-bearing or large application
preservation, signing, cross-platform execution and new public inspection/build
contracts remain unverified. General caller-project admission, resource-limit
calibration and publication semantics need the maintainer decision before
production integration. Version-based protocol selection is not proof that every
release in either major family was verified or is safe for untrusted APKs.
Passing experiment checks, CI or an author-readiness declaration does not supply
that decision. The experiment can be reviewed independently of a future public
integration; it must not be advertised as a general APK editor or production build lane.
