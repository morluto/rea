import { describe, expect, it } from "vitest";
import { runDoctor, type DoctorHost } from "../src/application/Doctor.js";
import { CATALOG_IDENTITY } from "../src/catalogIdentity.js";
import { PRODUCT_IDENTITY } from "../src/identity.js";

const host = (overrides: Partial<DoctorHost> = {}): DoctorHost => ({
  platform: "darwin",
  architecture: "x64",
  nodeVersion: "24.18.0",
  macosVersion: () => Promise.resolve("12.0"),
  linuxDistribution: () => Promise.resolve(undefined),
  validTarget: (path) => Promise.resolve(path.includes("Hopper")),
  executable: (path) => Promise.resolve(path.includes("Hopper")),
  supportedLinuxHopper: () => Promise.resolve(true),
  linuxDemoRuntimeReady: () => Promise.resolve(true),
  brewHopperPath: () => Promise.resolve(undefined),
  manualHopperPaths: () => Promise.resolve([]),
  installedSkillIdentity: () =>
    Promise.resolve({
      version: PRODUCT_IDENTITY.skillVersion,
      toolCount: CATALOG_IDENTITY.counts.mcp_tools,
      catalogDigest: CATALOG_IDENTITY.digests.combined_sha256,
    }),
  ...overrides,
});

describe("doctor", () => {
  it("returns exact recovery for every failed diagnostic", async () => {
    const result = await runDoctor(
      "/missing/app",
      host({
        nodeVersion: "20.0.0",
        macosVersion: () => Promise.resolve("11.7"),
        executable: () => Promise.resolve(false),
        validTarget: () => Promise.resolve(false),
      }),
    );
    expect(
      Object.fromEntries(
        result.checks.map(({ name, remediation }) => [name, remediation]),
      ),
    ).toEqual({
      node: "Install Node.js 22.19+ or 24.11+.",
      host: "REA supports macOS 12+, Ubuntu 24.04+, Fedora 41+, 64-bit Arch Linux, and the experimental Windows x64 Ghidra P0 boundary.",
      hopper: "Run rea setup to install Hopper, or set HOPPER_LAUNCHER_PATH.",
      target: "Supply a readable local app or program path.",
    });
  });

  it.each(["11.7", undefined])(
    "rejects unsupported macOS version %s",
    async (version) => {
      const result = await runDoctor(
        undefined,
        host({ macosVersion: () => Promise.resolve(version) }),
      );
      expect(result.checks.find(({ name }) => name === "host")?.ok).toBe(false);
    },
  );

  it("admits only the experimental Windows x64 host boundary", async () => {
    const windows = await runDoctor(
      undefined,
      host({
        platform: "win32",
        architecture: "x64",
        macosVersion: () => Promise.resolve(undefined),
        executable: () => Promise.resolve(false),
      }),
    );
    const arm = await runDoctor(
      undefined,
      host({
        platform: "win32",
        architecture: "arm64",
        macosVersion: () => Promise.resolve(undefined),
        executable: () => Promise.resolve(false),
      }),
    );

    expect(windows.checks.find(({ name }) => name === "host")).toMatchObject({
      ok: true,
      detail: "win32 x64",
    });
    expect(arm.checks.find(({ name }) => name === "host")).toMatchObject({
      ok: false,
      detail: "win32 arm64",
    });
  });
  it("detects a manual configured Hopper before Homebrew", async () => {
    const result = await runDoctor(
      undefined,
      host({
        configuredHopperPath: "/manual/Hopper",
        executable: (path) => Promise.resolve(path === "/manual/Hopper"),
      }),
    );
    expect(result.hopperPath).toBe("/manual/Hopper");
    expect(result.healthy).toBe(true);
  });

  it("reports optional BYO ilspycmd diagnostics only when configured", async () => {
    const result = await runDoctor(
      undefined,
      host({
        configuredIlspyCmdPath: "/tools/ilspycmd",
        ilspyCmdVersion: (path) =>
          Promise.resolve(
            path === "/tools/ilspycmd" ? "ilspycmd: 9.1.0.7988" : undefined,
          ),
      }),
    );
    expect(result.healthy).toBe(true);
    expect(result.checks).toContainEqual({
      name: "ilspycmd",
      ok: true,
      classification: "healthy",
      detail: "/tools/ilspycmd (ilspycmd: 9.1.0.7988)",
    });
  });

  it("reports configured ilspycmd drift without installing it", async () => {
    const result = await runDoctor(
      undefined,
      host({
        configuredIlspyCmdPath: "/missing/ilspycmd",
        ilspyCmdVersion: () => Promise.resolve(undefined),
      }),
    );
    expect(result.healthy).toBe(false);
    expect(result.checks).toContainEqual({
      name: "ilspycmd",
      ok: false,
      classification: "config_drift",
      detail: "/missing/ilspycmd",
      remediation:
        "Unset REA_ILSPY_CMD_PATH or point it at a runnable ilspycmd executable.",
    });
  });

  it("does not fall back when the configured Hopper launcher is invalid", async () => {
    const configuredPath = "/invalid/custom/hopper";
    const result = await runDoctor(
      undefined,
      host({ configuredHopperPath: configuredPath }),
    );

    expect(result.hopperPath).toBeUndefined();
    expect(result.healthy).toBe(false);
    expect(result.checks.find(({ name }) => name === "hopper")).toEqual({
      name: "hopper",
      ok: false,
      classification: "config_drift",
      detail: configuredPath,
      remediation:
        "Unset or update HOPPER_LAUNCHER_PATH to an executable Hopper launcher.",
    });
  });

  it("distinguishes stale skills, path shadowing, and unobservable live state", async () => {
    const result = await runDoctor(
      undefined,
      host({
        installationPaths: () =>
          Promise.resolve(["/usr/local/bin/rea", "/home/user/bin/rea"]),
        installedSkillIdentity: () =>
          Promise.resolve({
            version: "10",
            toolCount: null,
            catalogDigest: null,
          }),
      }),
    );

    expect(result.identity).toMatchObject({
      live_server: { state: "unknown" },
      installations: { state: "multiple" },
      skill: {
        installed_version: "10",
        state: "stale",
        remediation: "Run rea setup to update the installed REA skill.",
      },
    });
  });
  it("reports a missing installed skill as unhealthy", async () => {
    const result = await runDoctor(
      undefined,
      host({ installedSkillIdentity: () => Promise.resolve(undefined) }),
    );

    expect(result.healthy).toBe(false);
    expect(result.identity?.skill).toMatchObject({
      state: "missing",
      remediation: "Run rea setup to update the installed REA skill.",
    });
    expect(result.checks).toContainEqual({
      name: "skill:identity",
      ok: false,
      classification: "config_drift",
      detail: "Installed REA skill identity is missing.",
      remediation: "Run rea setup to update the installed REA skill.",
    });
  });
  it("reports stale client registration paths without claiming live state", async () => {
    const result = await runDoctor(
      undefined,
      host({
        clientRegistrations: () =>
          Promise.resolve([
            {
              client: "codex",
              config_path: "/home/user/.codex/config.toml",
              command: ["/old/rea", "mcp"],
              state: "stale",
              remediation:
                "Run rea setup to refresh this registration, then restart the client.",
            },
          ]),
      }),
    );

    expect(result.healthy).toBe(false);
    expect(result.identity).toMatchObject({
      live_server: { state: "unknown" },
      registrations: [{ client: "codex", state: "stale" }],
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "registration:codex",
        classification: "config_drift",
      }),
    );
  });
  it("accepts an officially supported Linux distribution", async () => {
    const path = "/home/user/.local/share/rea/hopper/bin/Hopper";
    const result = await runDoctor(
      undefined,
      host({
        platform: "linux",
        macosVersion: () => Promise.resolve(undefined),
        linuxDistribution: () =>
          Promise.resolve({
            id: "ubuntu",
            versionId: "24.04",
            packageFamily: "deb",
            supported: true,
          }),
        configuredHopperPath: path,
        executable: (candidate) => Promise.resolve(candidate === path),
      }),
    );
    expect(result.healthy).toBe(true);
    expect(result.hopperPath).toBe(path);
  });
  it("reports missing Linux demo-session dependencies", async () => {
    const result = await runDoctor(
      undefined,
      host({
        platform: "linux",
        macosVersion: () => Promise.resolve(undefined),
        linuxDistribution: () =>
          Promise.resolve({
            id: "ubuntu",
            versionId: "24.04",
            packageFamily: "deb",
            supported: true,
          }),
        linuxDemoRuntimeReady: () => Promise.resolve(false),
      }),
    );
    expect(result.healthy).toBe(false);
    expect(
      result.checks.find(({ name }) => name === "hopper-demo-runtime"),
    ).toMatchObject({
      ok: false,
      classification: "missing_dependency",
      remediation: expect.stringContaining("xauth"),
    });
  });
  it("explains how to recover from an unsupported configured launcher", async () => {
    const path = "/custom/Hopper";
    const result = await runDoctor(
      undefined,
      host({
        platform: "linux",
        configuredHopperPath: path,
        linuxDistribution: () =>
          Promise.resolve({
            id: "ubuntu",
            versionId: "24.04",
            packageFamily: "deb",
            supported: true,
          }),
        executable: (candidate) => Promise.resolve(candidate === path),
        supportedLinuxHopper: () => Promise.resolve(false),
      }),
    );
    expect(
      result.checks.find(({ name }) => name === "hopper-version")?.remediation,
    ).toContain("Unset or update HOPPER_LAUNCHER_PATH");
  });
  it("detects a Homebrew cask installed outside /Applications", async () => {
    const path =
      "/opt/homebrew/Caskroom/hopper/Hopper Disassembler.app/Contents/MacOS/hopper";
    const result = await runDoctor(
      undefined,
      host({
        executable: (candidate) => Promise.resolve(candidate === path),
        brewHopperPath: () => Promise.resolve(path),
      }),
    );
    expect(result.hopperPath).toBe(path);
  });

  it("detects a manually installed Hopper application", async () => {
    const path = "/Applications/Hopper v6.app/Contents/MacOS/hopper";
    const result = await runDoctor(
      undefined,
      host({
        executable: (candidate) => Promise.resolve(candidate === path),
        manualHopperPaths: () => Promise.resolve([path]),
      }),
    );
    expect(result.hopperPath).toBe(path);
  });

  it("uses shared app target validation when a target is supplied", async () => {
    const result = await runDoctor(
      "/Applications/Notes.app",
      host({
        validTarget: (path) =>
          Promise.resolve(path === "/Applications/Notes.app"),
      }),
    );
    expect(result.checks.find(({ name }) => name === "target")?.ok).toBe(true);
  });

  it("rejects a readable Hopper launcher without execute permission", async () => {
    const path = "/manual/Hopper";
    const result = await runDoctor(
      undefined,
      host({
        configuredHopperPath: path,
        validTarget: () => Promise.resolve(true),
        executable: () => Promise.resolve(false),
      }),
    );
    expect(result.hopperPath).toBeUndefined();
    expect(result.checks.find(({ name }) => name === "hopper")?.ok).toBe(false);
  });

  it("reports a broken shadowed Node candidate without hiding the healthy launcher", async () => {
    const result = await runDoctor(
      undefined,
      host({
        runtimeExecutables: () =>
          Promise.resolve({
            launcher_node: "/healthy/node",
            candidates: [
              {
                tool: "node",
                lexical_path: "/healthy/node",
                canonical_path: "/healthy/node",
                path_index: null,
                selection: "rea-launcher",
                version: "v24.18.0",
                healthy: true,
                failure: null,
              },
              {
                tool: "node",
                lexical_path: "/opt/homebrew/bin/node",
                canonical_path: "/opt/homebrew/Cellar/node/25.2.1/bin/node",
                path_index: 2,
                selection: "path-shadowed",
                version: null,
                healthy: false,
                failure: {
                  code: "runtime_dynamic_library_missing",
                  exit_code: 134,
                  signal: null,
                  dependency:
                    "/opt/homebrew/opt/simdjson/lib/libsimdjson.29.dylib",
                  stderr: "dyld: Library not loaded",
                },
              },
            ],
          }),
      }),
    );

    expect(result.healthy).toBe(false);
    expect(result.identity?.runtime_executables).toMatchObject({
      launcher_node: "/healthy/node",
      candidates: [
        { healthy: true, selection: "rea-launcher" },
        {
          healthy: false,
          failure: { code: "runtime_dynamic_library_missing" },
        },
      ],
    });
    expect(
      result.checks.find(({ name }) => name === "node-toolchains"),
    ).toMatchObject({
      ok: false,
      classification: "missing_dependency",
      remediation: expect.stringContaining("Do not create"),
    });
  });
});
