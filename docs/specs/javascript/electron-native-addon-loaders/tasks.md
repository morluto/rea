# Tasks

- [x] Define single-feature scope, contracts, and implementation plan (`spec.md`, `plan.md`).
- [x] Implement provenance-checked static recovery for `node-gyp-build`, `bindings`, `process.dlopen`, `.asar.unpacked` rewrites, and bounded platform/arch `.node` path templates (`src/domain/javascript/electronNativeAddonLoaders.ts`).
- [x] Validate structured `ElectronNativeAddonResolution` payloads across worker schemas and projection resource accounting.
- [x] Implement artifact- and package-confined `.node` target resolution and graph `loads` / `exposes` association (`ElectronBoundaryNativeResolution.ts`, `ElectronBoundaryAnalysis.ts`, `ElectronBoundaryGraphNative.ts`).
- [x] Add unit and filesystem/ASAR boundary regression tests including `trace_application_feature` native `Evidence` correlation and `integrity_policy: "record-and-continue"` coverage.
- [x] Update `docs/guides/javascript/javascript-artifact-reconstruction.md` and `docs/specs/README.md`; pass all verification gates.
