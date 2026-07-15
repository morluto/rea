import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";

describe("runtime configuration", () => {
  it("allows target-free startup and defaults to Hopper's documented launcher", () => {
    const empty = parseConfig({});
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value.hopperTargetPath).toBeUndefined();
      expect(empty.value.analysisProvider).toBe("auto");
    }
    const result = parseConfig({ HOPPER_TARGET_PATH: "/usr/bin/true" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hopperLauncherPath).toBe(
        process.platform === "linux"
          ? "/opt/hopper/bin/Hopper"
          : "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
      );
      expect(result.value.hopperTargetKind).toBe("executable");
      expect(result.value.hopperLoaderArgs).toEqual([]);
      expect(result.value.logLevel).toBe("info");
      expect(result.value.referenceSourcePolicy).toEqual({
        roots: [],
        secretPatterns: [],
        maxBytes: 16 * 1024 * 1024,
        maxEntries: 10_000,
        maxDepth: 32,
        maxPathBytes: 4_096,
      });
      expect(result.value.browserObservationEnabled).toBe(false);
      expect(result.value.browserCdpEndpoints).toEqual([]);
      expect(result.value.browserAllowedOrigins).toEqual([]);
      expect(result.value.electronObservationEnabled).toBe(false);
      expect(result.value.electronCdpEndpoints).toEqual([]);
      expect(result.value.electronFileRoots).toEqual([]);
    }
  });

  it("parses one shared provider selector and rejects unstable IDs", () => {
    expect(parseConfig({ REA_ANALYSIS_PROVIDER: "ghidra" })).toMatchObject({
      ok: true,
      value: { analysisProvider: "ghidra" },
    });
    expect(parseConfig({ REA_ANALYSIS_PROVIDER: "auto" })).toMatchObject({
      ok: true,
      value: { analysisProvider: "auto" },
    });
    for (const invalid of ["", "Auto", "ghidra_1", "ghidra "])
      expect(parseConfig({ REA_ANALYSIS_PROVIDER: invalid }).ok).toBe(false);
  });

  it("parses absolute BYO Ghidra and optional Java paths", () => {
    expect(
      parseConfig({
        GHIDRA_INSTALL_DIR: "/opt/ghidra_12.1.2_PUBLIC",
        JAVA_HOME: "/usr/lib/jvm/jdk-21",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        ghidraInstallDir: "/opt/ghidra_12.1.2_PUBLIC",
        ghidraJavaHome: "/usr/lib/jvm/jdk-21",
      },
    });
    expect(parseConfig({ GHIDRA_INSTALL_DIR: "relative/ghidra" }).ok).toBe(
      false,
    );
    expect(parseConfig({ JAVA_HOME: "relative/jdk" }).ok).toBe(false);
  });

  it("builds a separate Electron endpoint and file-root ceiling", () => {
    const result = parseConfig({
      REA_ELECTRON_OBSERVE_ENABLED: "true",
      REA_ELECTRON_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9223"]',
      REA_ELECTRON_FILE_ROOTS_JSON: '["/tmp/electron-app"]',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.permissionCeilings).toContainEqual({
      capability: "electron_observe",
      roots: ["/tmp/electron-app"],
      executables: [],
      environment_names: [],
      origins: ["http://127.0.0.1:9223"],
      network: "loopback",
      mount: false,
    });
  });

  it("rejects relative Electron file roots", () => {
    expect(
      parseConfig({ REA_ELECTRON_FILE_ROOTS_JSON: '["relative/app"]' }).ok,
    ).toBe(false);
  });

  it("parses database kind and loader arguments", () => {
    expect(
      parseConfig({
        HOPPER_TARGET_PATH: "/fixture/sample.hop",
        HOPPER_TARGET_KIND: "database",
        HOPPER_LOADER_ARGS_JSON: '["-l","FAT","--aarch64","-l","Mach-O"]',
      }),
    ).toMatchObject({
      ok: true,
      value: {
        hopperLauncherPath:
          process.platform === "linux"
            ? "/opt/hopper/bin/Hopper"
            : "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
        hopperTargetPath: "/fixture/sample.hop",
        hopperTargetKind: "database",
        hopperLoaderArgs: ["-l", "FAT", "--aarch64", "-l", "Mach-O"],
        logLevel: "info",
        artifactNativeMountEnabled: false,
        processExecutionPolicy: {
          enabled: false,
          executableRoots: [],
          workingRoots: [],
          allowedEnvironment: [],
          allowExternalNetwork: false,
        },
        evidenceFilePolicy: {
          roots: [],
          maxBytes: 64 * 1024 * 1024,
          maxDepth: 64,
          maxStringLength: 1024 * 1024,
          maxNodes: 1_000_000,
        },
        investigationInputRoots: [],
        analysisSnapshotFilePolicy: {
          roots: [],
          maxBytes: 64 * 1024 * 1024,
          maxDepth: 64,
          maxStringLength: 1024 * 1024,
          maxNodes: 1_000_000,
        },
        referenceSourcePolicy: {
          roots: [],
          secretPatterns: [],
          maxBytes: 16 * 1024 * 1024,
          maxEntries: 10_000,
          maxDepth: 32,
          maxPathBytes: 4_096,
        },
      },
    });
  });

  it.each(["not-json", "{}", '["ok",1]'])(
    "rejects invalid loader args: %s",
    (encoded) => {
      expect(
        parseConfig({
          HOPPER_TARGET_PATH: "/tmp/a",
          HOPPER_LOADER_ARGS_JSON: encoded,
        }).ok,
      ).toBe(false);
    },
  );

  it("reports the configured string-array size limit", () => {
    const result = parseConfig({
      REA_INVESTIGATION_INPUT_ROOTS_JSON: JSON.stringify(
        Array.from({ length: 129 }, (_, index) => `/input/${String(index)}`),
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toBe(
        "REA_INVESTIGATION_INPUT_ROOTS_JSON must encode at most 128 strings",
      );
  });

  it("parses supported log levels and rejects unknown levels", () => {
    const configured = parseConfig({ REA_LOG_LEVEL: "debug" });
    expect(configured.ok && configured.value.logLevel).toBe("debug");
    expect(parseConfig({ REA_LOG_LEVEL: "verbose" }).ok).toBe(false);
  });

  it("parses reference source policy roots and secret patterns", () => {
    const result = parseConfig({
      REA_REFERENCE_ROOTS_JSON: '["/approved", "/srv/reference"]',
      REA_REFERENCE_SECRET_PATTERNS_JSON: '["*.env", "*.pem", "secrets/"]',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.referenceSourcePolicy).toEqual({
        roots: ["/approved", "/srv/reference"],
        secretPatterns: ["*.env", "*.pem", "secrets/"],
        maxBytes: 16 * 1024 * 1024,
        maxEntries: 10_000,
        maxDepth: 32,
        maxPathBytes: 4_096,
      });
    }
  });

  it("parses investigation input roots independently from evidence roots", () => {
    const result = parseConfig({
      REA_EVIDENCE_ROOTS_JSON: '["/evidence"]',
      REA_INVESTIGATION_INPUT_ROOTS_JSON: '["/releases", "/builds"]',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.evidenceFilePolicy.roots).toEqual(["/evidence"]);
      expect(result.value.investigationInputRoots).toEqual([
        "/releases",
        "/builds",
      ]);
    }
  });

  it.each(["not-json", "{}", '["/ok", 1]'])(
    "rejects invalid investigation input roots: %s",
    (encoded) => {
      expect(
        parseConfig({ REA_INVESTIGATION_INPUT_ROOTS_JSON: encoded }).ok,
      ).toBe(false);
    },
  );

  it.each(["not-json", "{}", '["/ok", 1]'])(
    "rejects invalid reference source roots: %s",
    (encoded) => {
      expect(parseConfig({ REA_REFERENCE_ROOTS_JSON: encoded }).ok).toBe(false);
    },
  );

  it.each(["not-json", "{}", '["*.ok", 1]'])(
    "rejects invalid reference source secret patterns: %s",
    (encoded) => {
      expect(
        parseConfig({ REA_REFERENCE_SECRET_PATTERNS_JSON: encoded }).ok,
      ).toBe(false);
    },
  );

  it("builds an exact-origin browser observation ceiling only when enabled", () => {
    const result = parseConfig({
      REA_BROWSER_OBSERVE_ENABLED: "true",
      REA_BROWSER_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
      REA_BROWSER_ALLOWED_ORIGINS_JSON:
        '["https://app.example.test", "http://127.0.0.1:3000"]',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.permissionCeilings).toContainEqual({
      capability: "browser_observe",
      roots: [],
      executables: [],
      environment_names: [],
      origins: [
        "http://127.0.0.1:9222",
        "http://127.0.0.1:3000",
        "https://app.example.test",
      ],
      network: "external",
      mount: false,
    });
    expect(result.value.administratorPermissionGrants).toContainEqual(
      expect.objectContaining({
        capability: "browser_observe",
        lifetime: "administrator",
      }),
    );
  });

  it("classifies IPv6 browser origins as loopback network scope", () => {
    const result = parseConfig({
      REA_BROWSER_OBSERVE_ENABLED: "true",
      REA_BROWSER_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
      REA_BROWSER_ALLOWED_ORIGINS_JSON: '["http://[::1]:3000"]',
    });
    if (!result.ok) throw result.error;
    expect(result.value.permissionCeilings).toContainEqual(
      expect.objectContaining({
        capability: "browser_observe",
        network: "loopback",
      }),
    );
  });

  it.each([
    '["http://localhost:9222"]',
    '["http://192.168.1.5:9222"]',
    '["https://127.0.0.1:9222"]',
  ])("rejects unsafe browser CDP endpoint scopes: %s", (encoded) => {
    expect(parseConfig({ REA_BROWSER_CDP_ENDPOINTS_JSON: encoded }).ok).toBe(
      false,
    );
  });

  it.each([
    '["https://*.example.test"]',
    '["https://app.example.test/private"]',
    '["https://user:pass@app.example.test"]',
    '["file:///tmp/application.html"]',
  ])("rejects non-exact browser origin scopes: %s", (encoded) => {
    expect(parseConfig({ REA_BROWSER_ALLOWED_ORIGINS_JSON: encoded }).ok).toBe(
      false,
    );
  });
});
