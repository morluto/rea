# Windows ReFS Filesystem Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit fixed local ReFS volumes through REA's existing Windows native authority while preserving NTFS behavior and every current security invariant.

**Architecture:** Extend the existing native admission owner instead of creating a ReFS backend. Record the observed filesystem on native `File`/`Runtime` owners and pass it through every identity projection, while the TypeScript contract accepts only the same two values. Prove the behavior with an independent Win32 volume observer and the existing full native and Ghidra verifiers on both filesystems.

**Tech Stack:** C++17 Win32/Node-API, TypeScript/Zod/Vitest, Node.js 24.22.1, WSL Ubuntu with MinGW-w64, real Windows NTFS/ReFS volumes and Ghidra 12.1.4.

**Spec:** [spec.md](spec.md)

## Global Constraints

- Accept only fixed local `NTFS` and `ReFS` volumes reporting `FILE_PERSISTENT_ACLS`; every other filesystem fails closed.
- Preserve native ABI version `1` and the existing identity fields; only the filesystem value domain expands.
- Do not weaken path, reparse, sharing, DACL, snapshot, cancellation, ownership or cleanup checks.
- Use Node.js `24.22.1`; Windows and WSL have independent `node_modules` and work areas. Generated native artifacts remain uncommitted.
- Do not claim a check that did not run. Do not mark the PR ready for the human owner and do not merge it.

## Review Focus

- Cross-volume snapshots: source and destination must retain different observed filesystem values rather than inheriting one global value; Task 2 asserts both.
- Less visible identity producers: native inspection, `runtime_open` and Cutter bridge verification must use the same owner-recorded value; Task 2 asserts each.
- Reparse and cleanup adversarial behavior on ReFS: Task 2 keeps the existing ancestor-conversion and cleanup-escape controls intact and runs them on both volumes.
- Unsupported values and stale consumers: Task 1 rejects an unknown filesystem at the schema boundary, Task 2 keeps the native allowlist/ACL predicates, and Task 3 pins user-facing NTFS/ReFS wording.
- Generated artifacts and package identity: Task 4 verifies the manifest, package contents, clean Git state and actual ReFS CLI scenario rather than relying on compilation alone.

---

### Task 1: Filesystem identity contract

**Files:**

- Modify: `src/windows/WindowsNativeLoader.ts`
- Modify: `src/windows/WindowsNativeLoader.test.ts`

**Interfaces:**

- Consumes: the existing `WindowsNativeLoadHost` inspection fixture and `loadWindowsNativeAuthority`.
- Produces: `windowsFileIdentitySchema.filesystem` accepting exactly `"NTFS" | "ReFS"`; unsupported values produce `failureStage: "inspection"`.

- [ ] **Step 1: Prepare isolated toolchains and establish a clean baseline**

Use `nvm install 24.22.1 && nvm use 24.22.1`, then `npm ci` and `npm run check:fast` in the Windows ReFS worktree and in a separate WSL clone. Do not share `node_modules` between them. Record any pre-existing failure instead of attributing it to this change.

- [ ] **Step 2: Write the failing ReFS contract tests**

Extend the test fixture's capability overrides with `filesystem?: string`, applied to its identity. Add:

```ts
it.each(["NTFS", "ReFS"])("admits %s filesystem identities", (filesystem) => {
  const result = loadWindowsNativeAuthority(fixture({ filesystem }).host);
  expect(result).toMatchObject({
    available: true,
    authority: { inspection: { filesystem: { filesystem } } },
  });
});

it("rejects an unsupported filesystem identity", () => {
  expect(
    loadWindowsNativeAuthority(fixture({ filesystem: "exFAT" }).host),
  ).toMatchObject({ available: false, failureStage: "inspection" });
});
```

- [ ] **Step 3: Run the tests to verify the new ReFS case fails**

Run: `npm run test:focused -- src/windows/WindowsNativeLoader.test.ts`
Expected: the ReFS case fails because `z.literal("NTFS")` rejects it; NTFS and exFAT controls retain their expected outcomes.

- [ ] **Step 4: Implement the minimal schema change**

Change the field to `z.enum(["NTFS", "ReFS"])` and update its identity comment to local NTFS/ReFS objects. Do not change the ABI constants or any other schema field.

- [ ] **Step 5: Verify and commit**

Run `npm run test:focused -- src/windows/WindowsNativeLoader.test.ts` and `npm run check:fast`; expect PASS. Commit:

```bash
git add src/windows/WindowsNativeLoader.ts src/windows/WindowsNativeLoader.test.ts
git commit -m "feat(native): admit ReFS filesystem identities"
```

### Task 2: Native admission, owned identity and real-volume verification

**Files:**

- Modify: `native/windows/src/authority.hpp`
- Modify: `native/windows/src/filesystem.cc`
- Modify: `native/windows/src/process.cc`
- Modify: `tests/fixtures/windows/processBoundary.cc`
- Modify: `scripts/verify-windows-native.mjs`

**Interfaces:**

- Produces: `File.filesystem: std::wstring` and `Runtime.filesystem: std::wstring`, assigned at admission and inherited by handle-relative children.
- Produces: `napi_value identity(napi_env env, HANDLE handle, const std::wstring& path, const std::wstring& filesystem)`.
- Produces: `process-boundary.exe volume-semantics <volume-root>` returning `{"filesystem":"NTFS|ReFS|OTHER","persistentAcls":boolean}` through an independent `GetVolumeInformationByHandleW` observation.

- [ ] **Step 1: Add the independent observer and failing native assertions**

Add the `volume-semantics` command to `processBoundary.cc`. In `verify-windows-native.mjs`, require `persistentAcls === true` and compare its filesystem string with the `.filesystem` property of `sourceIdentity`, `native.inspection.filesystem`, `driveRootRuntime`, `snapshot.source`, `snapshot.snapshot`, `readback`, `snapshotOwner.observation` and the Cutter bridge identity. Record the independently observed filesystem and an `observedFilesystemIdentity` control in the report when the boundary fixture is supplied.

- [ ] **Step 2: Build the unmodified native artifact and verify the ReFS failure**

Use WSL Node 24.22.1 for `npm run build:windows-native`, and compile the fixture with:

```bash
mkdir -p .cache/windows-process-boundary
x86_64-w64-mingw32-g++ -municode -std=c++17 -O2 -static -Wall -Wextra \
  -o .cache/windows-process-boundary/process-boundary.exe \
  tests/fixtures/windows/processBoundary.cc -ladvapi32
```

Run `node scripts/verify-windows-native.mjs . .cache/windows-process-boundary/process-boundary.exe` with `TEMP` and `TMP` set to an ignored directory on ReFS. Expected: FAIL before target analysis with the original `Backing volume must be NTFS with persistent ACLs` constraint, proving the old native admission still blocks ReFS.

- [ ] **Step 3: Implement native admission and identity propagation**

In `openFile`, split the two failures into `Backing volume filesystem is outside the verified NTFS/ReFS profile` and `Backing volume does not support persistent ACLs`, then store the observed name on `File`. Replace NTFS-only path wording with fixed-local wording while leaving all other checks unchanged.

Add `filesystem` to `File` and `Runtime`. Set `Runtime.filesystem = parent->filesystem` in `createRuntime`, propagate `root.filesystem` in `runtimeDirectory`, and update every `identity` caller in `filesystem.cc` and `process.cc` to pass the owning value: open, inspection, runtime creation/open, Cutter verification, snapshot source and snapshot destination. Update NTFS-specific comments to the verified NTFS/ReFS boundary without altering cleanup behavior.

- [ ] **Step 4: Rebuild and verify ReFS, then NTFS**

Rebuild the native artifact and boundary fixture in WSL. Run `npm run verify:windows-native:artifact` and the full native verifier on ReFS; expect all existing controls plus `observedFilesystemIdentity` to pass with `filesystem: "ReFS"`.

Create a detached NTFS worktree at `C:\Users\oi\AppData\Local\Temp\rea-windows-refs-ntfs` for the same revision, install its Windows dependencies, and copy the same generated native artifact and boundary fixture into it. Run the full verifier there with `TEMP`/`TMP` on NTFS; expect `filesystem: "NTFS"` and no regression.

- [ ] **Step 5: Commit native code and its regression coverage**

```bash
git add native/windows/src/authority.hpp native/windows/src/filesystem.cc \
  native/windows/src/process.cc tests/fixtures/windows/processBoundary.cc \
  scripts/verify-windows-native.mjs
git commit -m "feat(native): support ReFS filesystem authority"
```

### Task 3: Capability declarations, diagnostics and documentation

**Files:**

- Modify: `src/windows/WindowsNativeLoader.ts`
- Modify: `src/windows/WindowsNativeLoader.test.ts`
- Modify: `src/ghidra/GhidraProviderCapabilities.ts`
- Create: `src/ghidra/GhidraProviderCapabilities.test.ts`
- Modify: `src/ghidra/GhidraDoctor.ts`
- Modify: `src/ghidra/GhidraDoctor.test.ts`
- Modify: `scripts/verify-real-ghidra-windows.mjs`
- Modify: `scripts/verify-windows-native-inspection.mjs`
- Modify: `native/windows/README.md`
- Modify: `docs/providers/windows-ghidra-p0.md`
- Modify: `docs/providers/ida-provider.md`
- Modify: `docs/getting-started/installation.md`
- Modify: `docs/guides/native/native-investigation.md`
- Modify: `docs/testing-lanes.md`

**Interfaces:**

- Produces: user-facing capability and recovery text limited to fixed local NTFS/ReFS, with no remaining NTFS-only claim in the touched Windows native/Ghidra workflows.
- Produces: the real Ghidra verifier limitation `windows-x64-local-ntfs-refs-only`.

- [ ] **Step 1: Add failing wording tests**

Assert that the loader self-test remediation contains `writable local NTFS/ReFS temporary directory`, `windowsP0Limitations` contains `local NTFS/ReFS targets and runtimes`, and a passing doctor's `native_authority` detail contains `local NTFS/ReFS only`. Keep all existing diagnostic behavior assertions unchanged.

- [ ] **Step 2: Run focused tests and confirm the old wording fails**

Run: `npm run test:focused -- src/windows/WindowsNativeLoader.test.ts src/ghidra/GhidraProviderCapabilities.test.ts src/ghidra/GhidraDoctor.test.ts`
Expected: FAIL on the NTFS-only strings.

- [ ] **Step 3: Update declarations and every owning document**

Apply the exact NTFS/ReFS wording from Step 1, update the inspection script's host/error and retained-handle comments, and replace the Ghidra report limitation. Update the listed guides to describe the same fixed-local boundary and record the independent volume-semantics observer. Do not alter NTFS MFT/USN functionality or unrelated historical specifications.

- [ ] **Step 4: Verify wording, discovery and static checks**

Run the focused tests, `npm run verify:test-discovery`, `npm run check:fast`, and a scoped search for `local NTFS`, `NTFS only`, `NTFS-only`, `fixed local NTFS` and `local-ntfs`. Expect PASS with no stale claim except the approved historical statement in `docs/specs/native/windows-refs/spec.md` and unrelated formats.

- [ ] **Step 5: Commit**

```bash
git add src/windows/WindowsNativeLoader.ts src/windows/WindowsNativeLoader.test.ts \
  src/ghidra/GhidraProviderCapabilities.ts src/ghidra/GhidraProviderCapabilities.test.ts \
  src/ghidra/GhidraDoctor.ts src/ghidra/GhidraDoctor.test.ts \
  scripts/verify-real-ghidra-windows.mjs scripts/verify-windows-native-inspection.mjs \
  native/windows/README.md docs/providers/windows-ghidra-p0.md \
  docs/providers/ida-provider.md docs/getting-started/installation.md \
  docs/guides/native/native-investigation.md docs/testing-lanes.md
git commit -m "feat(native): advertise ReFS Windows support"
```

### Task 4: Final verification and Draft PR

**Files:**

- Modify: `docs/specs/native/windows-refs/tasks.md`
- Create locally, never commit: `.cache/windows-refs-pr.md` and verification reports under `.cache/`.

**Interfaces:**

- Produces: one reviewed feature branch, a linked Draft PR, and reproducible NTFS/ReFS verification evidence. No generated binaries enter Git.

- [ ] **Step 1: Run source, documentation and package checks on the final revision**

In the independent WSL clone run `npm run check`, `npm run docs:check`, and `npm run verify:package`. On Windows run `npm run verify:test-discovery`, `npm run verify:windows-native:artifact`, `npm run verify:package:windows`, and `npm pack --dry-run`. Record actual results; investigate failures rather than weakening checks.

- [ ] **Step 2: Repeat all real Windows lanes on both filesystems at the final commit**

Build `.cache/windows-native-inspection-fixture` through WSL, then run `node scripts/verify-windows-native-inspection.mjs` with `TEMP`/`TMP` on each filesystem. Repeat the full `verify:windows-native` matrix with the independent boundary fixture.

Run `npm run verify:ghidra:windows` in each worktree with `GHIDRA_INSTALL_DIR=D:\工具\ghidra_12.1.4_PUBLIC`, `JAVA_HOME=C:\Program Files\Zulu\zulu-25`, and `TEMP`/`TMP` on the corresponding filesystem. Expect complete operation coverage, cleanup completion and `windows-x64-local-ntfs-refs-only`.

- [ ] **Step 3: Exercise the original ReFS user scenario through the source CLI**

In the ReFS worktree run `node scripts/rea.mjs analyze D:\项目\逆向分析\魔塔\TSW.exe` with `REA_ANALYSIS_PROVIDER=ghidra`, the Ghidra/Java settings above, and ReFS `TEMP`/`TMP`. Expect the original target SHA-256 `41cb9844d9bdcf2641a34d4b152d6fbbb0455077abe0e9d7bfed77761a4d2779`, a completed overview, and no snapshot-admission failure. Close the session and confirm owned runtime paths are removed.

- [ ] **Step 4: Review the final diff and synchronize upstream**

Run `git diff --check`, `git status --short`, `git diff upstream/main...HEAD`, and a generated-file sweep. Fetch `upstream/main`; if it moved, rebase this branch and rerun every affected real-world check. Update `tasks.md` to mark only completed items and commit it as `docs(native): record ReFS verification tasks`.

- [ ] **Step 5: Push and create the Draft PR**

Push `feat/windows-refs-support` to `QianNangong/rea`. Create a Draft PR to `morluto/rea:main` titled `feat(native): support ReFS filesystem authority`, linking #289 and summarizing the baseline failure, design, exact checks and remaining gaps. Use `.cache/windows-refs-pr.md` for the body and leave every human **Author readiness** declaration unchecked for the owner.

- [ ] **Step 6: Hand off for human ownership**

Ask the human owner to review the final diff and verification evidence, complete the readiness declarations themselves, and decide whether to mark the PR ready. Do not merge or represent maintainer approval as obtained.

## References

- [Windows ReFS specification](spec.md)
- [REA #289: handle-based reparse-safe filesystem authority](https://github.com/morluto/rea/issues/289)
- [Windows native build and verification guide](https://github.com/morluto/rea/blob/main/native/windows/README.md)
