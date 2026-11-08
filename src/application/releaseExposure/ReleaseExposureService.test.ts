import { describe, expect, it, vi } from "vitest";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import {
  describeElectronFuseFindings,
  electronFuseName,
  electronFuseState,
  ELECTRON_FUSE_STATE_BYTES,
  type ElectronFuseSlice,
} from "../../domain/electron/electronFuses.js";
import type { GoBinary } from "../../domain/go/goBinary.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { RELEASE_EXPOSURE_PROVIDER } from "../../domain/investigationProviders.js";
import {
  PACKAGED_NATIVE_IMAGES,
  RELEASE_EXPOSURE_CHECK_IDS,
  releaseExposureReportSchema,
  type ReleaseExposureScan,
} from "../../domain/releaseExposure.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { ReleaseExposurePort } from "./ReleaseExposurePort.js";
import { ReleaseExposureService } from "./ReleaseExposureService.js";

const SHA = "ab".repeat(32);

const scan = (
  overrides: Partial<ReleaseExposureScan> = {},
): ReleaseExposureScan => ({
  target: {
    selected_path: "/work/app",
    kind: "file",
    format: "file",
    sha256: SHA,
  },
  subject: { path: "/work/app", sha256: SHA, format: "file" },
  native_images: [],
  fuse_candidates: [],
  source_maps: {
    embedded: 0,
    without_sources: 0,
    unparsed: 0,
    skipped: 0,
    samples: [],
  },
  extractable: {
    formats: [],
    readable_members: 0,
    unreadable_members: 0,
    samples: [],
  },
  debug_companions: { paths: [], skipped: 0 },
  pdb: { examined: 0, paths: [], failed: 0 },
  text_members: { scanned: 0, skipped: 0 },
  coverage: "complete",
  omitted: [],
  limitations: [],
  ...overrides,
});

const evidence = (result: unknown) =>
  createEvidence(
    { path: "/work/app", sha256: SHA, format: "file" },
    RELEASE_EXPOSURE_PROVIDER,
    {
      operation: "audit_release_exposure",
      parameters: {},
      result,
      confidence: "observed",
    },
  );

type OwnerInspect = (
  input: unknown,
  options?: ExecutionOptions,
) => Promise<Result<Evidence, AnalysisError>>;

const owners = (
  scanned: ReleaseExposureScan,
  textMembers: readonly (readonly [string, string])[] = [],
  interruption?: AnalysisError,
) => {
  const desktop = {
    inspect: vi.fn<OwnerInspect>(async () =>
      ok(evidence(nativeDesktopReport())),
    ),
    close: vi.fn(async () => undefined),
  };
  const electronFuses = {
    inspect: vi.fn<OwnerInspect>(async () =>
      err(
        new AnalysisUnsupportedTargetError(
          "inspect_electron_fuses",
          "/work/app",
          "unsupported",
        ),
      ),
    ),
    close: vi.fn(async () => undefined),
  };
  const goBinaries = {
    inspect: vi.fn<OwnerInspect>(async () =>
      err(
        new AnalysisUnsupportedTargetError(
          "inspect_go_binary",
          "/work/app",
          "unsupported",
        ),
      ),
    ),
    close: vi.fn(async () => undefined),
  };
  const rustBinaries = {
    inspect: vi.fn<OwnerInspect>(async () =>
      err(
        new AnalysisUnsupportedTargetError(
          "inspect_rust_binary",
          "/work/app",
          "unsupported",
        ),
      ),
    ),
    close: vi.fn(async () => undefined),
  };
  const service = new ReleaseExposureService({
    reader: {
      identity: RELEASE_EXPOSURE_PROVIDER,
      inspect: vi.fn<ReleaseExposurePort["inspect"]>(
        async (_input, _options, visitText, visitInterruptedScan) => {
          for (const [text, location] of textMembers) visitText(text, location);
          if (interruption === undefined) return ok(scanned);
          visitInterruptedScan?.(scanned);
          return err(interruption);
        },
      ),
      close: vi.fn(async () => undefined),
    },
    desktop,
    electronFuses,
    goBinaries,
    rustBinaries,
  });
  return { service, desktop, electronFuses, goBinaries, rustBinaries };
};

describe("ReleaseExposureService", () => {
  it("keeps one owner failure on that check", async () => {
    const { service, desktop, goBinaries, rustBinaries } = owners(
      scan({
        target: {
          selected_path: "/work/tree",
          kind: "directory",
          format: "directory",
          sha256: null,
        },
        subject: { path: "/work/tree", sha256: SHA, format: "directory" },
        native_images: [{ path: "/work/tree/app", format: "elf" }],
      }),
    );
    desktop.inspect.mockResolvedValue(
      err(new AnalysisInputError("inspect_desktop_application")),
    );
    goBinaries.inspect.mockResolvedValue(
      err(
        new AnalysisUnsupportedTargetError(
          "inspect_go_binary",
          "/work/tree/app",
          "not a Go binary",
        ),
      ),
    );
    rustBinaries.inspect.mockResolvedValue(
      err(new AnalysisInputError("inspect_rust_binary")),
    );
    const result = await service.inspect({ path: "/work/tree" });
    if (!result.ok) throw result.error;
    const report = result.value.normalized_result as {
      checks: {
        id: string;
        status: string;
        observation: { samples: string[] };
      }[];
    };
    expect(report.checks.map((check) => check.id)).toEqual([
      ...RELEASE_EXPOSURE_CHECK_IDS,
    ]);
    expect(
      report.checks.find((check) => check.id === "go.build_paths")?.status,
    ).toBe("not_applicable");
    expect(
      report.checks.find((check) => check.id === "rust.dependency_metadata")
        ?.status,
    ).toBe("unknown");
    expect(
      report.checks.find((check) => check.id === "electron.run_as_node")
        ?.status,
    ).toBe("unknown");
    expect(
      report.checks.find((check) => check.id === "electron.run_as_node")
        ?.observation.samples,
    ).toContain("Invalid analysis input for inspect_desktop_application");
    await service.close();
  });

  it("propagates cancellation and skips later owners", async () => {
    const { service, electronFuses, goBinaries } = owners(
      scan({
        fuse_candidates: [{ path: "/work/app", role: "native-image" }],
        native_images: [{ path: "/work/app", format: "elf" }],
      }),
    );
    electronFuses.inspect.mockResolvedValue(
      err(new AnalysisCancelledError("inspect_electron_fuses")),
    );
    const result = await service.inspect({ path: "/work/app" });
    if (result.ok) throw new Error("Expected a failed audit.");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(goBinaries.inspect).not.toHaveBeenCalled();
  });

  it("treats a universal Mach-O as unknown metadata without calling the readers", async () => {
    const { service, goBinaries, rustBinaries } = owners(
      scan({
        native_images: [{ path: "/work/app", format: "mach-o-universal" }],
      }),
    );
    const result = await service.inspect({ path: "/work/app" });
    if (!result.ok) throw result.error;
    const report = result.value.normalized_result as {
      checks: {
        id: string;
        status: string;
        observation: { samples: string[] };
      }[];
    };
    expect(
      report.checks.find((check) => check.id === "go.build_paths")?.status,
    ).toBe("unknown");
    expect(
      report.checks.find((check) => check.id === "go.build_paths")?.observation
        .samples,
    ).toContain("universal Mach-O needs an architecture");
    expect(goBinaries.inspect).not.toHaveBeenCalled();
    expect(rustBinaries.inspect).not.toHaveBeenCalled();
  });
});

describe("ReleaseExposureService cancellation", () => {
  it("keeps completed facts when a later owner is cancelled", async () => {
    const reason = new Error("caller stopped");
    const { service, electronFuses, goBinaries, rustBinaries } = owners(
      scan({
        source_maps: {
          embedded: 1,
          without_sources: 0,
          unparsed: 0,
          skipped: 0,
          samples: ["/work/app.js.map"],
        },
        fuse_candidates: [{ path: "/work/app", role: "native-image" }],
        native_images: [
          { path: "/work/app", format: "elf" },
          { path: "/work/helper", format: "elf" },
        ],
      }),
    );
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    goBinaries.inspect.mockResolvedValue(
      err(
        new AnalysisCancelledError("inspect_go_binary", {
          cause: reason,
        }),
      ),
    );
    const result = await service.inspect({ path: "/work/app" });
    if (result.ok) throw new Error("Expected a failed audit.");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(goBinaries.inspect).toHaveBeenCalledTimes(1);
    expect(rustBinaries.inspect).not.toHaveBeenCalled();
    const partial = result.error.partialObservation as Evidence;
    const report = releaseExposureReportSchema.parse(partial.normalized_result);
    const status = (id: string) =>
      report.checks.find((check) => check.id === id)?.status;
    expect(status("javascript.source_map_sources")).toBe("exposed");
    expect(status("electron.run_as_node")).toBe("not_observed");
    expect(status("go.build_paths")).toBe("unknown");
    expect(status("rust.dependency_metadata")).toBe("unknown");
  });
});

describe("ReleaseExposureService cancellation partials", () => {
  it("reports the audit, not an owner's own partial Evidence", async () => {
    const reason = new Error("caller stopped");
    const { service, goBinaries } = owners(
      scan({ native_images: [{ path: "/work/app", format: "elf" }] }),
    );
    goBinaries.inspect.mockResolvedValue(
      err(
        new AnalysisCancelledError("inspect_go_binary", {
          cause: reason,
          partialObservation: evidence({ owner: "go" }),
        }),
      ),
    );
    const result = await service.inspect({ path: "/work/app" });
    if (result.ok) throw new Error("Expected a failed audit.");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("cancelled");
    expect(
      releaseExposureReportSchema.parse(
        (result.error.partialObservation as Evidence).normalized_result,
      ).limitations,
    ).toEqual(expect.arrayContaining([expect.stringContaining("cancelled")]));
    expect(JSON.stringify(projected)).toContain("javascript.source_maps");
  });
});

describe("ReleaseExposureService unfinished owner cleanup", () => {
  const unfinished = (operation: string) =>
    new ProviderCleanupError(
      "rea-owner",
      ["/work/app/descriptor"],
      { reason: "EPERM" },
      { operation },
    );
  const audit = async (result: Awaited<ReturnType<OwnerInspect>>) => {
    if (result.ok) throw new Error("Expected a failed audit.");
    return releaseExposureReportSchema.parse(
      (result.error.partialObservation as Evidence).normalized_result,
    );
  };

  it("keeps the findings of a member scan stopped by unfinished cleanup", async () => {
    const failure = unfinished("inspect_release_exposure");
    const { service, desktop, goBinaries } = owners(
      scan({
        coverage: "unknown",
        native_images: [{ path: "/work/app", format: "elf" }],
        source_maps: {
          embedded: 1,
          without_sources: 0,
          unparsed: 0,
          skipped: 0,
          samples: ["/work/app.js.map"],
          embedded_paths: ["/work/app.js.map"],
          plain_paths: [],
        },
      }),
      [["-----BEGIN PRIVATE KEY-----\n", "/work/app.pem"]],
      failure,
    );
    const result = await service.inspect({ path: "/work/app" });
    expect(result).toMatchObject({ ok: false, error: failure });
    expect(failure.cleanupIncomplete).toBe(true);
    expect(desktop.inspect).not.toHaveBeenCalled();
    expect(goBinaries.inspect).not.toHaveBeenCalled();
    const report = await audit(result);
    const status = (id: string) =>
      report.checks.find((check) => check.id === id)?.status;
    expect(status("javascript.source_map_sources")).toBe("exposed");
    expect(status("text.credential_markers")).toBe("exposed");
    expect(status("go.build_paths")).toBe("unknown");
  });

  it("returns a Go failure with the partial audit and runs no later owner", async () => {
    const { service, goBinaries, rustBinaries } = owners(
      scan({ native_images: [{ path: "/work/app", format: "elf" }] }),
    );
    const failure = unfinished("inspect_go_binary");
    goBinaries.inspect.mockResolvedValue(err(failure));
    const result = await service.inspect({ path: "/work/app" });
    expect(result).toMatchObject({ ok: false, error: failure });
    expect(failure.cleanupIncomplete).toBe(true);
    expect(rustBinaries.inspect).not.toHaveBeenCalled();
    const report = await audit(result);
    expect(
      report.checks.find((check) => check.id === "rust.dependency_metadata")
        ?.status,
    ).toBe("unknown");
  });

  it("replaces an owner's partial without losing its cleanup", async () => {
    const { service, goBinaries } = owners(
      scan({ native_images: [{ path: "/work/app", format: "elf" }] }),
    );
    const failure = unfinished("inspect_go_binary");
    failure.retainPartialObservation(evidence({ owner: "go" }));
    goBinaries.inspect.mockResolvedValue(err(failure));
    const result = await service.inspect({ path: "/work/app" });
    expect(result).toMatchObject({ ok: false, error: failure });
    expect((await audit(result)).limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("unfinished cleanup")]),
    );
  });

  it("returns a thrown Rust failure with the partial audit", async () => {
    const { service, rustBinaries } = owners(
      scan({ native_images: [{ path: "/work/app", format: "elf" }] }),
    );
    const failure = unfinished("inspect_rust_binary");
    rustBinaries.inspect.mockRejectedValue(failure);
    const result = await service.inspect({ path: "/work/app" });
    expect(result).toMatchObject({ ok: false, error: failure });
    await audit(result);
  });

  it("returns a desktop failure with the partial audit", async () => {
    const { service, desktop, goBinaries } = owners(
      scan({
        target: {
          selected_path: "/work/app",
          kind: "directory",
          format: "directory",
          sha256: null,
        },
        subject: { path: "/work/app", sha256: SHA, format: "directory" },
        native_images: [{ path: "/work/app/app", format: "elf" }],
      }),
    );
    const failure = unfinished("inspect_desktop_application");
    desktop.inspect.mockResolvedValue(err(failure));
    const result = await service.inspect({ path: "/work/app" });
    expect(result).toMatchObject({ ok: false, error: failure });
    expect(goBinaries.inspect).not.toHaveBeenCalled();
    await audit(result);
  });

  it("returns a fuse failure with the partial audit", async () => {
    const { service, electronFuses, goBinaries } = owners(
      scan({
        fuse_candidates: [{ role: "native-image", path: "/work/app/app" }],
        native_images: [{ path: "/work/app/app", format: "elf" }],
      }),
    );
    const failure = unfinished("inspect_electron_fuses");
    electronFuses.inspect.mockResolvedValue(err(failure));
    const result = await service.inspect({ path: "/work/app" });
    expect(result).toMatchObject({ ok: false, error: failure });
    expect(goBinaries.inspect).not.toHaveBeenCalled();
    await audit(result);
  });
});

const CHANGED = "cd".repeat(32);

describe("ReleaseExposureService image identity", () => {
  it("does not attach Go facts from a file replaced after inventory", async () => {
    const { service, goBinaries } = owners(
      scan({
        native_images: [{ path: "/work/app", format: "elf", sha256: CHANGED }],
      }),
    );
    goBinaries.inspect.mockResolvedValue(
      ok(
        evidence(
          goBinaryReport({
            path: "/Users/dev/app",
            main: null,
            dependencies: [],
            settings: [],
            unparsed_lines: [],
            unparsed_line_bytes_base64: [],
            complete: true,
          }),
        ),
      ),
    );
    const result = await service.inspect({ path: "/work/app" });
    if (!result.ok) throw result.error;
    const check = releaseExposureReportSchema
      .parse(result.value.normalized_result)
      .checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("unknown");
    expect(check?.observation.counts.paths).toBe(0);
  });

  it("does not attach Rust facts from a file replaced after inventory", async () => {
    const { service, rustBinaries } = owners(
      scan({
        native_images: [{ path: "/work/app", format: "elf", sha256: CHANGED }],
      }),
    );
    rustBinaries.inspect.mockResolvedValue(
      ok(
        evidence({
          artifact: { path: "/work/app", sha256: SHA, bytes: 4096 },
          format: "elf",
          architecture: "arm64",
          bits: 64,
          byte_order: "little",
          auditable_metadata: {
            section_name: ".dep-v0",
            file_offset: 0,
            section_bytes: 32,
            compressed_bytes: 32,
            uncompressed_bytes: 64,
            format_version: 1,
            packages: [
              {
                name: "serde",
                version: "1.0.0",
                source: "crates.io",
                kind: "runtime",
                dependencies: [],
                features: null,
                root: true,
              },
            ],
            root_package_index: 0,
            dependency_edges: [],
            cyclic_dependency_indices: [],
          },
          rustc_commit: null,
          limitations: [],
        }),
      ),
    );
    const result = await service.inspect({ path: "/work/app" });
    if (!result.ok) throw result.error;
    const check = releaseExposureReportSchema
      .parse(result.value.normalized_result)
      .checks.find((item) => item.id === "rust.dependency_metadata");
    expect(check?.status).toBe("unknown");
    expect(check?.observation.counts.packages).toBe(0);
    expect(check?.observation.samples).not.toContain("serde");
  });
});

describe("ReleaseExposureService fuse image identity", () => {
  it("binds a native-image fuse read to that image, not any inventoried digest", async () => {
    const { service, electronFuses } = owners(
      scan({
        native_images: [
          { path: "/work/app", format: "elf", sha256: CHANGED },
          { path: "/work/helper", format: "elf", sha256: SHA },
        ],
      }),
    );
    electronFuses.inspect.mockImplementation(async (input) =>
      (input as { path: string }).path === "/work/app"
        ? ok(evidence(fuseReport([slice(0)])))
        : err(
            new AnalysisUnsupportedTargetError(
              "inspect_electron_fuses",
              "/work/helper",
              "unsupported",
            ),
          ),
    );
    const result = await service.inspect({ path: "/work/app" });
    if (!result.ok) throw result.error;
    expect(
      releaseExposureReportSchema
        .parse(result.value.normalized_result)
        .checks.find((item) => item.id === "electron.run_as_node")?.status,
    ).toBe("unknown");
  });

  it("accepts an app bundle's fuse read when its file is an inventoried image", async () => {
    const bundle = scan({
      target: {
        selected_path: "/work/App.app",
        kind: "app",
        format: "directory",
        sha256: null,
      },
      fuse_candidates: [{ path: "/work/App.app", role: "app-bundle" }],
    });
    const status = async (sha256: string) => {
      const { service, desktop, electronFuses } = owners({
        ...bundle,
        native_images: [
          { path: "/work/App.app/framework", format: "elf", sha256 },
        ],
      });
      desktop.inspect.mockResolvedValue(
        err(new AnalysisInputError("inspect_desktop_application")),
      );
      electronFuses.inspect.mockResolvedValue(
        ok(evidence(fuseReport([slice(0)]))),
      );
      const result = await service.inspect({ path: "/work/App.app" });
      if (!result.ok) throw result.error;
      return releaseExposureReportSchema
        .parse(result.value.normalized_result)
        .checks.find((item) => item.id === "electron.run_as_node")?.status;
    };
    expect(await status(SHA)).toBe("not_observed");
    expect(await status(CHANGED)).toBe("unknown");
  });

  it("does not attach fuse facts when the resolved file left the inventory", async () => {
    const { service, electronFuses } = owners(
      scan({
        native_images: [{ path: "/work/app", format: "elf", sha256: CHANGED }],
        fuse_candidates: [{ path: "/work/app", role: "native-image" }],
      }),
    );
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    const result = await service.inspect({ path: "/work/app" });
    if (!result.ok) throw result.error;
    expect(
      releaseExposureReportSchema
        .parse(result.value.normalized_result)
        .checks.find((item) => item.id === "electron.run_as_node")?.status,
    ).toBe("unknown");
  });
});

describe("ReleaseExposureService fuse slice coverage", () => {
  const status = async (slices: ElectronFuseSlice[]) => {
    const { service, electronFuses } = owners(
      scan({ native_images: [{ path: "/work/app", format: "elf" }] }),
    );
    electronFuses.inspect.mockResolvedValue(ok(evidence(fuseReport(slices))));
    const result = await service.inspect({ path: "/work/app" });
    if (!result.ok) throw result.error;
    return releaseExposureReportSchema
      .parse(result.value.normalized_result)
      .checks.find((item) => item.id === "electron.run_as_node")?.status;
  };

  it("needs every slice to decide before a check is not observed", async () => {
    expect(await status([slice(0), slice(1)])).toBe("not_observed");
    expect(await status([slice(0), slice(1, { sentinels: 0 })])).toBe(
      "unknown",
    );
    expect(await status([slice(0), slice(1, { wireVersion: 2 })])).toBe(
      "unknown",
    );
    expect(await status([slice(0), slice(1, { fuses: 0 })])).toBe("unknown");
  });

  it("keeps an exposed slice exposed beside an undecided slice", async () => {
    expect(
      await status([
        slice(0, { state: ELECTRON_FUSE_STATE_BYTES.enabled }),
        slice(1, { sentinels: 0 }),
      ]),
    ).toBe("exposed");
  });

  it("leaves a file with no sentinel without fuse implications", async () => {
    expect(await status([slice(0, { sentinels: 0 })])).toBe("not_applicable");
  });
});

describe("ReleaseExposureService fuse implications", () => {
  it("reads fuse implications from the owner report", async () => {
    const { service, electronFuses } = owners(
      scan({
        target: {
          selected_path: "/work/App.app",
          kind: "app",
          format: "directory",
          sha256: null,
        },
        fuse_candidates: [{ path: "/work/App.app", role: "app-bundle" }],
      }),
    );
    const fuses = Array.from(
      { length: 6 },
      () => ELECTRON_FUSE_STATE_BYTES.enabled,
    );
    fuses[0] = ELECTRON_FUSE_STATE_BYTES.enabled;
    const slices: ElectronFuseSlice[] = [
      {
        index: 0,
        file_offset: 0,
        size: 128,
        architecture: "arm64",
        sentinel_count: 1,
        sentinels: [
          {
            sentinel_offset: 0,
            wire_version: 1,
            declared_length: fuses.length,
            complete: true,
            fuses: fuses.map((raw, index) => ({
              index,
              name: electronFuseName(1, index),
              state: electronFuseState(raw),
              raw_byte: raw,
            })),
          },
        ],
      },
    ];
    electronFuses.inspect.mockResolvedValue(
      ok(
        evidence({
          artifact: {
            selected_path: "/work/App.app",
            resolved_path: "/work/App.app",
            sha256: SHA,
            bytes: 128,
            format: "mach-o",
          },
          slices,
          ...describeElectronFuseFindings(slices, "mach-o"),
        }),
      ),
    );
    const result = await service.inspect({ path: "/work/App.app" });
    if (!result.ok) throw result.error;
    const checks = (
      result.value.normalized_result as {
        checks: { id: string; status: string }[];
      }
    ).checks;
    expect(
      checks.find((check) => check.id === "electron.run_as_node")?.status,
    ).toBe("exposed");
  });

  it("treats a native app bundle as not applicable when the desktop owner says it is not Electron", async () => {
    const { service, desktop, electronFuses } = owners(
      scan({
        target: {
          selected_path: "/work/Native.app",
          kind: "app",
          format: "directory",
          sha256: null,
        },
        fuse_candidates: [{ path: "/work/Native.app", role: "app-bundle" }],
      }),
    );
    desktop.inspect.mockResolvedValue(ok(evidence(nativeDesktopReport())));
    const slices: ElectronFuseSlice[] = [
      {
        index: 0,
        file_offset: 0,
        size: 128,
        architecture: "arm64",
        sentinel_count: 0,
        sentinels: [],
      },
    ];
    electronFuses.inspect.mockResolvedValue(
      ok(
        evidence({
          artifact: {
            selected_path: "/work/Native.app",
            resolved_path: "/work/Native.app",
            sha256: SHA,
            bytes: 128,
            format: "mach-o",
          },
          slices,
          ...describeElectronFuseFindings(slices, "mach-o"),
        }),
      ),
    );
    const result = await service.inspect({ path: "/work/Native.app" });
    if (!result.ok) throw result.error;
    const checks = (
      result.value.normalized_result as {
        checks: { id: string; status: string }[];
      }
    ).checks;
    expect(
      checks.find((check) => check.id === "electron.run_as_node")?.status,
    ).toBe("not_applicable");
  });
});

describe("ReleaseExposureService fuse sampling", () => {
  it("samples the Electron executable ahead of neighboring libraries", async () => {
    const images = [
      "/work/app/ffmpeg.dll",
      "/work/app/libEGL.dll",
      "/work/app/vk_swiftshader.dll",
      "/work/app/d3dcompiler.dll",
      "/work/app/MyApp.exe",
    ].map((path) => ({ path, format: "pe" as const }));
    const { service, desktop, electronFuses, goBinaries, rustBinaries } =
      owners(
        scan({
          target: {
            selected_path: "/work/app",
            kind: "directory",
            format: "directory",
            sha256: null,
          },
          subject: { path: "/work/app", sha256: SHA, format: "directory" },
          native_images: images,
          fuse_candidates: images.map((image) => ({
            path: image.path,
            role: "native-image" as const,
          })),
        }),
      );
    desktop.inspect.mockResolvedValue(ok(evidence(electronDesktopReport())));
    const unsupported = (operation: string) =>
      err(
        new AnalysisUnsupportedTargetError(
          operation,
          "/work/app/MyApp.exe",
          "unsupported",
        ),
      );
    goBinaries.inspect.mockResolvedValue(unsupported("inspect_go_binary"));
    rustBinaries.inspect.mockResolvedValue(unsupported("inspect_rust_binary"));
    electronFuses.inspect.mockResolvedValue(ok(evidence(safeFuseReport())));
    const result = await service.inspect({ path: "/work/app" });
    if (!result.ok) throw result.error;
    const calls = electronFuses.inspect.mock.calls.map(
      (call) => (call[0] as { path: string }).path,
    );
    expect(calls).toHaveLength(4);
    expect(calls[0]).toBe("/work/app/MyApp.exe");
    const checks = (
      result.value.normalized_result as {
        checks: { id: string; status: string }[];
      }
    ).checks;
    expect(
      checks.find((check) => check.id === "electron.run_as_node")?.status,
    ).toBe("not_observed");
    await service.close();
  });

  it("keeps fuse checks unknown when a truncated desktop scan finds no Electron candidate", async () => {
    const { service, desktop } = owners(
      scan({
        target: {
          selected_path: "/work/app",
          kind: "directory",
          format: "directory",
          sha256: null,
        },
        subject: { path: "/work/app", sha256: SHA, format: "directory" },
      }),
    );
    const report = nativeDesktopReport();
    desktop.inspect.mockResolvedValue(
      ok(
        evidence({
          ...report,
          coverage: { ...report.coverage, status: "partial" },
        }),
      ),
    );
    const result = await service.inspect({ path: "/work/app" });
    if (!result.ok) throw result.error;
    const check = (
      result.value.normalized_result as {
        checks: {
          id: string;
          status: string;
          observation: { samples: string[] };
        }[];
      }
    ).checks.find((item) => item.id === "electron.run_as_node");
    expect(check?.status).toBe("unknown");
    expect(check?.observation.samples).toContain(
      "Desktop application coverage is partial.",
    );
    await service.close();
  });
});

const directoryScan = (paths: readonly string[]) => {
  const images = paths.map((path) => ({ path, format: "elf" as const }));
  return scan({
    target: {
      selected_path: "/work/app",
      kind: "directory",
      format: "directory",
      sha256: null,
    },
    subject: { path: "/work/app", sha256: SHA, format: "directory" },
    native_images: images,
    fuse_candidates: images.map((image) => ({
      path: image.path,
      role: "native-image" as const,
    })),
  });
};

const runAsNode = async (
  service: ReleaseExposureService,
  path = "/work/app",
) => {
  const result = await service.inspect({ path });
  if (!result.ok) throw result.error;
  return releaseExposureReportSchema
    .parse(result.value.normalized_result)
    .checks.find((check) => check.id === "electron.run_as_node");
};

describe("ReleaseExposureService packaged native images", () => {
  it("keeps safe fuses unknown past a packaged native image", async () => {
    const { service, electronFuses } = owners({
      ...directoryScan(["/work/app/helper"]),
      omitted: [{ subject: PACKAGED_NATIVE_IMAGES, count: 1, reason: "x" }],
    });
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    expect((await runAsNode(service))?.status).toBe("unknown");
  });

  it("keeps safe fuses decided past a packaged image once the hinted executable was read", async () => {
    const { service, desktop, electronFuses } = owners({
      ...directoryScan(["/work/app/MyApp.exe"]),
      omitted: [{ subject: PACKAGED_NATIVE_IMAGES, count: 1, reason: "x" }],
    });
    desktop.inspect.mockResolvedValue(ok(evidence(electronDesktopReport())));
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    expect((await runAsNode(service))?.status).toBe("not_observed");
  });
});

describe("ReleaseExposureService Electron layout paths", () => {
  it.each([
    ["Windows", "C:\\ship\\App", "\\"],
    ["POSIX", "/ship/App", "/"],
  ])(
    "keeps a %s named host without a sentinel unknown beside a safe helper",
    async (_, folder, separator) => {
      const host = `${folder}${separator}App.exe`;
      const { service, desktop, electronFuses } = owners(
        directoryScan([host, `${folder}${separator}helper.exe`]),
      );
      const report = electronDesktopReport();
      desktop.inspect.mockResolvedValue(
        ok(
          evidence({
            ...report,
            files: [
              {
                ...report.files[0],
                path: "resources/app.asar",
                local_path: [folder, "resources", "app.asar"].join(separator),
              },
            ],
          }),
        ),
      );
      electronFuses.inspect.mockImplementation(async (input) =>
        ok(
          evidence(
            fuseReport(
              (input as { path?: string }).path === host ? [] : [slice(0)],
            ),
          ),
        ),
      );
      expect((await runAsNode(service))?.status).toBe("unknown");
    },
  );
});

describe("ReleaseExposureService Electron host identity", () => {
  it("keeps safe fuses decided when inventory stopped after the named executable", async () => {
    const { service, desktop, electronFuses } = owners({
      ...directoryScan(["/work/app/app.exe"]),
      coverage: "unknown",
    });
    desktop.inspect.mockResolvedValue(ok(evidence(electronDesktopReport())));
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    expect((await runAsNode(service))?.status).toBe("not_observed");
  });

  it("keeps safe fuses unknown when inventory stopped after an unnamed sibling", async () => {
    const { service, desktop, electronFuses } = owners({
      ...directoryScan(["/work/app/helper.exe"]),
      coverage: "unknown",
    });
    desktop.inspect.mockResolvedValue(ok(evidence(electronDesktopReport())));
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    expect((await runAsNode(service))?.status).toBe("unknown");
  });

  it("keeps safe fuses unknown when the sample dropped an executable that could be the host", async () => {
    const { service, desktop, electronFuses } = owners(
      directoryScan(
        ["one", "two", "three", "four", "five"].map(
          (name) => `/work/app/${name}.exe`,
        ),
      ),
    );
    desktop.inspect.mockResolvedValue(ok(evidence(electronDesktopReport())));
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    expect((await runAsNode(service))?.status).toBe("unknown");
    expect(electronFuses.inspect).toHaveBeenCalledTimes(4);
  });

  it("keeps safe fuses decided when the sample kept the named host among many siblings", async () => {
    const { service, desktop, electronFuses } = owners(
      directoryScan(
        ["one", "two", "three", "four", "app"].map(
          (name) => `/work/app/${name}.exe`,
        ),
      ),
    );
    desktop.inspect.mockResolvedValue(ok(evidence(electronDesktopReport())));
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    expect((await runAsNode(service))?.status).toBe("not_observed");
    expect(electronFuses.inspect.mock.calls[0]?.[0]).toMatchObject({
      path: "/work/app/app.exe",
    });
  });

  it("keeps safe fuses unknown when the sample dropped every host of a second layout", async () => {
    const { service, desktop, electronFuses } = owners(
      directoryScan([
        "/work/app/a/a.exe",
        "/work/app/a/one.exe",
        "/work/app/a/two.exe",
        "/work/app/a/three.exe",
        "/work/app/b/launcher.exe",
      ]),
    );
    const report = electronDesktopReport();
    const second = `dsf_${"ab".repeat(32)}`;
    desktop.inspect.mockResolvedValue(
      ok(
        evidence({
          ...report,
          files: [
            {
              ...report.files[0],
              path: "a/resources/app.asar",
              local_path: "/work/app/a/resources/app.asar",
            },
            {
              ...report.files[0],
              file_id: second,
              path: "b/resources/app.asar",
              local_path: "/work/app/b/resources/app.asar",
            },
          ],
          candidates: [
            { ...report.candidates[0], basis_file_ids: [FILE, second] },
          ],
        }),
      ),
    );
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    expect((await runAsNode(service))?.status).toBe("unknown");
    expect(electronFuses.inspect).toHaveBeenCalledTimes(4);
  });

  it("keeps safe fuses unknown when a second layout has only an unnamed possible host", async () => {
    const { service, desktop, electronFuses } = owners(
      directoryScan(["/work/app/a/a.exe", "/work/app/b/launcher.exe"]),
    );
    const report = electronDesktopReport();
    const second = `dsf_${"ab".repeat(32)}`;
    desktop.inspect.mockResolvedValue(
      ok(
        evidence({
          ...report,
          files: [
            {
              ...report.files[0],
              path: "a/resources/app.asar",
              local_path: "/work/app/a/resources/app.asar",
            },
            {
              ...report.files[0],
              file_id: second,
              path: "b/resources/app.asar",
              local_path: "/work/app/b/resources/app.asar",
            },
          ],
          candidates: [
            { ...report.candidates[0], basis_file_ids: [FILE, second] },
          ],
        }),
      ),
    );
    electronFuses.inspect.mockImplementation(async (input) =>
      ok(
        evidence(
          fuseReport(
            (input as { path?: string }).path === "/work/app/a/a.exe"
              ? [slice(0)]
              : [],
          ),
        ),
      ),
    );
    expect((await runAsNode(service))?.status).toBe("unknown");
  });
});

describe("ReleaseExposureService macOS bundle layouts", () => {
  it("keeps one bundle's safe fuses from settling another bundle in a directory", async () => {
    const framework = (bundle: string) =>
      `/work/app/${bundle}.app/Contents/Frameworks/Electron Framework.framework/Electron Framework`;
    const { service, desktop, electronFuses } = owners(
      directoryScan([framework("A"), framework("B")]),
    );
    const report = electronDesktopReport();
    const second = `dsf_${"ab".repeat(32)}`;
    desktop.inspect.mockResolvedValue(
      ok(
        evidence({
          ...report,
          files: [
            {
              ...report.files[0],
              path: "A.app/Contents/Resources/app.asar",
              local_path: "/work/app/A.app/Contents/Resources/app.asar",
            },
            {
              ...report.files[0],
              file_id: second,
              path: "B.app/Contents/Resources/app.asar",
              local_path: "/work/app/B.app/Contents/Resources/app.asar",
            },
          ],
          candidates: [
            { ...report.candidates[0], basis_file_ids: [FILE, second] },
          ],
        }),
      ),
    );
    electronFuses.inspect.mockImplementation(async (input) =>
      ok(
        evidence(
          fuseReport(
            (input as { path?: string }).path === framework("A")
              ? [slice(0)]
              : [slice(0, { sentinels: 0 })],
          ),
        ),
      ),
    );
    expect((await runAsNode(service))?.status).toBe("unknown");
  });

  it("lets a bundle's framework settle its fuses past a launcher with no sentinel", async () => {
    const framework =
      "/work/app/App.app/Contents/Frameworks/Electron Framework.framework/Electron Framework";
    const launcher = "/work/app/App.app/Contents/MacOS/App";
    const { service, desktop, electronFuses } = owners(
      directoryScan([framework, launcher]),
    );
    const report = electronDesktopReport();
    desktop.inspect.mockResolvedValue(
      ok(
        evidence({
          ...report,
          files: [
            {
              ...report.files[0],
              path: "App.app/Contents/Resources/app.asar",
              local_path: "/work/app/App.app/Contents/Resources/app.asar",
            },
          ],
        }),
      ),
    );
    electronFuses.inspect.mockImplementation(async (input) =>
      ok(
        evidence(
          fuseReport(
            (input as { path?: string }).path === framework
              ? [slice(0)]
              : [slice(0, { sentinels: 0 })],
          ),
        ),
      ),
    );
    expect((await runAsNode(service))?.status).toBe("not_observed");
  });
});

describe("ReleaseExposureService nested app layouts", () => {
  it("settles the bundle's own layout when the owner resolved the selected path", async () => {
    const images = [
      "/private/tmp/App.app/Contents/MacOS/App",
      "/private/tmp/App.app/Contents/MacOS/one",
      "/private/tmp/App.app/Contents/MacOS/two",
      "/private/tmp/App.app/Contents/MacOS/three",
      "/private/tmp/App.app/Contents/MacOS/four",
    ].map((path) => ({ path, format: "elf" as const }));
    const { service, desktop, electronFuses } = owners({
      ...appScan,
      target: { ...appScan.target, selected_path: "/tmp/App.app" },
      native_images: images,
      fuse_candidates: [
        { path: "/tmp/App.app", role: "app-bundle" },
        ...images.map((image) => ({
          path: image.path,
          role: "native-image" as const,
        })),
      ],
    });
    const report = electronDesktopReport();
    desktop.inspect.mockResolvedValue(
      ok(
        evidence({
          ...report,
          files: [
            {
              ...report.files[0],
              path: "Contents/Resources/app.asar",
              local_path: "/private/tmp/App.app/Contents/Resources/app.asar",
            },
          ],
        }),
      ),
    );
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    expect((await runAsNode(service, "/tmp/App.app"))?.status).toBe(
      "not_observed",
    );
  });

  it.each([
    ["the outer bundle", "/work/App.app/Contents/MacOS/App", "not_observed"],
    [
      "a nested Electron app",
      "/work/App.app/Contents/Resources/Inner.app/Contents/MacOS/Helper",
      "unknown",
    ],
  ])(
    "lets an app bundle read settle only its own layout (second layout host: %s)",
    async (_, nestedHost, expected) => {
      // Four named outer hosts fill the sample ahead of the nested helper.
      const outer = [
        "/work/App.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
        "/work/App.app/Contents/MacOS/App",
        "/work/App.app/Contents/MacOS/one",
        "/work/App.app/Contents/MacOS/two",
      ];
      const images = [...new Set([...outer, nestedHost])].map((path) => ({
        path,
        format: "elf" as const,
      }));
      const { service, desktop, electronFuses } = owners({
        ...appScan,
        native_images: images,
        fuse_candidates: [
          ...appScan.fuse_candidates,
          ...images.map((image) => ({
            path: image.path,
            role: "native-image" as const,
          })),
        ],
      });
      const report = electronDesktopReport();
      const second = `dsf_${"ab".repeat(32)}`;
      const nested = nestedHost.includes("/Inner.app/");
      desktop.inspect.mockResolvedValue(
        ok(
          evidence({
            ...report,
            files: [
              {
                ...report.files[0],
                path: "Contents/Resources/app.asar",
                local_path: "/work/App.app/Contents/Resources/app.asar",
              },
              ...(nested
                ? [
                    {
                      ...report.files[0],
                      file_id: second,
                      path: "Contents/Resources/Inner.app/Contents/Resources/app.asar",
                      local_path:
                        "/work/App.app/Contents/Resources/Inner.app/Contents/Resources/app.asar",
                    },
                  ]
                : []),
            ],
            candidates: [
              {
                ...report.candidates[0],
                basis_file_ids: nested ? [FILE, second] : [FILE],
              },
            ],
          }),
        ),
      );
      electronFuses.inspect.mockResolvedValue(
        ok(evidence(fuseReport([slice(0)]))),
      );
      expect((await runAsNode(service, "/work/App.app"))?.status).toBe(
        expected,
      );
    },
  );
});

const appScan = scan({
  target: {
    selected_path: "/work/App.app",
    kind: "app",
    format: "directory",
    sha256: null,
  },
  fuse_candidates: [{ path: "/work/App.app", role: "app-bundle" }],
});

const frameworkDesktopReport = () => ({
  ...nativeDesktopReport(),
  files: [
    {
      ...electronDesktopReport().files[0],
      path: "Contents/Frameworks/Electron Framework.framework/Electron Framework",
      local_path:
        "/work/App.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
    },
  ],
});

describe("ReleaseExposureService Electron applicability", () => {
  const noSentinel = ok(evidence(fuseReport([slice(0, { sentinels: 0 })])));
  const unreadable = err(new AnalysisInputError("inspect_electron_fuses"));

  it("reads safe fuses on an asar: false directory instead of ruling Electron out", async () => {
    const { service, electronFuses } = owners(
      directoryScan(["/work/app/electron"]),
    );
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    expect((await runAsNode(service))?.status).toBe("not_observed");
  });

  it("keeps safe fuses unknown when inventory may have missed the executable", async () => {
    const { service, electronFuses } = owners({
      ...directoryScan(["/work/app/helper"]),
      coverage: "unknown",
    });
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    expect((await runAsNode(service))?.status).toBe("unknown");
  });

  it("keeps safe fuses decided on a selected executable with unknown inventory", async () => {
    const { service, electronFuses } = owners(
      scan({
        target: {
          selected_path: "/work/app",
          kind: "executable",
          format: "elf",
          sha256: SHA,
        },
        native_images: [{ path: "/work/app", format: "elf" }],
        fuse_candidates: [{ path: "/work/app", role: "native-image" }],
        coverage: "unknown",
      }),
    );
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    expect((await runAsNode(service))?.status).toBe("not_observed");
  });

  it("does not hide a failed fuse read behind a missing ASAR hint", async () => {
    const { service, electronFuses } = owners(
      directoryScan(["/work/app/electron"]),
    );
    electronFuses.inspect.mockResolvedValue(unreadable);
    expect(await runAsNode(service)).toMatchObject({
      status: "unknown",
      observation: {
        samples: expect.arrayContaining([
          expect.stringContaining("asar: false"),
        ]),
      },
    });
  });

  it("rules out Electron once every native image was read without a sentinel", async () => {
    const { service, electronFuses } = owners(
      directoryScan(["/work/app/one", "/work/app/two"]),
    );
    electronFuses.inspect.mockResolvedValue(noSentinel);
    expect((await runAsNode(service))?.status).toBe("not_applicable");
  });

  it.each([
    ["an image past the sample", { omit: true, coverage: "complete" }],
    ["unknown inventory coverage", { omit: false, coverage: "unknown" }],
  ] as const)("does not rule out Electron with %s", async (_, input) => {
    const paths = ["a", "b", "c", "d", ...(input.omit ? ["e"] : [])];
    const { service, electronFuses } = owners({
      ...directoryScan(paths.map((name) => `/work/app/${name}`)),
      coverage: input.coverage,
    });
    electronFuses.inspect.mockResolvedValue(noSentinel);
    expect((await runAsNode(service))?.status).toBe("unknown");
  });

  it("does not rule out Electron past a packaged native image", async () => {
    const { service, electronFuses } = owners({
      ...directoryScan(["/work/app/one"]),
      omitted: [{ subject: PACKAGED_NATIVE_IMAGES, count: 1, reason: "x" }],
    });
    electronFuses.inspect.mockResolvedValue(noSentinel);
    expect((await runAsNode(service))?.status).toBe("unknown");
  });

  it("does not rule out Electron when one image could not be read", async () => {
    const { service, electronFuses } = owners(
      directoryScan(["/work/app/one", "/work/app/two"]),
    );
    electronFuses.inspect
      .mockResolvedValueOnce(noSentinel)
      .mockResolvedValueOnce(unreadable);
    expect((await runAsNode(service))?.status).toBe("unknown");
  });

  it("does not treat a directory with no native image as proof", async () => {
    const { service, electronFuses } = owners(directoryScan([]));
    expect((await runAsNode(service))?.status).toBe("unknown");
    expect(electronFuses.inspect).not.toHaveBeenCalled();
  });

  it("rules out Electron on an app bundle with no Electron Framework", async () => {
    const { service, electronFuses } = owners(appScan);
    electronFuses.inspect.mockResolvedValue(unreadable);
    expect((await runAsNode(service, "/work/App.app"))?.status).toBe(
      "not_applicable",
    );
  });

  it.each([
    ["a sentinel-free", noSentinel],
    ["an unreadable", unreadable],
  ] as const)(
    "keeps the checks unknown on an asar: false bundle with %s framework",
    async (_, read) => {
      const { service, desktop, electronFuses } = owners(appScan);
      desktop.inspect.mockResolvedValue(ok(evidence(frameworkDesktopReport())));
      electronFuses.inspect.mockResolvedValue(read);
      expect((await runAsNode(service, "/work/App.app"))?.status).toBe(
        "unknown",
      );
    },
  );
});

describe("ReleaseExposureService app bundle with a sidecar", () => {
  const noSentinel = ok(evidence(fuseReport([slice(0, { sentinels: 0 })])));
  const unreadable = err(new AnalysisInputError("inspect_electron_fuses"));
  const FRAMEWORK =
    "/work/App.app/Contents/Frameworks/Electron Framework.framework/Electron Framework";
  const SIDECAR = "/work/App.app/Contents/Resources/sidecar";
  const safe = ok(evidence(fuseReport([slice(0)])));
  const runAsNodeOn = ok(
    evidence(
      fuseReport([slice(0, { state: ELECTRON_FUSE_STATE_BYTES.enabled })]),
    ),
  );
  const bundleWithSidecar = () => {
    const parts = owners({
      ...appScan,
      native_images: [
        { path: FRAMEWORK, format: "mach-o", sha256: SHA },
        { path: SIDECAR, format: "mach-o" },
      ],
    });
    parts.desktop.inspect.mockResolvedValue(
      ok(evidence(frameworkDesktopReport())),
    );
    return parts;
  };
  const readPaths = (inspect: ReturnType<typeof vi.fn>) =>
    inspect.mock.calls.map((call) => (call[0] as { path: string }).path);

  it("reports RunAsNode exposed on the sidecar and reads the framework once", async () => {
    const { service, electronFuses } = bundleWithSidecar();
    electronFuses.inspect.mockImplementation(async (input) =>
      (input as { path: string }).path === SIDECAR ? runAsNodeOn : safe,
    );
    const check = await runAsNode(service, "/work/App.app");
    expect(check?.status).toBe("exposed");
    expect(JSON.stringify(check?.locations)).toContain(SIDECAR);
    expect(readPaths(electronFuses.inspect)).toEqual([
      "/work/App.app",
      SIDECAR,
    ]);
  });

  it.each([
    ["sentinel-free", noSentinel],
    [
      "unsupported",
      err(
        new AnalysisUnsupportedTargetError(
          "inspect_electron_fuses",
          "/work/App.app",
          "unsupported",
        ),
      ),
    ],
  ] as const)(
    "keeps a safe sidecar from standing for an %s framework",
    async (_, framework) => {
      const { service, electronFuses } = bundleWithSidecar();
      electronFuses.inspect.mockImplementation(async (input) =>
        (input as { path: string }).path === SIDECAR ? safe : framework,
      );
      expect((await runAsNode(service, "/work/App.app"))?.status).toBe(
        "unknown",
      );
    },
  );

  it("keeps safe outer fuses unknown when the sidecar cannot be read", async () => {
    const { service, electronFuses } = bundleWithSidecar();
    electronFuses.inspect.mockImplementation(async (input) =>
      (input as { path: string }).path === SIDECAR ? unreadable : safe,
    );
    expect((await runAsNode(service, "/work/App.app"))?.status).toBe("unknown");
  });
});

describe("ReleaseExposureService scanners and selected archives", () => {
  it("leaves fuse checks unknown on a selected ASAR because they were not read", async () => {
    const { service, desktop, electronFuses } = owners(
      scan({
        target: {
          selected_path: "/work/app.asar",
          kind: "asar",
          format: "asar",
          sha256: SHA,
        },
      }),
    );
    const result = await service.inspect({ path: "/work/app.asar" });
    if (!result.ok) throw result.error;
    const report = releaseExposureReportSchema.parse(
      result.value.normalized_result,
    );
    const fuses = report.checks.filter((check) =>
      check.id.startsWith("electron."),
    );
    expect(fuses.map((check) => check.status)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);
    expect(fuses[0]?.observation.samples[0]).toContain(
      "does not include the Electron executable",
    );
    expect(desktop.inspect).not.toHaveBeenCalled();
    expect(electronFuses.inspect).not.toHaveBeenCalled();
  });

  it("owns credential scanning and keeps matched bytes out of the report", async () => {
    const planted = "AKIAPLANT9EXPOSUREXX";
    const { service } = owners(
      scan({ text_members: { scanned: 1, skipped: 0 } }),
      [[`key = ${planted}\n`, "/work/app.dll/notes.txt"]],
    );
    const result = await service.inspect({ path: "/work/app" });
    if (!result.ok) throw result.error;
    const check = releaseExposureReportSchema
      .parse(result.value.normalized_result)
      .checks.find((item) => item.id === "text.credential_markers");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.counts["aws.access_key_id"]).toBe(1);
    expect(check?.locations).toEqual([
      { kind: "artifact-path", path: "/work/app.dll/notes.txt" },
    ]);
    expect(JSON.stringify(result.value)).not.toContain(planted);
  });
});

describe("ReleaseExposureService cleanup", () => {
  it("keeps every owner close failure", async () => {
    const { service, desktop, goBinaries } = owners(scan());
    const desktopFailure = new Error("desktop close failed");
    const goFailure = new Error("go close failed");
    desktop.close.mockRejectedValue(desktopFailure);
    goBinaries.close.mockRejectedValue(goFailure);
    const failure: unknown = await service.close().catch((cause) => cause);
    if (!(failure instanceof ProviderCleanupError))
      throw new Error("Expected a typed cleanup failure.");
    expect(failure.cause).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([desktopFailure, goFailure]),
      }),
    );
    expect(failure.cleanupIncomplete).toBe(true);
  });

  it("returns one typed owner close failure unchanged", async () => {
    const { service, desktop } = owners(scan());
    const denied = new ProviderCleanupError(
      "rea-desktop",
      ["/work/app/descriptor"],
      { reason: "EPERM" },
      { operation: "inspect_desktop_application" },
    );
    desktop.close.mockRejectedValue(denied);
    await expect(service.close()).rejects.toBe(denied);
  });

  it("keeps a reader failure's resources beside a typed owner failure", async () => {
    const { service, desktop, goBinaries } = owners(scan());
    desktop.close.mockRejectedValue(
      new ArtifactReaderFailure("unavailable", "close denied", {
        cleanup: { reason: "EPERM", resources: ["/work/app/descriptor"] },
      }),
    );
    goBinaries.close.mockRejectedValue(
      new ProviderCleanupError(
        "rea-go",
        ["/work/app/go"],
        { reason: "EPERM" },
        { operation: "inspect_go_binary" },
      ),
    );
    const failure: unknown = await service.close().catch((cause) => cause);
    if (!(failure instanceof ProviderCleanupError))
      throw new Error("Expected a typed cleanup failure.");
    expect(failure.cleanupResources).toEqual([
      "/work/app/descriptor",
      "/work/app/go",
    ]);
  });

  it("keeps resources and live bindings when several typed owners fail to close", async () => {
    const { service, desktop, goBinaries } = owners(scan());
    const first = new ProviderCleanupError(
      "rea-desktop",
      ["/work/app/desktop"],
      { reason: "EPERM" },
      { operation: "inspect_desktop_application" },
    );
    const second = new ProviderCleanupError(
      "rea-go",
      ["/work/app/go"],
      { reason: "EPERM" },
      { operation: "inspect_go_binary" },
    );
    desktop.close.mockRejectedValue(first);
    goBinaries.close.mockRejectedValue(second);
    const failure: unknown = await service.close().catch((cause) => cause);
    if (!(failure instanceof ProviderCleanupError))
      throw new Error("Expected a typed cleanup failure.");
    expect(failure.cleanupResources).toEqual([
      "/work/app/desktop",
      "/work/app/go",
    ]);
    first.resolveCleanup();
    expect(failure.cleanupIncomplete).toBe(true);
    second.resolveCleanup();
    expect(failure.cleanupIncomplete).toBe(false);
  });
});

describe("ReleaseExposureService Go Windows paths", () => {
  it("reports UNC roots retained in Go flags", async () => {
    const module = (value: string) => ({
      path: "github.com/acme/app",
      main: null,
      dependencies: [],
      settings: [{ key: "CGO_CFLAGS", value }],
      unparsed_lines: [],
      unparsed_line_bytes_base64: [],
      complete: true,
    });
    const report = await goReport(
      module(
        String.raw`-O2 -I\\buildhost\sdk\include "-isystem \\buildhost\my sdk\include"`,
      ),
    );
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual([
      String.raw`\\buildhost\sdk\include`,
      String.raw`\\buildhost\my sdk\include`,
    ]);
    expect(
      await goStatus(module(String.raw`-DNAME=\\ -DHOST=\\buildhost`)),
    ).toBe("not_observed");
  });

  it.each([
    [String.raw`-I..\sdk\include`, String.raw`..\sdk\include`],
    [String.raw`-O2 -I.\sdk`, String.raw`.\sdk`],
    [String.raw`"-isystem ..\my sdk\include"`, String.raw`..\my sdk\include`],
  ])("reports the backslash-relative path in %s", async (value, path) => {
    const report = await goReport({
      path: "github.com/acme/app",
      main: null,
      dependencies: [],
      settings: [{ key: "CGO_CFLAGS", value }],
      unparsed_lines: [],
      unparsed_line_bytes_base64: [],
      complete: true,
    });
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual([path]);
  });
});

const goModule = (settings: { key: string; value: string }[]) => ({
  path: "github.com/acme/app",
  main: null,
  dependencies: [],
  settings,
  unparsed_lines: [],
  unparsed_line_bytes_base64: [],
  complete: true,
});

describe("ReleaseExposureService Go linker path options", () => {
  it.each([
    ["-tmpdir=private-obj -s -w", "private-obj"],
    ["-tmpdir private-obj", "private-obj"],
    ["-capturehostobjs private-objs", "private-objs"],
    ["-cpuprofile=link.prof", "link.prof"],
    ["-importcfg private.cfg", "private.cfg"],
    ["-o out/app", "out/app"],
    ["-r private-lib", "private-lib"],
  ])("keeps the relative linker path in %s", async (value, path) => {
    const report = await goReport(goModule([{ key: "-ldflags", value }]));
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual([path]);
  });

  it.each([
    "-extld clang -extar ar -libgcc none",
    "-buildmode pie -linkmode external -installsuffix race",
  ])("does not read the program or mode in %s as a path", async (value) => {
    const report = await goReport(goModule([{ key: "-ldflags", value }]));
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("not_observed");
  });
});

describe("ReleaseExposureService Go linker -r search list", () => {
  it.each([["-r=$ORIGIN/../lib -s -w"], ["-r ${ORIGIN}/lib:$ORIGIN"]])(
    "does not read the ELF loader-expanded entries in %s as build paths",
    async (value) => {
      const report = await goReport(goModule([{ key: "-ldflags", value }]));
      const check = report.checks.find((item) => item.id === "go.build_paths");
      expect(check?.status).toBe("not_observed");
    },
  );

  it.each([
    ["-r=$ORIGIN/../lib:/opt/private-runtime", ["/opt/private-runtime"]],
    ["-r /opt/a:$ORIGIN/lib:vendor/lib", ["/opt/a", "vendor/lib"]],
  ])("reads each ELF entry of the search list in %s", async (value, paths) => {
    const report = await goReport(goModule([{ key: "-ldflags", value }]));
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual(paths);
  });

  it.each([
    ["-r=@loader_path/lib:extra", "not_observed", []],
    ["-r=$ORIGIN/../lib", "exposed", ["$ORIGIN/../lib"]],
  ])(
    "reads a Mach-O search path in %s as one directory",
    async (value, status, paths) => {
      const report = await goReport(
        goModule([{ key: "-ldflags", value }]),
        [],
        "mach-o",
      );
      const check = report.checks.find((item) => item.id === "go.build_paths");
      expect(check?.status).toBe(status);
      expect(check?.observation.samples ?? []).toEqual(paths);
    },
  );
});

describe("ReleaseExposureService Go rooted linker flag paths", () => {
  it.each([
    [`-L "/tmp/private,sdk" -s -w`, "/tmp/private,sdk"],
    [`-L "/tmp/private=sdk" -s -w`, "/tmp/private=sdk"],
    [`-L=/tmp/private,sdk -s -w`, "/tmp/private,sdk"],
    [`all=-L=/tmp/private,sdk`, "/tmp/private,sdk"],
    [`-tmpdir /srv/obj,1`, "/srv/obj,1"],
    [`-L "/tmp/private=-sdk"`, "/tmp/private=-sdk"],
  ])("keeps the whole rooted argument in %s", async (value, path) => {
    const report = await goReport(goModule([{ key: "-ldflags", value }]));
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual([path]);
  });
});

describe("ReleaseExposureService Go trimpath rewrites", () => {
  it("keeps the rooted half of a relative -trimpath rewrite", async () => {
    const report = await goReport(
      goModule([{ key: "-gcflags", value: "-trimpath=src=/srv/build" }]),
    );
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.observation.samples).toEqual(
      expect.arrayContaining(["/srv/build"]),
    );
  });
});

describe("ReleaseExposureService Go forwarded linker search paths", () => {
  it.each([
    ["-Wl,-rpath,private-runtime", "private-runtime"],
    ["-Wl,-rpath=private-runtime", "private-runtime"],
    ["-Wl,--rpath=private-runtime", "private-runtime"],
    ["-Xlinker -rpath -Xlinker private-runtime", "private-runtime"],
    ["-Wl,-rpath-link,private-runtime", "private-runtime"],
    ["-Wl,-rpath-link=private-runtime", "private-runtime"],
    ["-Wl,--rpath-link,private-runtime", "private-runtime"],
  ])(
    "keeps the relative search path a compiler forwards in %s",
    async (value, path) => {
      const report = await goReport(goModule([{ key: "CGO_LDFLAGS", value }]));
      const check = report.checks.find((item) => item.id === "go.build_paths");
      expect(check?.status).toBe("exposed");
      expect(check?.observation.samples).toEqual([path]);
    },
  );

  it.each([
    ["-Wl,-rpath,$ORIGIN:/opt/private-runtime", ["/opt/private-runtime"]],
    ["-Wl,-rpath=${ORIGIN}/lib:private-runtime", ["private-runtime"]],
    [
      "-Xlinker -rpath -Xlinker /opt/a:$ORIGIN/lib:/opt/b",
      ["/opt/a", "/opt/b"],
    ],
    ["-Wl,-rpath-link,/opt/a:vendor/lib", ["/opt/a", "vendor/lib"]],
  ])("reads each entry of the search list in %s", async (value, paths) => {
    const report = await goReport(goModule([{ key: "CGO_LDFLAGS", value }]));
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual(paths);
  });

  it.each([
    ["-Wl,-T,$ORIGIN.ld", "$ORIGIN.ld"],
    ["-Xlinker -T -Xlinker ${ORIGIN}/link.ld", "${ORIGIN}/link.ld"],
    ["-Wl,-L,$ORIGIN/lib", "$ORIGIN/lib"],
    ["-Wl,-L,$ORIGIN -Wl,-rpath,$ORIGIN", "$ORIGIN"],
    ["-Wl,-L,$ORIGIN,-rpath,$ORIGIN", "$ORIGIN"],
    [
      "-Xlinker -L -Xlinker $ORIGIN -Xlinker -rpath -Xlinker $ORIGIN",
      "$ORIGIN",
    ],
    ["-Wl,-rpath=$ORIGIN -Wl,-T,$ORIGIN", "$ORIGIN"],
  ])(
    "keeps a literal path that only a search list would expand in %s",
    async (value, path) => {
      const report = await goReport(goModule([{ key: "CGO_LDFLAGS", value }]));
      const check = report.checks.find((item) => item.id === "go.build_paths");
      expect(check?.status).toBe("exposed");
      expect(check?.observation.samples).toEqual([path]);
    },
  );

  it.each([
    ["-Wl,-rpath,@loader_path/lib:extra", "not_observed", []],
    [
      "-Wl,-rpath,$ORIGIN:/opt/private-runtime",
      "exposed",
      ["$ORIGIN:/opt/private-runtime"],
    ],
    ["-Wl,-rpath,/opt/a:b", "exposed", ["/opt/a:b"]],
  ])(
    "reads a Mach-O search path in %s as one directory",
    async (value, status, paths) => {
      const report = await goReport(
        goModule([{ key: "CGO_LDFLAGS", value }]),
        [],
        "mach-o",
      );
      const check = report.checks.find((item) => item.id === "go.build_paths");
      expect(check?.status).toBe(status);
      expect(check?.observation.samples ?? []).toEqual(paths);
    },
  );

  it.each([
    ["elf", "-Wl,-rpath,$ORIGIN/../lib -Wl,-rpath=${ORIGIN}/lib"],
    [
      "mach-o",
      "-Wl,-rpath,@loader_path/Frameworks -Xlinker -rpath -Xlinker @executable_path",
    ],
  ] as const)(
    "does not read %s loader-expanded runtime search paths as build paths",
    async (format, value) => {
      const report = await goReport(
        goModule([{ key: "CGO_LDFLAGS", value }]),
        [],
        format,
      );
      const check = report.checks.find((item) => item.id === "go.build_paths");
      expect(check?.status).toBe("not_observed");
    },
  );

  it.each([
    ["elf", "-Wl,-rpath,@loader_path/Frameworks", "@loader_path/Frameworks"],
    ["mach-o", "-Wl,-rpath,$ORIGIN/../lib", "$ORIGIN/../lib"],
  ] as const)(
    "keeps a token only the other loader expands as a literal path in %s",
    async (format, value, path) => {
      const report = await goReport(
        goModule([{ key: "CGO_LDFLAGS", value }]),
        [],
        format,
      );
      const check = report.checks.find((item) => item.id === "go.build_paths");
      expect(check?.status).toBe("exposed");
      expect(check?.observation.samples).toEqual([path]);
    },
  );
});

describe("ReleaseExposureService Go relative flag paths", () => {
  it("keeps relative paths given to compiler path flags, attached or not", async () => {
    const report = await goReport(
      goModule([
        { key: "CGO_CFLAGS", value: "-Iprivate-sdk -O2 -isystem vendor/sdk" },
        { key: "CGO_LDFLAGS", value: "-Llibs -lssl" },
      ]),
    );
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual([
      "private-sdk",
      "vendor/sdk",
      "libs",
    ]);
  });

  it.each(["--sysroot=private-sdk", "--sysroot private-sdk"])(
    "keeps the relative compiler sysroot in %s",
    async (value) => {
      const report = await goReport(goModule([{ key: "CGO_LDFLAGS", value }]));
      const check = report.checks.find((item) => item.id === "go.build_paths");
      expect(check?.status).toBe("exposed");
      expect(check?.observation.samples).toEqual(["private-sdk"]);
    },
  );

  it.each([
    ["-Wl,-L,private-sdk -lssl", "private-sdk"],
    ["-Wl,-Lprivate-sdk", "private-sdk"],
    ["-Wl,--library-path=private-sdk", "private-sdk"],
    ["-Wl,-T,link.ld", "link.ld"],
    ["-Xlinker -L -Xlinker private-sdk", "private-sdk"],
    ["-Xlinker -Ilib/ld-custom.so", "lib/ld-custom.so"],
    ["-Wl,--dynamic-linker=lib/ld-custom.so", "lib/ld-custom.so"],
    ["-Wl,-dynamic-linker,lib/ld-custom.so", "lib/ld-custom.so"],
    ["-Wl,-Tlink.ld,-Ttext=0x400000", "link.ld"],
  ])(
    "keeps the relative path a compiler forwards in %s",
    async (value, path) => {
      const report = await goReport(goModule([{ key: "CGO_LDFLAGS", value }]));
      const check = report.checks.find((item) => item.id === "go.build_paths");
      expect(check?.status).toBe("exposed");
      expect(check?.observation.samples).toEqual([path]);
    },
  );

  it("does not read forwarded linker switches as paths", async () => {
    const report = await goReport(
      goModule([
        {
          key: "CGO_LDFLAGS",
          value:
            "-Wl,-Bstatic,-lssl,-Bdynamic -Xlinker -Bsymbolic -Wl,-Ttext=0x400000,-Tdata,0x600000 -Xlinker -Ttext-segment=0x10000",
        },
      ]),
    );
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("not_observed");
  });

  it("does not read Go linker arguments as relative paths", async () => {
    const report = await goReport(
      goModule([{ key: "-ldflags", value: "-B gobuildid -T 0x1000 -s -w" }]),
    );
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("not_observed");
  });

  it.each([
    ["-L private-sdk -s -w", "private-sdk"],
    [`"-L private-sdk -s -w"`, "private-sdk"],
    ["-L=private-sdk -s -w", "private-sdk"],
    [`-L "private - sdk" -s -w`, "private - sdk"],
    [`-L "/tmp/private - sdk" -s -w`, "/tmp/private - sdk"],
    [`-s "-L=/tmp/private - sdk" -w`, "/tmp/private - sdk"],
    [`"-L=private - sdk -s -w"`, "private - sdk"],
    ["-X main.version=1 -L private-sdk", "private-sdk"],
  ])("keeps the relative linker directory in %s", async (value, path) => {
    const report = await goReport(
      goModule([{ key: "-ldflags", value: `-B gobuildid ${value}` }]),
    );
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual([path]);
  });

  it.each([
    "all=-L private-sdk -s -w",
    `"all=-L private-sdk -s -w"`,
    "all=-s -L private-sdk",
    "github.com/acme/...=-B gobuildid -L private-sdk",
  ])("reads the package selector once in %s", async (value) => {
    const report = await goReport(goModule([{ key: "-ldflags", value }]));
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual(["private-sdk"]);
  });

  it.each([
    `-X 'main.usage=-L level'`,
    `-X 'main.usage=see -L level'`,
    `-X '-L level'`,
    `-X main.usage=-L level`,
    `--X 'main.usage=-L level'`,
    `all=-X 'main.usage=-L level'`,
    `"-X main.usage=-L level"`,
  ])("does not read the string set by %s as a path", async (value) => {
    const report = await goReport(goModule([{ key: "-ldflags", value }]));
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("not_observed");
  });

  it.each([
    ["-extldflags=-Lprivate-sdk -s -w", "private-sdk"],
    ["-extldflags -Lprivate-sdk -s -w", "private-sdk"],
    [`-extldflags "-L private-sdk -static"`, "private-sdk"],
    [`all=-extldflags '-Wl,-L,private-sdk'`, "private-sdk"],
    [`-extldflags "-Xlinker -L -Xlinker private-sdk"`, "private-sdk"],
    [`-extldflags '-L "/srv/private sdk"'`, "/srv/private sdk"],
    [`-extldflags '-L "/tmp/private - sdk"'`, "/tmp/private - sdk"],
  ])(
    "reads the external linker flags in %s as the compiler driver does",
    async (value, path) => {
      const report = await goReport(goModule([{ key: "-ldflags", value }]));
      const check = report.checks.find((item) => item.id === "go.build_paths");
      expect(check?.status).toBe("exposed");
      expect(check?.observation.samples).toEqual([path]);
    },
  );

  it.each([
    ["CGO_CFLAGS", `-I"/home/O'Neil/include"`, `"/home/O'Neil/include"`],
    ["CGO_CFLAGS", `"-I/home/O'Neil/include"`, "/home/O'Neil/include"],
    ["CGO_CFLAGS", `'-I/home/O"Neil/include'`, `/home/O"Neil/include`],
    ["-ldflags", `-X='main.usage=see -L level'`, "level'"],
  ])("keeps the quotes Go passes on in %s %s", async (key, value, path) => {
    const report = await goReport(goModule([{ key, value }]));
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual([path]);
  });

  it.each([
    [`"-isystem /opt/my sdk/include"`, "/opt/my sdk/include"],
    [`"-I private sdk/include"`, "private sdk/include"],
    [`-I "/opt/private - sdk"`, "/opt/private - sdk"],
  ])("reports %s once, without the separating space", async (value, path) => {
    const report = await goReport(goModule([{ key: "CGO_CFLAGS", value }]));
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual([path]);
    expect(check?.observation.counts.paths).toBe(1);
  });
});

describe("ReleaseExposureService Go linker file operands", () => {
  it.each([
    [
      "-s -w -extldflags=-Wl,--version-script=private-versions.map",
      "private-versions.map",
    ],
    [
      "-extldflags '-Wl,--version-script,private-versions.map'",
      "private-versions.map",
    ],
    ["-extldflags '-Wl,--dynamic-list=exports.list'", "exports.list"],
  ])("reads the linker file operand in %s as a path", async (value, path) => {
    const report = await goReport(goModule([{ key: "-ldflags", value }]));
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual([path]);
  });
});

describe("ReleaseExposureService Go profile path", () => {
  it.each([
    ["private-training.pgo", ["private-training.pgo"]],
    ["/srv/my profiles/a,b.pgo", ["/srv/my profiles/a,b.pgo"]],
    ["auto", []],
    ["off", []],
  ])("reads -pgo %s as one profile path", async (value, samples) => {
    const report = await goReport({
      path: "github.com/acme/app",
      main: null,
      dependencies: [],
      settings: [{ key: "-pgo", value }],
      unparsed_lines: [],
      unparsed_line_bytes_base64: [],
      complete: true,
    });
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe(samples.length > 0 ? "exposed" : "not_observed");
    expect(check?.observation.samples ?? []).toEqual(samples);
  });
});

describe("ReleaseExposureService Go paths", () => {
  it("keeps Go paths with spaces and attached compiler flags whole", async () => {
    const report = await goReport({
      path: "github.com/acme/app",
      main: null,
      dependencies: [],
      settings: [
        { key: "CGO_CFLAGS", value: `"-I/opt/my sdk/include" -O2` },
        {
          key: "CGO_CXXFLAGS",
          value: "-isystem/opt/isystem -iquote /opt/quote",
        },
        { key: "CGO_LDFLAGS", value: `"-L/opt/my libs" -T/opt/link.ld` },
        { key: "-ldflags", value: `-extldflags "-L/srv/ext lib -static"` },
        { key: "-gcflags", value: "all=-trimpath=/src/a=/b" },
        { key: "-pgo", value: "/srv/default.pgo" },
      ],
      unparsed_lines: [],
      unparsed_line_bytes_base64: [],
      complete: true,
    });
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.counts.paths).toBe(9);
    expect(check?.observation.samples).toEqual([
      "/opt/my sdk/include",
      "/opt/isystem",
      "/opt/quote",
      "/opt/my libs",
      "/opt/link.ld",
      "/srv/ext",
      "/src/a",
      "/b",
    ]);
  });

  it("reports Go paths retained in cgo and linker flags", async () => {
    const module = (settings: { key: string; value: string }[]) => ({
      path: "github.com/acme/app",
      main: null,
      dependencies: [],
      settings,
      unparsed_lines: [],
      unparsed_line_bytes_base64: [],
      complete: true,
    });
    const report = await goReport(
      module([
        { key: "CGO_ENABLED", value: "1" },
        { key: "CGO_CFLAGS", value: "-O2 -I/home/ci/private/include" },
        { key: "CGO_LDFLAGS", value: "-L/opt/vendor/lib -Wl,-rpath,/opt/run" },
        { key: "-ldflags", value: "-X main.root=/srv/build -s -w" },
        { key: "vcs.revision", value: "/not/a/flag/setting" },
      ]),
    );
    const check = report.checks.find((item) => item.id === "go.build_paths");
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual([
      "/home/ci/private/include",
      "/opt/vendor/lib",
      "/opt/run",
      "/srv/build",
    ]);
    expect(
      await goStatus(
        module([
          { key: "CGO_CFLAGS", value: "-O2 -g" },
          { key: "-ldflags", value: "-X main.url=https://x.test/y -X a=1/2" },
          { key: "-trimpath", value: "true" },
        ]),
      ),
    ).toBe("not_observed");
  });

  it("counts filesystem paths and leaves module import paths unexposed", async () => {
    const trimmed = await goStatus({
      path: "github.com/acme/app",
      main: {
        path: "github.com/acme/app",
        version: "v1.0.0",
        sum: null,
        replacement: null,
      },
      dependencies: [
        {
          path: "github.com/acme/dep",
          version: "v1.2.3",
          sum: null,
          replacement: null,
        },
      ],
      settings: [],
      unparsed_lines: [],
      unparsed_line_bytes_base64: [],
      complete: true,
    });
    expect(trimmed).toBe("not_observed");
    const rooted = await goStatus({
      path: "github.com/acme/app",
      main: {
        path: "github.com/acme/app",
        version: "v1.0.0",
        sum: null,
        replacement: {
          path: "/Users/dev/main.go",
          version: "v0.0.0",
          sum: null,
        },
      },
      dependencies: [],
      settings: [],
      unparsed_lines: [],
      unparsed_line_bytes_base64: [],
      complete: true,
    });
    expect(rooted).toBe("exposed");
  });

  it.each([null, "/Users/dev/main.go"])(
    "preserves incomplete Go metadata with decoded path %s",
    async (path) => {
      const limitation = "A replacement-path record could not be decoded.";
      const report = await goReport(
        {
          path,
          main: null,
          dependencies: [],
          settings: [],
          unparsed_lines: ["=> undecoded replacement"],
          unparsed_line_bytes_base64: [],
          complete: false,
        },
        [limitation],
      );
      const check = report.checks.find((item) => item.id === "go.build_paths");
      expect(check).toMatchObject({
        status: path === null ? "unknown" : "exposed",
        confidence: path === null ? "inferred" : "observed",
        observation: { counts: { paths: path === null ? 0 : 1 } },
      });
      if (path !== null) expect(check?.observation.samples).toContain(path);
      expect(report.limitations).toContain(limitation);
    },
  );
});

const FILE = `dsf_${"cd".repeat(32)}`;
const CANDIDATE = `dsc_${"ef".repeat(32)}`;

const electronDesktopReport = () => ({
  ...nativeDesktopReport(),
  root: {
    ...nativeDesktopReport().root,
    path: "/work/app",
    canonical_path: "/work/app",
  },
  files: [
    {
      file_id: FILE,
      path: "resources/app.asar",
      local_path: "/work/app/resources/app.asar",
      kind: "file" as const,
      bytes: 10,
      identity: null,
      read_status: "not-selected" as const,
      ranges: [],
      facts: [],
      issues: [],
    },
  ],
  candidates: [
    {
      candidate_id: CANDIDATE,
      family: "electron" as const,
      confidence: "derived" as const,
      basis_file_ids: [FILE],
      rationale: "resources/app.asar",
    },
  ],
});

const safeFuseReport = () => {
  const fuses = Array.from({ length: 6 }, (_, index) =>
    index === 4 || index === 5
      ? ELECTRON_FUSE_STATE_BYTES.enabled
      : ELECTRON_FUSE_STATE_BYTES.disabled,
  );
  const slices: ElectronFuseSlice[] = [
    {
      index: 0,
      file_offset: 0,
      size: 128,
      architecture: "x64",
      sentinel_count: 1,
      sentinels: [
        {
          sentinel_offset: 0,
          wire_version: 1,
          declared_length: fuses.length,
          complete: true,
          fuses: fuses.map((raw, index) => ({
            index,
            name: electronFuseName(1, index),
            state: electronFuseState(raw),
            raw_byte: raw,
          })),
        },
      ],
    },
  ];
  return {
    artifact: {
      selected_path: "/work/app/MyApp.exe",
      resolved_path: "/work/app/MyApp.exe",
      sha256: SHA,
      bytes: 128,
      format: "pe",
    },
    slices,
    ...describeElectronFuseFindings(slices, "pe"),
  };
};

const nativeDesktopReport = () => ({
  root: {
    path: "/work/Native.app",
    canonical_path: "/work/Native.app",
    namespace_id: `dsr_${"ab".repeat(32)}`,
    identity: { device: "1", inode: "2" },
    snapshot_sha256: SHA,
    identity_scope: "examined-metadata-and-read-ranges",
  },
  files: [],
  omissions: [],
  candidates: [],
  components: [],
  next_probes: [],
  coverage: {
    status: "complete-within-scan",
    entries_examined: 1,
    files_probed: 0,
    bytes_read: 0,
    symlinks_not_followed: 0,
    special_entries_omitted: 0,
    limits: { max_entries: 20_000, max_probe_bytes: 8 * 1024 * 1024 },
  },
  limitations: [],
});

const slice = (
  index: number,
  {
    sentinels = 1,
    wireVersion = 1,
    fuses = 6,
    state = ELECTRON_FUSE_STATE_BYTES.disabled,
  }: {
    readonly sentinels?: number;
    readonly wireVersion?: number;
    readonly fuses?: number;
    readonly state?: number;
  } = {},
): ElectronFuseSlice => ({
  index,
  file_offset: index * 256,
  size: 128,
  architecture: index === 0 ? "arm64" : "x86_64",
  sentinel_count: sentinels,
  sentinels:
    sentinels === 0
      ? []
      : [
          {
            sentinel_offset: index * 256,
            wire_version: wireVersion,
            declared_length: fuses,
            complete: true,
            fuses: Array.from({ length: fuses }, (_, fuse) => ({
              index: fuse,
              name: electronFuseName(wireVersion, fuse),
              state: electronFuseState(state),
              raw_byte: state,
            })),
          },
        ],
});

const fuseReport = (slices: readonly ElectronFuseSlice[]) => {
  const container = slices.length > 1 ? "mach-o-universal" : "mach-o";
  return {
    artifact: {
      selected_path: "/work/app",
      resolved_path: "/work/app",
      sha256: SHA,
      bytes: 4096,
      format: container,
    },
    slices,
    ...describeElectronFuseFindings(slices, container),
  };
};

const goStatus = async (
  module: NonNullable<GoBinary["build_info"]>["module"],
): Promise<string | undefined> =>
  (await goReport(module)).checks.find((check) => check.id === "go.build_paths")
    ?.status;

const goBinaryReport = (
  module: NonNullable<GoBinary["build_info"]>["module"],
  limitations: string[] = [],
): GoBinary => {
  const moduleBytes = Buffer.from("module");
  return {
    artifact: {
      path: "/work/app",
      sha256: SHA,
      bytes: 4096,
    },
    format: "elf",
    architecture: "arm64",
    bits: 64,
    byte_order: "little",
    build_info: {
      header_offset: 0,
      encoding: "inline",
      go_version: "go1.22.0",
      go_version_bytes_base64: "/w==",
      module_text: "module",
      module_bytes_base64: moduleBytes.toString("base64"),
      version_location: { offset: 0, bytes: 1 },
      module_location: { offset: 1, bytes: moduleBytes.length },
      module,
    },
    limitations,
  };
};

const goReport = async (
  module: NonNullable<GoBinary["build_info"]>["module"],
  limitations: string[] = [],
  format: "elf" | "mach-o" = "elf",
) => {
  const { service, goBinaries } = owners(
    scan({ native_images: [{ path: "/work/app", format }] }),
  );
  goBinaries.inspect.mockResolvedValue(
    ok(evidence(goBinaryReport(module, limitations))),
  );
  const result = await service.inspect({ path: "/work/app" });
  if (!result.ok) throw result.error;
  return releaseExposureReportSchema.parse(result.value.normalized_result);
};

describe("ReleaseExposureService Go tool path options", () => {
  const buildPaths = async (key: string, value: string) => {
    const report = await goReport(goModule([{ key, value }]));
    return report.checks.find((item) => item.id === "go.build_paths");
  };

  it.each([
    ["-gcflags", "-I private-sdk"],
    ["-gcflags", "-I=private-sdk"],
    ["-gcflags", "--I private-sdk"],
    ["-gcflags", "all=-N -l -I private-sdk"],
    ["-gcflags", "-importcfg private-sdk"],
    ["-gcflags", "-trimpath private-sdk"],
    ["-asmflags", "-I private-sdk"],
    ["-asmflags", "all=-trimpath=private-sdk"],
  ])("finds the relative path in %s %s", async (key, value) => {
    const check = await buildPaths(key, value);
    expect(check?.status).toBe("exposed");
    expect(check?.observation.samples).toEqual(["private-sdk"]);
  });

  it.each([
    ["-gcflags", "all=-N -l"],
    ["-gcflags", "-p main -lang go1.26 -m"],
    ["-gcflags", "-X main.path=private-sdk"],
    ["-asmflags", "-D GOAMD64_v1 -p main"],
  ])("finds no path in %s %s", async (key, value) => {
    expect((await buildPaths(key, value))?.status).toBe("not_observed");
  });
});

describe("ReleaseExposureService undecoded metadata", () => {
  const statuses = async (undecodedContent: boolean) => {
    const { service, goBinaries, rustBinaries } = owners(
      scan({ native_images: [{ path: "/work/app", format: "elf" }] }),
    );
    for (const [owner, operation] of [
      [goBinaries, "inspect_go_binary"],
      [rustBinaries, "inspect_rust_binary"],
    ] as const)
      owner.inspect.mockResolvedValue(
        err(
          new AnalysisUnsupportedTargetError(
            operation,
            "/work/app",
            "Compressed section",
            { undecodedContent },
          ),
        ),
      );
    const result = await service.inspect({ path: "/work/app" });
    if (!result.ok) throw result.error;
    const { checks } = releaseExposureReportSchema.parse(
      result.value.normalized_result,
    );
    return ["go.build_paths", "rust.dependency_metadata"].map(
      (id) => checks.find((check) => check.id === id)?.status,
    );
  };

  it("stays unknown when the image holds metadata it cannot decode", async () => {
    expect(await statuses(true)).toEqual(["unknown", "unknown"]);
  });

  it("stays not applicable when the target itself is unsupported", async () => {
    expect(await statuses(false)).toEqual(["not_applicable", "not_applicable"]);
  });
});

describe("ReleaseExposureService unnamed Electron hosts", () => {
  const nodeStatus = async (sentinels: number[]) => {
    const paths = sentinels.map(
      (_, index) => `/work/app/image${String(index)}.exe`,
    );
    const { service, desktop, electronFuses } = owners(directoryScan(paths));
    desktop.inspect.mockResolvedValue(ok(evidence(electronDesktopReport())));
    for (const count of sentinels)
      electronFuses.inspect.mockResolvedValueOnce(
        ok(evidence(fuseReport([slice(0, { sentinels: count })]))),
      );
    return (await runAsNode(service))?.status;
  };

  it("keeps safe fuses unknown when a possible host holds no fuses", async () => {
    expect(await nodeStatus([0, 1])).toBe("unknown");
    expect(await nodeStatus([1, 0])).toBe("unknown");
  });

  it("settles safe fuses when every possible host reports them", async () => {
    expect(await nodeStatus([1, 1])).toBe("not_observed");
  });
});
