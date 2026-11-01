import { describe, expect, it } from "vitest";

import {
  assembleReleaseExposureReport,
  exposureMeetsFailOn,
  PACKAGED_NATIVE_IMAGES,
  RELEASE_EXPOSURE_CHECK_IDS,
  RELEASE_EXPOSURE_LIMITATION,
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

const statusOf = (
  report: ReturnType<typeof reportFor>,
  id: (typeof RELEASE_EXPOSURE_CHECK_IDS)[number],
) => report.checks.find((check) => check.id === id)?.status;

describe("release exposure checks", () => {
  it("keeps the fixed check order and the security limitation", () => {
    const report = reportFor();
    expect(report.checks.map((check) => check.id)).toEqual([
      ...RELEASE_EXPOSURE_CHECK_IDS,
    ]);
    expect(report.limitations[0]).toBe(RELEASE_EXPOSURE_LIMITATION);
    expect(report.summary.no_exposure_observed_in_assessed_checks).toBe(true);
    expect(report.summary.by_status.not_assessed).toBe(3);
    expect(report.summary.highest_exposed_severity).toBeNull();
    expect(statusOf(report, "native.hardening")).toBe("not_assessed");
    expect(statusOf(report, "macho.hardened_runtime")).toBe("not_assessed");
    expect(statusOf(report, "android.manifest")).toBe("not_assessed");
  });

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
    expect(statusOf(plain, "electron.run_as_node")).toBe("not_applicable");

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
    expect(statusOf(nativeApp, "electron.run_as_node")).toBe("not_applicable");
    expect(statusOf(nativeApp, "electron.asar_integrity")).toBe(
      "not_applicable",
    );
  });
});

describe("release exposure fuse sampling", () => {
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
    expect(statusOf(report, "native.debug_companions")).toBe("exposed");
    expect(
      report.checks.find((check) => check.id === "native.debug_companions")
        ?.locations,
    ).toEqual([{ kind: "artifact-path", path: "/work/app.pdb" }]);
    expect(statusOf(report, "native.pdb_path")).toBe("exposed");
    const pdb = report.checks.find((check) => check.id === "native.pdb_path");
    expect(pdb?.locations).toEqual([
      { kind: "artifact-path", path: "/work/app.exe" },
    ]);
    expect(pdb?.observation.samples).toContain("C:\\build\\app.pdb");
    expect(
      report.checks.find((check) => check.id === "native.pdb_path")?.severity,
    ).toBe("low");
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
        go_images: [
          { kind: "paths", path: "/work/app", paths: ["/home/dev/main.go"] },
        ],
        rust_images: [{ kind: "packages", packages: ["app"] }],
      }),
    );
    expect(statusOf(exposed, "go.build_paths")).toBe("exposed");
    const go = exposed.checks.find((check) => check.id === "go.build_paths");
    expect(go?.locations).toEqual([
      { kind: "artifact-path", path: "/work/app" },
    ]);
    expect(go?.observation.samples).toContain("/home/dev/main.go");
    expect(statusOf(exposed, "rust.dependency_metadata")).toBe("exposed");

    const omitted = reportFor(
      scan({
        coverage: "unknown",
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
    expect(statusOf(other, "go.build_paths")).toBe("not_applicable");
    expect(statusOf(other, "rust.dependency_metadata")).toBe("not_applicable");
  });

  it("reports credential rule locations and never stores matched bytes", () => {
    const planted = "release-exposure-planted-secret-7c2e9a";
    const report = reportFor(
      scan(),
      owners({
        credential_markers: {
          hits: [{ rule_id: "pem.private_key", path: "config.txt", line: 2 }],
          omitted_hits: 0,
        },
      }),
    );
    expect(statusOf(report, "text.credential_markers")).toBe("exposed");
    expect(
      report.checks.find((check) => check.id === "text.credential_markers")
        ?.locations,
    ).toEqual([{ kind: "artifact-path", path: "config.txt" }]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(planted);
    expect(serialized).toContain("pem.private_key config.txt:2");
    expect(exposureMeetsFailOn(report, "high")).toBe(true);
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
    expect(report.summary.by_status.not_assessed).toBe(3);
    expect(exposureMeetsFailOn(report, "low")).toBe(false);
    expect(report.summary.no_exposure_observed_in_assessed_checks).toBe(true);
  });

  it("does not treat an unscanned text member as an absent credential", () => {
    const report = reportFor(
      scan({ text_members: { scanned: 0, skipped: 0 } }),
    );
    expect(statusOf(report, "text.credential_markers")).toBe("not_applicable");
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

  it("labels a companion's identity as inferred from its name", () => {
    const report = reportFor(
      scan({ debug_companions: { paths: ["app.map"], skipped: 0 } }),
    );
    const check = report.checks.find(
      (item) => item.id === "native.debug_companions",
    );
    expect(check?.status).toBe("exposed");
    expect(check?.confidence).toBe("inferred");
  });

  it("names the real @electron/fuses option on every fuse remediation", () => {
    const fuses = reportFor().checks.filter((check) =>
      check.id.startsWith("electron."),
    );
    expect(fuses).toHaveLength(4);
    for (const check of fuses) {
      expect(check.remediation).toContain("FuseV1Options.");
      expect(check.remediation).toContain("@electron/fuses");
      expect(check.remediation).not.toContain("ElectronFuseV1");
    }
  });
});
