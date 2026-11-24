import { describe, expect, it } from "vitest";

import {
  assembleReleaseExposureReport,
  exposureMeetsFailOn,
  PACKAGED_NATIVE_IMAGES,
  releaseExposureReportSchema,
  type ReleaseExposureCheckId,
  type ReleaseExposureOwnerFacts,
  type ReleaseExposureScan,
} from "./releaseExposure.js";

const SHA = "ab".repeat(32);

const scan = (
  overrides: Partial<ReleaseExposureScan> = {},
): ReleaseExposureScan => ({
  target: {
    selected_path: "/work/app",
    kind: "directory",
    format: "directory",
    sha256: null,
  },
  subject: { path: "/work/app", sha256: SHA, format: "directory" },
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
  text_members: { scanned: 1, skipped: 0 },
  coverage: "complete",
  omitted: [],
  limitations: [],
  ...overrides,
});

const owners = (
  overrides: Partial<ReleaseExposureOwnerFacts> = {},
): ReleaseExposureOwnerFacts => ({
  electron_family: "not_electron",
  fuse_images: [],
  go_images: [],
  rust_images: [],
  credential_markers: { hits: [], omitted_hits: 0 },
  ...overrides,
});

const reportFor = (
  scanned: ReleaseExposureScan = scan(),
  ownerFacts: ReleaseExposureOwnerFacts = owners(),
) => assembleReleaseExposureReport(scanned, ownerFacts);

/** A reported check's status, or `inapplicable` when the check was omitted. */
const statusOf = (
  report: ReturnType<typeof reportFor>,
  id: ReleaseExposureCheckId,
) =>
  report.coverage.inapplicable_checks.includes(id)
    ? "inapplicable"
    : report.checks.find((check) => check.id === id)?.status;

const ALL_CHECKS: readonly ReleaseExposureCheckId[] = [
  "javascript.source_map_sources",
  "javascript.source_maps",
  "electron.run_as_node",
  "electron.asar_integrity",
  "electron.only_load_from_asar",
  "electron.node_cli_inspect",
  "packaging.extractable_payload",
  "native.debug_companions",
  "native.pdb_path",
  "go.build_paths",
  "rust.dependency_metadata",
  "text.credential_markers",
  "native.hardening",
  "macho.hardened_runtime",
  "android.manifest",
];

const executable = (
  format: "pe" | "mach-o",
  overrides: Partial<ReleaseExposureScan> = {},
) =>
  scan({
    target: {
      selected_path: "/work/app.bin",
      kind: "executable",
      format,
      sha256: SHA,
    },
    subject: { path: "/work/app.bin", sha256: SHA, format },
    native_images: [{ path: "/work/app.bin", format, sha256: SHA }],
    pdb: { examined: format === "pe" ? 1 : 0, paths: [], failed: 0 },
    text_members: { scanned: 0, skipped: 0 },
    ...overrides,
  });

describe("release exposure checks", () => {
  it("splits the fixed check table between rows and inapplicable checks, in order", () => {
    const report = reportFor(
      scan({
        native_images: [{ path: "/work/app/bin", format: "elf" }],
        pdb: { examined: 1, paths: [], failed: 0 },
      }),
      owners({
        electron_family: "unknown",
        go_images: [{ kind: "absent" }],
        rust_images: [{ kind: "absent" }],
      }),
    );
    expect(report.checks.map((check) => check.id)).toEqual(
      ALL_CHECKS.filter((id) => id !== "macho.hardened_runtime"),
    );
    expect(report.coverage.inapplicable_checks).toEqual([
      "macho.hardened_runtime",
    ]);
    expect(report.limitations[0]).toMatch(
      /static analysis.*does not establish.*secure/u,
    );
    expect(report.summary.no_exposure_observed_in_assessed_checks).toBe(true);
    expect(report.summary.by_status.not_assessed).toBe(2);
    expect(report.summary.highest_exposed_severity).toBeNull();
    expect(statusOf(report, "native.hardening")).toBe("not_assessed");
    expect(statusOf(report, "android.manifest")).toBe("not_assessed");
  });
});

describe("release exposure format applicability", () => {
  it("omits checks that cannot apply to a single PE and names them in coverage", () => {
    const report = reportFor(
      executable("pe", {
        pdb: { examined: 1, paths: ["C:\\build\\app.pdb"], failed: 0 },
      }),
      owners({
        electron_family: "not_a_directory",
        go_images: [{ kind: "absent" }],
        rust_images: [{ kind: "absent" }],
      }),
    );
    expect(report.coverage.inapplicable_checks).toEqual([
      "javascript.source_map_sources",
      "javascript.source_maps",
      "electron.run_as_node",
      "electron.asar_integrity",
      "electron.only_load_from_asar",
      "electron.node_cli_inspect",
      "text.credential_markers",
      "macho.hardened_runtime",
      "android.manifest",
    ]);
    expect(statusOf(report, "native.pdb_path")).toBe("exposed");
    expect(statusOf(report, "native.hardening")).toBe("not_assessed");
    expect(report.summary.by_status).toEqual({
      exposed: 1,
      not_observed: 2,
      unknown: 2,
      not_assessed: 1,
    });
    expect(
      report.checks.flatMap((check) =>
        check.next_probe === null ? [] : [check.next_probe],
      ),
    ).toEqual([
      "inspect_artifact",
      "inspect_go_binary",
      "inspect_rust_binary",
      "inspect_binary_hardening",
    ]);
  });

  it("keeps the Mach-O check on a Mach-O executable and omits the PE one", () => {
    const report = reportFor(
      executable("mach-o"),
      owners({ electron_family: "not_a_directory" }),
    );
    expect(statusOf(report, "macho.hardened_runtime")).toBe("not_assessed");
    expect(statusOf(report, "native.pdb_path")).toBe("inapplicable");
    expect(statusOf(report, "android.manifest")).toBe("inapplicable");
  });

  it("keeps JavaScript checks on an executable that embeds a package", () => {
    const report = reportFor(
      executable("pe", {
        extractable: {
          formats: ["node-sea"],
          readable_members: 0,
          unreadable_members: 0,
          samples: [],
        },
      }),
      owners({ electron_family: "not_a_directory" }),
    );
    expect(statusOf(report, "javascript.source_map_sources")).toBe(
      "not_observed",
    );
    expect(statusOf(report, "javascript.source_maps")).toBe("not_observed");
  });

  it("keeps the Mach-O check on a PE bundle whose packaged images are unread", () => {
    const report = reportFor(
      executable("pe", {
        extractable: {
          formats: ["dotnet-bundle"],
          readable_members: 1,
          unreadable_members: 0,
          samples: ["helper"],
        },
        omitted: [
          {
            subject: PACKAGED_NATIVE_IMAGES,
            count: 1,
            reason: "stored inside a package",
          },
        ],
      }),
      owners({ electron_family: "not_a_directory" }),
    );
    expect(statusOf(report, "macho.hardened_runtime")).toBe("not_assessed");
    expect(statusOf(report, "android.manifest")).toBe("inapplicable");
    expect(
      report.checks.find(({ id }) => id === "macho.hardened_runtime")
        ?.next_probe,
    ).toBe("inspect_signature");
  });

  it("omits native and Android checks on a fully read ASAR with only text", () => {
    const report = reportFor(
      scan({
        target: {
          selected_path: "/work/app.asar",
          kind: "asar",
          format: "asar",
          sha256: SHA,
        },
        subject: { path: "/work/app.asar", sha256: SHA, format: "asar" },
        extractable: {
          formats: ["asar"],
          readable_members: 2,
          unreadable_members: 0,
          samples: ["app.js"],
        },
      }),
    );
    expect(statusOf(report, "native.hardening")).toBe("inapplicable");
    expect(statusOf(report, "macho.hardened_runtime")).toBe("inapplicable");
    expect(statusOf(report, "android.manifest")).toBe("inapplicable");
    expect(statusOf(report, "packaging.extractable_payload")).toBe("exposed");
  });
});

describe("release exposure report split invariant", () => {
  it("rejects reports whose rows and inapplicable checks do not split the table", () => {
    const valid = reportFor(
      executable("pe"),
      owners({ electron_family: "not_a_directory" }),
    );
    expect(releaseExposureReportSchema.safeParse(valid).success).toBe(true);
    const [first, second] = valid.coverage.inapplicable_checks;
    if (first === undefined || second === undefined)
      throw new Error("Expected inapplicable checks");
    const reported = valid.checks[0];
    if (reported === undefined) throw new Error("Expected a reported check");
    const variants = {
      duplicate: [first, first, ...valid.coverage.inapplicable_checks.slice(1)],
      overlapping: [...valid.coverage.inapplicable_checks, reported.id],
      missing: valid.coverage.inapplicable_checks.slice(1),
      reordered: [
        second,
        first,
        ...valid.coverage.inapplicable_checks.slice(2),
      ],
    };
    for (const [label, inapplicable] of Object.entries(variants))
      expect(
        releaseExposureReportSchema.safeParse({
          ...valid,
          coverage: { ...valid.coverage, inapplicable_checks: inapplicable },
        }).success,
        label,
      ).toBe(false);
    expect(
      releaseExposureReportSchema.safeParse({
        ...valid,
        checks: [...valid.checks].reverse(),
      }).success,
    ).toBe(false);
  });
});

describe("release exposure applicability with unread members", () => {
  it("keeps format-gated checks on a directory whose native images may be unread", () => {
    const report = reportFor(
      scan({
        omitted: [
          {
            subject: "native images",
            count: 1,
            reason: "later native images were dropped",
          },
        ],
      }),
    );
    expect(statusOf(report, "native.hardening")).toBe("not_assessed");
    expect(statusOf(report, "macho.hardened_runtime")).toBe("not_assessed");
    expect(statusOf(report, "android.manifest")).toBe("not_assessed");
  });
});

describe("release exposure check outcomes", () => {
  it("grades shipped source maps separately from embedded sources", () => {
    const embedded = reportFor(
      scan({
        source_maps: {
          embedded: 1,
          without_sources: 0,
          unparsed: 0,
          skipped: 0,
          samples: ["app.js.map"],
        },
      }),
    );
    expect(statusOf(embedded, "javascript.source_map_sources")).toBe("exposed");
    expect(embedded.checks[0]?.severity).toBe("high");
    expect(embedded.checks[0]?.locations).toEqual([
      { kind: "artifact-path", path: "app.js.map" },
    ]);
    expect(statusOf(embedded, "javascript.source_maps")).toBe("not_observed");
    expect(exposureMeetsFailOn(embedded, "high")).toBe(true);

    const mapsOnly = reportFor(
      scan({
        source_maps: {
          embedded: 0,
          without_sources: 2,
          unparsed: 0,
          skipped: 0,
          samples: ["vendor.js.map"],
        },
      }),
    );
    expect(statusOf(mapsOnly, "javascript.source_maps")).toBe("exposed");
    expect(mapsOnly.checks[1]?.severity).toBe("medium");
    expect(exposureMeetsFailOn(mapsOnly, "high")).toBe(false);
    expect(exposureMeetsFailOn(mapsOnly, "medium")).toBe(true);
    expect(exposureMeetsFailOn(mapsOnly, "low")).toBe(true);
  });

  it("leaves an unread map unknown unless a confirmed category is already exposed", () => {
    const report = reportFor(
      scan({
        source_maps: {
          embedded: 1,
          without_sources: 0,
          unparsed: 1,
          skipped: 0,
          samples: ["app.js.map", "broken.js.map"],
        },
      }),
    );
    expect(statusOf(report, "javascript.source_map_sources")).toBe("exposed");
    expect(statusOf(report, "javascript.source_maps")).toBe("unknown");
  });
});

describe("release exposure fuse and package checks", () => {
  it("derives Electron exposure from fuse outcomes and leaves a missing wire unknown only for Electron", () => {
    const insecure = reportFor(
      scan(),
      owners({
        electron_family: "electron",
        fuse_images: [
          {
            kind: "report",
            role: "app-bundle",
            implications: [
              { subject: "electron_run_as_node", outcome: "honored" },
              {
                subject: "node_cli_inspect_arguments",
                outcome: "honored",
              },
              {
                subject: "embedded_asar_integrity_validation",
                outcome: "not_enforced",
              },
              {
                subject: "only_load_app_from_asar",
                outcome: "not_restricted_to_app_asar",
              },
            ],
          },
        ],
      }),
    );
    expect(statusOf(insecure, "electron.run_as_node")).toBe("exposed");
    expect(statusOf(insecure, "electron.node_cli_inspect")).toBe("exposed");
    expect(statusOf(insecure, "electron.asar_integrity")).toBe("exposed");
    expect(statusOf(insecure, "electron.only_load_from_asar")).toBe("exposed");
    expect(insecure.checks[2]?.confidence).toBe("inferred");
    expect(insecure.checks[2]?.severity).toBe("high");

    const flipped = reportFor(
      scan(),
      owners({
        electron_family: "electron",
        fuse_images: [
          {
            kind: "report",
            role: "native-image",
            implications: [
              { subject: "electron_run_as_node", outcome: "not_honored" },
              {
                subject: "node_cli_inspect_arguments",
                outcome: "not_honored",
              },
              {
                subject: "embedded_asar_integrity_validation",
                outcome: "unknown",
              },
              {
                subject: "only_load_app_from_asar",
                outcome: "restricted_to_app_asar",
              },
            ],
          },
        ],
      }),
    );
    expect(statusOf(flipped, "electron.run_as_node")).toBe("not_observed");
    expect(statusOf(flipped, "electron.node_cli_inspect")).toBe("not_observed");
    expect(statusOf(flipped, "electron.asar_integrity")).toBe("unknown");
    expect(statusOf(flipped, "electron.only_load_from_asar")).toBe(
      "not_observed",
    );
    expect(flipped.checks[2]?.severity).toBeNull();

    const plain = reportFor(
      scan(),
      owners({
        electron_family: "not_a_directory",
        fuse_images: [
          {
            kind: "report",
            role: "native-image",
            implications: [],
          },
        ],
      }),
    );
    expect(statusOf(plain, "electron.run_as_node")).toBe("inapplicable");

    const bundle = reportFor(
      scan(),
      owners({
        electron_family: "electron",
        fuse_images: [
          {
            kind: "report",
            role: "app-bundle",
            implications: [],
          },
        ],
      }),
    );
    expect(statusOf(bundle, "electron.run_as_node")).toBe("unknown");

    const nativeApp = reportFor(
      scan(),
      owners({
        electron_family: "not_electron",
        fuse_images: [
          {
            kind: "report",
            role: "app-bundle",
            path: "/work/Native.app",
            implications: [],
          },
        ],
      }),
    );
    expect(statusOf(nativeApp, "electron.run_as_node")).toBe("inapplicable");
    expect(statusOf(nativeApp, "electron.asar_integrity")).toBe("inapplicable");
  });
});

describe("release exposure fuse sampling", () => {
  it.each(["not_a_directory", "not_electron"] as const)(
    "keeps fuse applicability unknown for an unread packaged native image under %s",
    (family) => {
      const report = reportFor(
        scan({
          omitted: [
            {
              subject: PACKAGED_NATIVE_IMAGES,
              count: 1,
              reason: "stored inside a package",
            },
          ],
        }),
        owners({
          electron_family: family,
          fuse_images: [
            { kind: "report", role: "native-image", implications: [] },
          ],
        }),
      );
      expect(statusOf(report, "electron.run_as_node")).toBe("unknown");
    },
  );

  it("keeps a directly selected Electron executable observed when its fuses are safe", () => {
    const safe = reportFor(
      scan({
        target: {
          selected_path: "/work/MyApp.exe",
          kind: "executable",
          format: "pe",
          sha256: SHA,
        },
      }),
      owners({
        electron_family: "not_a_directory",
        fuse_images: [
          {
            kind: "report",
            role: "native-image",
            path: "/work/MyApp.exe",
            implications: [
              { subject: "electron_run_as_node", outcome: "not_honored" },
              {
                subject: "node_cli_inspect_arguments",
                outcome: "not_honored",
              },
              {
                subject: "embedded_asar_integrity_validation",
                outcome: "enforced",
              },
              {
                subject: "only_load_app_from_asar",
                outcome: "restricted_to_app_asar",
              },
            ],
          },
        ],
      }),
    );
    expect(statusOf(safe, "electron.run_as_node")).toBe("not_observed");
    expect(statusOf(safe, "electron.asar_integrity")).toBe("not_observed");

    const uncertain = reportFor(
      scan(),
      owners({
        electron_family: "not_a_directory",
        fuse_images: [
          {
            kind: "report",
            role: "native-image",
            implications: [
              { subject: "electron_run_as_node", outcome: "unknown" },
            ],
          },
        ],
      }),
    );
    expect(statusOf(uncertain, "electron.run_as_node")).toBe("unknown");

    const failed = reportFor(
      scan(),
      owners({
        electron_family: "not_a_directory",
        fuse_images: [
          {
            kind: "failed",
            role: "native-image",
            path: "/work/MyApp.exe",
            reason: "inspect_electron_fuses failed",
          },
        ],
      }),
    );
    expect(statusOf(failed, "electron.run_as_node")).toBe("unknown");
    expect(
      failed.checks.find((check) => check.id === "electron.run_as_node")
        ?.observation.samples,
    ).toContain("inspect_electron_fuses failed");
  });
});

describe("release exposure unread fuse images", () => {
  it("does not treat a partial native sample as an absent fuse", () => {
    const sampled = scan({
      omitted: [
        {
          subject: "native images",
          count: 1,
          reason:
            "Only 4 native images are passed to language and fuse readers.",
        },
      ],
    });
    const implications = [
      { subject: "electron_run_as_node", outcome: "not_honored" },
    ];
    const omitted = reportFor(
      sampled,
      owners({
        electron_family: "electron",
        fuse_images: [{ kind: "report", role: "native-image", implications }],
      }),
    );
    expect(statusOf(omitted, "electron.run_as_node")).toBe("unknown");

    const included = reportFor(
      sampled,
      owners({
        electron_family: "electron",
        electron_executable_included: true,
        fuse_images: [{ kind: "report", role: "native-image", implications }],
      }),
    );
    expect(statusOf(included, "electron.run_as_node")).toBe("not_observed");
  });

  it("does not treat a packaged native image as an absent fuse, even once the host was read", () => {
    const packaged = scan({
      omitted: [
        {
          subject: PACKAGED_NATIVE_IMAGES,
          count: 1,
          reason: "Fuse readers run on files on disk.",
        },
      ],
    });
    const fuseFacts = {
      electron_family: "unknown" as const,
      fuse_images: [
        {
          kind: "report" as const,
          role: "native-image" as const,
          implications: [
            { subject: "electron_run_as_node", outcome: "not_honored" },
          ],
        },
      ],
    };
    expect(
      statusOf(
        reportFor(
          packaged,
          owners({ ...fuseFacts, electron_executable_included: false }),
        ),
        "electron.run_as_node",
      ),
    ).toBe("unknown");
    expect(
      statusOf(
        reportFor(
          packaged,
          owners({ ...fuseFacts, electron_executable_included: true }),
        ),
        "electron.run_as_node",
      ),
    ).toBe("unknown");
  });

  it("does not treat a partial desktop layout list as an absent fuse", () => {
    const fuseFacts = {
      electron_family: "electron" as const,
      electron_executable_included: true,
      fuse_images: [
        {
          kind: "report" as const,
          role: "native-image" as const,
          implications: [
            { subject: "electron_run_as_node", outcome: "not_honored" },
          ],
        },
      ],
    };
    expect(
      statusOf(
        reportFor(
          scan({}),
          owners({ ...fuseFacts, electron_layouts_complete: false }),
        ),
        "electron.run_as_node",
      ),
    ).toBe("unknown");
    expect(
      statusOf(reportFor(scan({}), owners(fuseFacts)), "electron.run_as_node"),
    ).toBe("not_observed");
  });

  it("does not treat incomplete inventory as an absent fuse", () => {
    const fuseFacts = {
      electron_family: "electron" as const,
      fuse_images: [
        {
          kind: "report" as const,
          role: "native-image" as const,
          implications: [
            { subject: "electron_run_as_node", outcome: "not_honored" },
          ],
        },
      ],
    };
    const incomplete = scan({ coverage: "unknown" });
    expect(
      statusOf(
        reportFor(incomplete, owners(fuseFacts)),
        "electron.run_as_node",
      ),
    ).toBe("unknown");
    expect(
      statusOf(
        reportFor(
          incomplete,
          owners({ ...fuseFacts, electron_executable_included: true }),
        ),
        "electron.run_as_node",
      ),
    ).toBe("not_observed");
  });
});

describe("release exposure package checks", () => {
  it("treats readable package members as inherent exposure and skips encrypted members", () => {
    const exposed = reportFor(
      scan({
        target: {
          selected_path: "/work/app.asar",
          kind: "asar",
          format: "asar",
          sha256: SHA,
        },
        extractable: {
          formats: ["asar"],
          readable_members: 2,
          unreadable_members: 0,
          samples: ["app.js"],
        },
      }),
    );
    expect(statusOf(exposed, "packaging.extractable_payload")).toBe("exposed");
    expect(
      exposed.checks.find(
        (check) => check.id === "packaging.extractable_payload",
      )?.severity,
    ).toBe("low");
    expect(exposureMeetsFailOn(exposed, "medium")).toBe(false);
    expect(exposureMeetsFailOn(exposed, "low")).toBe(true);

    const sealed = reportFor(
      scan({
        extractable: {
          formats: ["asar"],
          readable_members: 0,
          unreadable_members: 3,
          samples: [],
        },
      }),
    );
    expect(statusOf(sealed, "packaging.extractable_payload")).toBe("unknown");

    const unread = reportFor(
      scan({
        extractable: {
          formats: [],
          readable_members: 0,
          unreadable_members: 1,
          samples: [],
        },
      }),
    );
    expect(statusOf(unread, "packaging.extractable_payload")).toBe("unknown");
  });
});

describe("release exposure native and text checks", () => {
  it("reports debug companions and CodeView paths separately from source maps", () => {
    const report = reportFor(
      scan({
        debug_companions: { paths: ["/work/app.pdb"], skipped: 0 },
        pdb: {
          examined: 1,
          paths: ["C:\\build\\app.pdb"],
          image_paths: ["/work/app.exe"],
          failed: 0,
        },
      }),
    );
    expect(
      report.checks.find((check) => check.id === "native.debug_companions"),
    ).toMatchObject({
      status: "exposed",
      confidence: "inferred",
      locations: [{ kind: "artifact-path", path: "/work/app.pdb" }],
    });
    expect(
      report.checks.find((check) => check.id === "native.pdb_path"),
    ).toMatchObject({
      status: "exposed",
      severity: "low",
      locations: [{ kind: "artifact-path", path: "/work/app.exe" }],
      observation: { samples: ["C:\\build\\app.pdb"] },
    });
  });

  it("keeps null Go and Rust metadata unknown and unsupported images inapplicable", () => {
    const unknown = reportFor(
      scan(),
      owners({
        go_images: [{ kind: "absent" }],
        rust_images: [{ kind: "absent" }],
      }),
    );
    expect(statusOf(unknown, "go.build_paths")).toBe("unknown");
    expect(statusOf(unknown, "rust.dependency_metadata")).toBe("unknown");

    const exposed = reportFor(
      scan(),
      owners({
        rust_images: [{ kind: "packages", packages: ["app"] }],
      }),
    );
    expect(statusOf(exposed, "rust.dependency_metadata")).toBe("exposed");

    const omitted = reportFor(
      scan({
        omitted: [
          {
            subject: "native images",
            count: 2,
            reason: "later native images were dropped",
          },
        ],
      }),
      owners({
        go_images: [{ kind: "unsupported" }],
        rust_images: [],
      }),
    );
    expect(statusOf(omitted, "go.build_paths")).toBe("unknown");
    expect(statusOf(omitted, "rust.dependency_metadata")).toBe("unknown");

    const other = reportFor(
      scan(),
      owners({
        go_images: [{ kind: "unsupported" }],
        rust_images: [{ kind: "unsupported" }],
      }),
    );
    expect(statusOf(other, "go.build_paths")).toBe("inapplicable");
    expect(statusOf(other, "rust.dependency_metadata")).toBe("inapplicable");
  });
});

describe("release exposure gate and undecided checks", () => {
  it("does not let unknown or unassessed checks trip the gate", () => {
    const report = reportFor(
      scan({
        source_maps: {
          embedded: 0,
          without_sources: 0,
          unparsed: 1,
          skipped: 0,
          samples: ["broken.js.map"],
        },
      }),
    );
    expect(report.summary.by_status.unknown).toBeGreaterThan(0);
    expect(report.summary.by_status.not_assessed).toBe(1);
    expect(exposureMeetsFailOn(report, "low")).toBe(false);
    expect(report.summary.no_exposure_observed_in_assessed_checks).toBe(true);
  });

  it("does not treat an unscanned text member as an absent credential", () => {
    const report = reportFor(
      scan({ text_members: { scanned: 0, skipped: 0 } }),
    );
    expect(statusOf(report, "text.credential_markers")).toBe("inapplicable");
    const scanned = reportFor();
    expect(statusOf(scanned, "text.credential_markers")).toBe("not_observed");
    const skipped = reportFor(
      scan({ text_members: { scanned: 1, skipped: 1 } }),
    );
    expect(statusOf(skipped, "text.credential_markers")).toBe("unknown");
  });

  it("does not report absent CodeView paths when member coverage is unknown", () => {
    const report = reportFor(
      scan({
        pdb: { examined: 1, paths: [], failed: 0 },
        coverage: "unknown",
      }),
    );
    expect(statusOf(report, "native.pdb_path")).toBe("unknown");
  });

  it("keeps Go and Rust unknown while a packaged native image is unexamined", () => {
    const report = reportFor(
      scan({
        omitted: [
          {
            subject: PACKAGED_NATIVE_IMAGES,
            count: 1,
            reason: "stored inside a package",
          },
        ],
      }),
    );
    expect(statusOf(report, "go.build_paths")).toBe("unknown");
    expect(statusOf(report, "rust.dependency_metadata")).toBe("unknown");
  });

  it("names the real @electron/fuses option on every fuse remediation", () => {
    const fuses = reportFor(
      scan(),
      owners({ electron_family: "unknown" }),
    ).checks.filter((check) => check.id.startsWith("electron."));
    expect(fuses).toHaveLength(4);
    for (const check of fuses) {
      expect(check.remediation).toContain("FuseV1Options.");
      expect(check.remediation).toContain("@electron/fuses");
      expect(check.remediation).not.toContain("ElectronFuseV1");
    }
  });
});

describe("go.build_paths locations", () => {
  it("names only the images that retain build paths", () => {
    const report = reportFor(
      scan(),
      owners({
        go_images: [
          { kind: "paths", path: "/work/leaky", paths: ["/home/dev/main.go"] },
          { kind: "paths", path: "/work/clean", paths: [] },
        ],
      }),
    );
    const go = report.checks.find((check) => check.id === "go.build_paths");
    expect(go?.status).toBe("exposed");
    expect(go?.locations).toEqual([
      { kind: "artifact-path", path: "/work/leaky" },
    ]);
    expect(go?.observation.samples).toEqual(["/home/dev/main.go"]);
  });
});

describe("electron host fuses beside other images", () => {
  const safeImage = {
    kind: "report" as const,
    role: "native-image" as const,
    path: "/work/app/helper",
    implications: [
      { subject: "electron_run_as_node", outcome: "not_honored" },
      { subject: "node_cli_inspect_arguments", outcome: "not_honored" },
      { subject: "embedded_asar_integrity_validation", outcome: "enforced" },
      { subject: "only_load_app_from_asar", outcome: "restricted_to_app_asar" },
    ],
  };
  const hostWithoutFuses = {
    kind: "report" as const,
    role: "native-image" as const,
    path: "/work/app/app",
    implications: [],
  };
  const report = (electron_host_paths?: readonly string[]) =>
    reportFor(
      scan(),
      owners({
        electron_family: "electron",
        electron_executable_included: true,
        ...(electron_host_paths === undefined ? {} : { electron_host_paths }),
        fuse_images: [hostWithoutFuses, safeImage],
      }),
    );

  it("leaves an unresolved host unknown whatever another image reports", () => {
    expect(statusOf(report(["/work/app/app"]), "electron.run_as_node")).toBe(
      "unknown",
    );
  });

  it("does not let a fuseless helper unsettle the host's safe answer", () => {
    expect(statusOf(report(["/work/app/helper"]), "electron.run_as_node")).toBe(
      "not_observed",
    );
    expect(statusOf(report(), "electron.run_as_node")).toBe("not_observed");
  });
});
