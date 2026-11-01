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
        async (_input, _options, visitText) => {
          for (const [text, location] of textMembers) visitText(text, location);
          return ok(scanned);
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

describe("ReleaseExposureService Electron applicability", () => {
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

  it("keeps safe fuses decided when inventory stopped after the hinted executable", async () => {
    const { service, desktop, electronFuses } = owners({
      ...directoryScan(["/work/app/MyApp.exe"]),
      coverage: "unknown",
    });
    desktop.inspect.mockResolvedValue(ok(evidence(electronDesktopReport())));
    electronFuses.inspect.mockResolvedValue(
      ok(evidence(fuseReport([slice(0)]))),
    );
    expect((await runAsNode(service))?.status).toBe("not_observed");
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
        { key: "CGO_LDFLAGS", value: `-L'/opt/my libs' -T/opt/link.ld` },
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
      "/srv/ext lib",
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
) => {
  const { service, goBinaries } = owners(
    scan({ native_images: [{ path: "/work/app", format: "elf" }] }),
  );
  goBinaries.inspect.mockResolvedValue(
    ok(evidence(goBinaryReport(module, limitations))),
  );
  const result = await service.inspect({ path: "/work/app" });
  if (!result.ok) throw result.error;
  return releaseExposureReportSchema.parse(result.value.normalized_result);
};
