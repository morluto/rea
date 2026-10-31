import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseConfig } from "../../../../src/config/parseConfig.js";
import { elf } from "../../../../src/domain/binaryTarget.fixture.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { ok as javaProbeOk } from "../../../../src/domain/result.js";
import { GhidraClient } from "../../../../src/ghidra/GhidraClient.js";
import type { GhidraInstallationHost } from "../../../../src/ghidra/GhidraInstallation.js";
import type { GhidraJavaObservation } from "../../../../src/ghidra/GhidraJavaProbe.js";
import { GhidraProvider } from "../../../../src/ghidra/GhidraProvider.js";
import { loopbackTransportLimitations } from "../../../../src/ghidra/GhidraProviderCapabilities.js";
import { silentLogger } from "../../../../src/logger.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { waitForExit } from "../../../support/process/processFixture.js";
import { GhidraFixtureLauncher } from "./ghidraClient.fixture.js";

const installationHost: GhidraInstallationHost = {
  platform: "linux",
  architecture: "x64",
  readText: () => "application.version=12.1.4\napplication.java.min=21\n",
  executable: () => true,
  probeJava: () =>
    javaProbeOk<GhidraJavaObservation>({
      osArch: "amd64",
      osName: "Linux",
      version: "21.0.11",
      major: 21,
      home: "/fixture/jdk-21",
      bits: 64,
      runtime: "jdk",
    }),
};

// Only installation discovery and the Java bridge are simulated. The provider
// client, private runtime, endpoint record and loopback socket are production.
describe.skipIf(process.platform === "win32")(
  "Ghidra bridge transport selection on a POSIX host",
  () => {
    it("serves the read-only session over authenticated loopback TCP when selected", async () => {
      const directory = await createTestTempDirectory("rea-ghidra-loopback-");
      const path = join(directory, "target.elf");
      const source = elf(2, 1, 62);
      await writeFile(path, source);
      const target: BinaryTarget = {
        path,
        sha256: createHash("sha256").update(source).digest("hex"),
        kind: "executable",
        format: "elf",
        architecture: "x86_64",
        availableArchitectures: ["x86_64"],
      };
      const config = parseConfig({
        GHIDRA_INSTALL_DIR: "/fixture/ghidra_12.1.4_PUBLIC",
        REA_GHIDRA_BRIDGE_TRANSPORT: "authenticated-loopback-tcp",
      });
      if (!config.ok) throw config.error;
      const launcher = new GhidraFixtureLauncher();
      const provider = new GhidraProvider(
        config.value,
        silentLogger,
        {},
        installationHost,
        (options) =>
          new GhidraClient({
            ...options,
            launcher,
            platform: process.platform,
            startupTimeoutMs: 5_000,
          }),
      );
      const resolved = await provider.resolveAnalysisProfile(target);
      if (!resolved.ok || resolved.value.profile === null)
        throw new Error("Expected a bound Ghidra profile");
      const client = provider.createClient(target, resolved.value.profile);
      try {
        const listed = await client.execute("list_procedures", {});
        if (!listed.ok)
          throw new Error(
            JSON.stringify(projectAnalysisError(listed.error), null, 1),
          );
        // The fixture reports read_only over loopback and omits the mutating
        // methods; the production handshake only completes when both match.
        expect(launcher.requests).toContain("list_procedures");
        expect(launcher.endpointPaths).toEqual([
          expect.stringMatching(/bridge-endpoint\.json$/u),
        ]);
        expect(listed.value.limitations).toEqual(
          expect.arrayContaining([...loopbackTransportLimitations]),
        );
      } finally {
        expect((await client.close()).ok).toBe(true);
        for (const child of launcher.processes) {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGTERM");
          expect(await waitForExit(child, 2_000)).toBe(true);
        }
      }
    });
  },
);
