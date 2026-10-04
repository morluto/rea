import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

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
        secretPatterns: [],
      });
      expect(result.value.browserObservationPolicy).toEqual({
        status: "disabled",
      });
      expect(result.value.browserScenarioPolicy).toEqual({
        status: "disabled",
      });
      expect(result.value.electronObservationPolicy).toEqual({
        status: "disabled",
      });
      expect(result.value.electronAutomationPolicy).toEqual({
        status: "disabled",
      });
      expect(result.value.v8InspectorObservationPolicy).toEqual({
        status: "disabled",
      });
      expect(result.value.javascriptReplayPolicy).toEqual({
        status: "disabled",
      });
      expect(result.value.managedRuntimePolicy).toEqual({
        status: "disabled",
      });
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
        GHIDRA_INSTALL_DIR: "/opt/ghidra_12.1.4_PUBLIC",
        JAVA_HOME: "/usr/lib/jvm/jdk-21",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        ghidraInstallDir: "/opt/ghidra_12.1.4_PUBLIC",
        ghidraJavaHome: "/usr/lib/jvm/jdk-21",
      },
    });
    expect(parseConfig({ GHIDRA_INSTALL_DIR: "relative/ghidra" }).ok).toBe(
      false,
    );
    expect(parseConfig({ JAVA_HOME: "relative/jdk" }).ok).toBe(false);
  });

  it("parses an optional absolute BYO ilspycmd path", () => {
    expect(
      parseConfig({ REA_ILSPY_CMD_PATH: "/home/user/.dotnet/tools/ilspycmd" }),
    ).toMatchObject({
      ok: true,
      value: {
        ilspyCmdPath: "/home/user/.dotnet/tools/ilspycmd",
      },
    });
    expect(parseConfig({ REA_ILSPY_CMD_PATH: "relative/ilspycmd" }).ok).toBe(
      false,
    );
  });
});

describe("runtime permission configuration", () => {
  it("builds a loopback-only Electron observation ceiling", () => {
    const result = parseConfig({ REA_ELECTRON_OBSERVE_ENABLED: "true" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.permissionCeilings).toContainEqual({
      capability: "electron_observe",
      roots: [],
      executables: [],
      environment_names: [],
      network: "loopback",
      mount: false,
    });
  });

  it("builds a loopback-only V8 Inspector capability ceiling", () => {
    const result = parseConfig({
      REA_V8_INSPECTOR_OBSERVE_ENABLED: "true",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.permissionCeilings).toContainEqual({
      capability: "v8_inspector_observe",
      roots: [],
      executables: [],
      environment_names: [],
      network: "loopback",
      mount: false,
    });
  });
});

describe("active Electron permission configuration", () => {
  it("builds a separately granted, no-network Electron automation ceiling", () => {
    const result = parseConfig({
      REA_ELECTRON_AUTOMATE_ENABLED: "true",
      REA_ELECTRON_AUTOMATE_AUTO_GRANT: "false",
      REA_ELECTRON_AUTOMATE_EXECUTABLE_ROOTS_JSON: '["/opt/electron"]',
      REA_ELECTRON_AUTOMATE_APPLICATION_ROOTS_JSON: '["/tmp/apps"]',
    });
    if (!result.ok) throw result.error;
    expect(result.value.electronAutomationPolicy).toEqual({
      status: "enabled",
      executableRoots: ["/opt/electron"],
      applicationRoots: ["/tmp/apps"],
    });
    expect(result.value.permissionCeilings).toContainEqual({
      capability: "electron_automate",
      roots: ["/tmp/apps"],
      executables: ["/opt/electron"],
      environment_names: [],
      network: "external",
      mount: false,
    });
    expect(result.value.administratorPermissionGrants).not.toContainEqual(
      expect.objectContaining({ capability: "electron_automate" }),
    );

    const granted = parseConfig({
      REA_ELECTRON_AUTOMATE_ENABLED: "true",
      REA_ELECTRON_AUTOMATE_AUTO_GRANT: "true",
      REA_ELECTRON_AUTOMATE_EXECUTABLE_ROOTS_JSON: '["/opt/electron"]',
      REA_ELECTRON_AUTOMATE_APPLICATION_ROOTS_JSON: '["/tmp/apps"]',
    });
    if (!granted.ok) throw granted.error;
    expect(granted.value.administratorPermissionGrants).toContainEqual(
      expect.objectContaining({
        capability: "electron_automate",
        lifetime: "administrator",
      }),
    );
  });

  it("rejects relative active Electron roots", () => {
    expect(
      parseConfig({
        REA_ELECTRON_AUTOMATE_APPLICATION_ROOTS_JSON: '["relative/apps"]',
      }).ok,
    ).toBe(false);
    expect(
      parseConfig({
        REA_ELECTRON_AUTOMATE_EXECUTABLE_ROOTS_JSON: '["relative/bin"]',
      }).ok,
    ).toBe(false);
  });

  it("requires both root sets only for enabled Electron automation", () => {
    expect(
      parseConfig({
        REA_ELECTRON_AUTOMATE_ENABLED: "true",
        REA_ELECTRON_AUTOMATE_APPLICATION_ROOTS_JSON: '["/tmp/apps"]',
      }).ok,
    ).toBe(false);
    expect(
      parseConfig({
        REA_ELECTRON_AUTOMATE_ENABLED: "true",
        REA_ELECTRON_AUTOMATE_EXECUTABLE_ROOTS_JSON: '["/opt/electron"]',
      }).ok,
    ).toBe(false);
    expect(
      parseConfig({
        REA_ELECTRON_AUTOMATE_EXECUTABLE_ROOTS_JSON: '["/ignored/bin"]',
        REA_ELECTRON_AUTOMATE_APPLICATION_ROOTS_JSON: '["/ignored/app"]',
      }),
    ).toMatchObject({
      ok: true,
      value: { electronAutomationPolicy: { status: "disabled" } },
    });
  });
});

describe("runtime permission configuration", () => {
  it("can configure a process-capture ceiling without an implicit grant", () => {
    const result = parseConfig({
      REA_PROCESS_CAPTURE_ENABLED: "true",
      REA_PROCESS_CAPTURE_AUTO_GRANT: "false",
      REA_PROCESS_EXECUTABLE_ROOTS_JSON: '["/opt/tools"]',
      REA_PROCESS_WORKING_ROOTS_JSON: '["/tmp/work"]',
    });
    if (!result.ok) throw result.error;
    expect(result.value.permissionCeilings).toContainEqual(
      expect.objectContaining({ capability: "process_capture" }),
    );
    expect(result.value.administratorPermissionGrants).not.toContainEqual(
      expect.objectContaining({ capability: "process_capture" }),
    );
  });

  it("preserves the configured process-capture administrator grant by default", () => {
    const result = parseConfig({
      REA_PROCESS_CAPTURE_ENABLED: "true",
      REA_PROCESS_EXECUTABLE_ROOTS_JSON: '["/opt/tools"]',
      REA_PROCESS_WORKING_ROOTS_JSON: '["/tmp/work"]',
    });
    if (!result.ok) throw result.error;
    expect(result.value.administratorPermissionGrants).toContainEqual(
      expect.objectContaining({
        capability: "process_capture",
        lifetime: "administrator",
      }),
    );
  });

  it("builds a no-network JavaScript replay ceiling only when enabled", () => {
    const result = parseConfig({
      REA_JAVASCRIPT_REPLAY_ENABLED: "true",
      REA_JAVASCRIPT_REPLAY_ROOTS_JSON: '["/tmp/extracted-modules"]',
      REA_JAVASCRIPT_REPLAY_NODE_PATH: "/opt/node/bin/node",
    });
    if (!result.ok) throw result.error;
    expect(result.value.javascriptReplayPolicy).toMatchObject({
      status: "enabled",
      roots: ["/tmp/extracted-modules"],
      nodePath: "/opt/node/bin/node",
    });
    expect(result.value.permissionCeilings).toContainEqual({
      capability: "javascript_replay",
      roots: ["/tmp/extracted-modules"],
      executables: [
        "/opt/node/bin/node",
        "/usr/bin/bwrap",
        "/usr/bin/systemd-run",
        "/usr/bin/systemctl",
        "/usr/bin/bash",
      ],
      environment_names: [],
      network: "none",
      mount: true,
    });
    expect(result.value.administratorPermissionGrants).toContainEqual(
      expect.objectContaining({
        capability: "javascript_replay",
        lifetime: "administrator",
      }),
    );
  });

  it("requires a source root when JavaScript replay is enabled", () => {
    expect(
      parseConfig({ REA_JAVASCRIPT_REPLAY_ENABLED: "true" }),
    ).toMatchObject({ ok: false });
  });

  it("does not retain dormant JavaScript replay authority", () => {
    const result = parseConfig({
      REA_JAVASCRIPT_REPLAY_ENABLED: "false",
      REA_JAVASCRIPT_REPLAY_ROOTS_JSON: '["/tmp/extracted-modules"]',
      REA_JAVASCRIPT_REPLAY_NODE_PATH: "/opt/node/bin/node",
    });
    if (!result.ok) throw result.error;
    expect(result.value.javascriptReplayPolicy).toEqual({
      status: "disabled",
    });
  });

  it("rejects relative JavaScript replay roots and executables", () => {
    expect(
      parseConfig({ REA_JAVASCRIPT_REPLAY_ROOTS_JSON: '["relative/module"]' })
        .ok,
    ).toBe(false);
    expect(
      parseConfig({ REA_JAVASCRIPT_REPLAY_NODE_PATH: "relative/node" }).ok,
    ).toBe(false);
  });
});

describe("runtime target configuration", () => {
  it("rejects invalid target kinds with actionable environment diagnostics", () => {
    const result = parseConfig({ HOPPER_TARGET_KIND: "archive" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid target kind");
    expect(result.error.message).toContain("Invalid REA environment");
  });

  it("builds a no-network managed runtime ceiling only when enabled", () => {
    const result = parseConfig({
      REA_MANAGED_RUNTIME_ENABLED: "true",
      REA_MANAGED_RUNTIME_ROOTS_JSON: '["/tmp/managed-targets"]',
      REA_MANAGED_RUNTIME_EXECUTABLE_PATH: "/opt/dotnet/dotnet",
    });
    if (!result.ok) throw result.error;
    expect(result.value.managedRuntimePolicy).toEqual({
      status: "enabled",
      roots: ["/tmp/managed-targets"],
      executablePath: "/opt/dotnet/dotnet",
    });
    expect(result.value.permissionCeilings).toContainEqual({
      capability: "managed_runtime",
      roots: ["/tmp/managed-targets"],
      executables: ["/opt/dotnet/dotnet"],
      environment_names: [],
      network: "none",
      mount: false,
    });
    expect(result.value.administratorPermissionGrants).toContainEqual(
      expect.objectContaining({
        capability: "managed_runtime",
        lifetime: "administrator",
      }),
    );
  });

  it("rejects relative managed runtime roots and executables", () => {
    expect(
      parseConfig({ REA_MANAGED_RUNTIME_ROOTS_JSON: '["relative/assembly"]' })
        .ok,
    ).toBe(false);
    expect(
      parseConfig({ REA_MANAGED_RUNTIME_EXECUTABLE_PATH: "relative/dotnet" })
        .ok,
    ).toBe(false);
  });

  it("requires a non-empty root set only for enabled managed runtime correlation", () => {
    const enabled = parseConfig({ REA_MANAGED_RUNTIME_ENABLED: "true" });
    expect(enabled.ok).toBe(false);
    if (!enabled.ok)
      expect(enabled.error.message).toContain("at least one absolute root");

    expect(
      parseConfig({
        REA_MANAGED_RUNTIME_ROOTS_JSON: '["/ignored/while-disabled"]',
        REA_MANAGED_RUNTIME_EXECUTABLE_PATH: "/ignored/dotnet",
      }),
    ).toMatchObject({
      ok: true,
      value: { managedRuntimePolicy: { status: "disabled" } },
    });
  });

  it("parses database kind and loader arguments", () => {
    expect(
      parseConfig({
        HOPPER_LAUNCHER_PATH: "/custom/hopper",
        REA_ANALYSIS_PROVIDER: "hopper",
        HOPPER_TARGET_PATH: "/fixture/sample.hop",
        HOPPER_TARGET_KIND: "database",
        HOPPER_LOADER_ARGS_JSON: '["-l","FAT","--aarch64","-l","Mach-O"]',
      }),
    ).toMatchObject({
      ok: true,
      value: {
        hopperLauncherPath: "/custom/hopper",
        analysisProvider: "hopper",
        hopperTargetPath: "/fixture/sample.hop",
        hopperTargetKind: "database",
        hopperLoaderArgs: ["-l", "FAT", "--aarch64", "-l", "Mach-O"],
        logLevel: "info",
        artifactNativeMountEnabled: false,
        processExecutionPolicy: {
          status: "disabled",
        },
        referenceSourcePolicy: {
          secretPatterns: [],
        },
      },
    });
  });
});

describe("runtime collection configuration", () => {
  it.each(["not-json", "{}", '"just a string"', '["ok",1]'])(
    "rejects invalid loader args: %s",
    (encoded) => {
      const result = parseConfig({
        HOPPER_TARGET_PATH: "/tmp/a",
        HOPPER_LOADER_ARGS_JSON: encoded,
      });
      expect(result.ok).toBe(false);
      if (result.ok)
        throw new Error("expected malformed loader arguments to fail");
      expect(result.error.message).toContain(
        encoded === "not-json" ? "valid JSON" : "array of strings",
      );
    },
  );

  it("parses supported log levels and rejects unknown levels", () => {
    const configured = parseConfig({ REA_LOG_LEVEL: "debug" });
    expect(configured.ok && configured.value.logLevel).toBe("debug");
    expect(parseConfig({ REA_LOG_LEVEL: "verbose" }).ok).toBe(false);
  });

  it("parses reference source secret patterns", () => {
    const result = parseConfig({
      REA_REFERENCE_SECRET_PATTERNS_JSON: '["*.env", "*.pem", "secrets/"]',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.referenceSourcePolicy).toEqual({
        secretPatterns: ["*.env", "*.pem", "secrets/"],
      });
    }
  });

  it.each(["not-json", "{}", '["*.ok", 1]'])(
    "rejects invalid reference source secret patterns: %s",
    (encoded) => {
      expect(
        parseConfig({ REA_REFERENCE_SECRET_PATTERNS_JSON: encoded }).ok,
      ).toBe(false);
    },
  );
});
