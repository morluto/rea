import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

import { LeandecProvider } from "./LeandecProvider.js";
import { LEANDEC_OPERATIONS } from "./LeandecProviderCapabilities.js";

const server = async (): Promise<string> => {
  const directory = await createTestTempDirectory("leandec-provider-");
  const path = join(directory, "mcp_server.py");
  writeFileSync(path, 'SERVER_VERSION = "9.9.9"\n');
  return path;
};

const machO = {
  path: "/tmp/sample",
  sha256: "a".repeat(64),
  kind: "executable" as const,
  format: "mach-o" as const,
  architecture: "x86_64" as const,
  availableArchitectures: ["x86_64" as const],
};

describe("Leandec provider discovery", () => {
  it("reports not_configured without LEANDEC_MCP_SERVER", () => {
    const provider = new LeandecProvider({}, "darwin");
    expect(provider.inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "not_configured",
    });
    expect(provider.capabilities()).toHaveLength(LEANDEC_OPERATIONS.length);
    expect(
      provider.capabilities().every(({ available }) => available === false),
    ).toBe(true);
  });

  it("advertises every operation when the server exists", async () => {
    const provider = new LeandecProvider(
      { LEANDEC_MCP_SERVER: await server(), LEANDEC_PYTHON: process.execPath },
      "darwin",
    );
    expect(provider.inspectAvailability()).toMatchObject({
      status: "available",
    });
    expect(
      provider.capabilities().every(({ available }) => available === true),
    ).toBe(true);
  });

  it("does not advertise operations on Windows", async () => {
    const provider = new LeandecProvider(
      { LEANDEC_MCP_SERVER: await server(), LEANDEC_PYTHON: process.execPath },
      "win32",
    );
    expect(provider.inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "unsupported_host",
    });
    expect(
      provider.capabilities().every((capability) => !capability.available),
    ).toBe(true);
  });

  it("supports Mach-O and ELF executables only", async () => {
    const provider = new LeandecProvider(
      { LEANDEC_MCP_SERVER: await server(), LEANDEC_PYTHON: process.execPath },
      "darwin",
    );
    expect(provider.inspectTargetSupport(machO)).toMatchObject({
      status: "supported",
    });
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/sample.exe",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "pe",
        architecture: "x86_64",
        availableArchitectures: ["x86_64"],
        executableRole: "application",
        managed: false,
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
    });
    const profile = await provider.resolveAnalysisProfile(machO);
    expect(profile.ok && profile.value.profile?.provider.version).toBe("9.9.9");
  });
});
