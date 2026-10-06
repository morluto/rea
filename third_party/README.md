# Upstream analysis engines

REA integrates existing tools through provider adapters. Upstream source remains
unmodified and retains its own license; it is not copied into REA's domain or
application code.

## jadx-headless-mcp

- Source: <https://github.com/1013503897/jadx-headless-mcp>
- Submodule: `third_party/jadx-headless-mcp`
- Release: `v0.7.1`
- Commit: `5844800a486d2248fa949b74c9896285f5b54de2`
- License: Apache-2.0; see the submodule's `LICENSE`.
- Release identity: `src/android/JadxRelease.ts`.
- REA integration: `src/android/`; no upstream patches in this version.

Fetch source for inspection with:

```sh
git submodule update --init third_party/jadx-headless-mcp
```

Normal REA builds and installed npm packages do not require this submodule or a
Gradle build. Supply a separately obtained JAR with `REA_JADX_MCP_JAR`; REA never
downloads engines during an analysis operation. The audited release JAR is
identified by SHA-256. A caller-supplied build reporting the supported protocol
version retains its actual digest and an unknown source revision unless its
bytes match the audited release.

When updating: review upstream protocol and license changes, update the gitlink
and release identity together, exercise the adapter's producer regressions, and
run the real APK CLI/MCP lane. Never attribute modified engine bytes to the
audited source revision.

## Public APK fixture

`scripts/fetch-android-fixtures.mjs` explicitly downloads the audited engine and
Appium ApiDemos v6.0.18 into ignored `_reference/apk-integration/`. Both downloads
are checked against fixed SHA-256 values. Fixture provenance is recorded in
`scripts/fixtures/android-apidemos.json`; the source uses Apache-2.0. This is a
static analysis fixture: no emulator, device, SDK installation or app execution
is needed. APKs and JARs are neither tracked nor included in npm packages.
