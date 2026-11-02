import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { MAX_GHIDRA_INSTALLATION_PROPERTIES_BYTES } from "../../../src/ghidra/GhidraInstallationProperties.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["pipe", "capacity"] as const)(
  "doctor reports selected properties %s without launching Java",
  async (kind, { cli, skip }) => {
    if (kind === "pipe" && process.platform === "win32") {
      skip();
      return;
    }
    const root = await createTestTempDirectory("rea-doctor-properties-");
    const install = join(root, "ghidra");
    const path = join(install, "Ghidra/application.properties");
    await mkdir(join(install, "Ghidra"), { recursive: true });
    if (kind === "pipe") await promisify(execFile)("mkfifo", [path]);
    else {
      await writeFile(path, "application.version=12.1.4\n");
      await truncate(path, MAX_GHIDRA_INSTALLATION_PROPERTIES_BYTES + 1);
    }
    const result = await cli.run({
      arguments: ["doctor", "--provider", "ghidra", "--json"],
      environment: {
        GHIDRA_INSTALL_DIR: install,
        JAVA_HOME: join(root, "missing-jdk"),
        REA_LOG_LEVEL: "silent",
      },
      timeoutMs: 5000,
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.json).toMatchObject({
      code: kind === "pipe" ? "execution_failure" : "resource_constraint",
      details: {
        operation: "doctor",
        diagnostics: { path, stage: "installation_properties" },
      },
    });
    if (kind === "capacity") {
      expect(result.json).toMatchObject({
        retryable: false,
        details: {
          reported_limits: {
            maximum_bytes: MAX_GHIDRA_INSTALLATION_PROPERTIES_BYTES,
            observed_bytes: String(
              MAX_GHIDRA_INSTALLATION_PROPERTIES_BYTES + 1,
            ),
          },
        },
        remediation: {
          action: expect.stringContaining("installation-properties"),
        },
      });
      expect(JSON.stringify(result.json)).toContain("no runtime override");
      expect(JSON.stringify(result.json)).not.toContain(
        "Retry with a sufficient file-size allowance",
      );
    }
  },
);
