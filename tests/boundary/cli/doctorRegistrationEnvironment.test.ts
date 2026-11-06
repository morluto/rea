import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { elf, thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

/** An installation doctor admits; nothing here starts an analysis JVM. */
const writeAdmittedGhidra = async (root: string) => {
  const jdk = join(root, "jdk");
  const install = join(root, "ghidra");
  const native = join(
    install,
    "Ghidra/Features/Decompiler/os",
    `${process.platform === "darwin" ? "mac" : "linux"}_${process.arch === "arm64" ? "arm_64" : "x86_64"}`,
    "decompile",
  );
  for (const path of [
    join(jdk, "bin"),
    join(install, "support"),
    join(native, ".."),
  ])
    await mkdir(path, { recursive: true });
  await writeFile(
    join(install, "Ghidra/application.properties"),
    "application.version=12.1.4\napplication.java.min=21\n",
  );
  await writeFile(
    join(install, "support/analyzeHeadless"),
    "#!/bin/sh\nexit 99\n",
    { mode: 0o700 },
  );
  await writeFile(
    native,
    process.platform === "darwin"
      ? thinMach(0xfeedfacf, process.arch === "arm64" ? 0x0100000c : 0x01000007)
      : elf(2, 1, process.arch === "arm64" ? 183 : 62),
  );
  await chmod(native, 0o700);
  const properties = [
    "java.version = 21.0.11",
    `java.home = ${jdk}`,
    "sun.arch.data.model = 64",
    `os.arch = ${process.arch === "arm64" ? "aarch64" : "amd64"}`,
    `os.name = ${process.platform === "darwin" ? "Mac OS X" : "Linux"}`,
    "",
  ].join("\n");
  await writeFile(
    join(jdk, "bin/java"),
    `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(properties)});\n`,
    { mode: 0o700 },
  );
  await writeFile(join(jdk, "bin/javac"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  return { install, jdk };
};

const reportSchema = z.object({
  healthy: z.boolean(),
  scope_checks: z.array(z.object({ name: z.string() }).loose()),
  informational_checks: z.array(z.object({ name: z.string() }).loose()),
  identity: z.object({
    registrations: z.array(z.object({ client: z.string() }).loose()),
  }),
});

const run = async (
  cli: TestCli,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
) => {
  const result = await cli.run({
    arguments: [...arguments_, "--json"],
    environment,
    timeoutMs: 30_000,
  });
  return { result, report: reportSchema.safeParse(result.json) };
};

const doctor = async (
  cli: TestCli,
  scope: readonly string[],
  environment: NodeJS.ProcessEnv,
) => {
  const { result, report } = await run(cli, ["doctor", ...scope], environment);
  if (!report.success) throw new Error(result.stdout + result.stderr);
  return { exitCode: result.exitCode, report: report.data };
};

const names = (checks: readonly { readonly name: string }[]) =>
  checks.map(({ name }) => name);

const CHECK = "registration_environment:claude_code";

cliTest.skipIf(!["darwin", "linux"].includes(process.platform))(
  "doctor does not let a configured terminal stand in for an unconfigured registration",
  { timeout: 120_000 },
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-doctor-registration-env-");
    const home = join(root, "home");
    await mkdir(home);
    const { install, jdk } = await writeAdmittedGhidra(root);
    const clientEnvironment = {
      HOME: home,
      USERPROFILE: home,
      // The host's own Ghidra or Java must not satisfy this fixture.
      PATH: "/usr/bin:/bin",
      HOPPER_LAUNCHER_PATH: join(root, "missing-hopper"),
      REA_LOG_LEVEL: "silent",
    };
    const terminal = {
      ...clientEnvironment,
      GHIDRA_INSTALL_DIR: install,
      JAVA_HOME: jdk,
    };
    const configPath = join(home, ".claude.json");
    const saved = async () =>
      z
        .object({
          mcpServers: z.object({
            rea: z.object({ env: z.record(z.string(), z.string()) }),
          }),
        })
        .parse(JSON.parse(await readFile(configPath, "utf8"))).mcpServers.rea
        .env;

    // Setup ran where the provider settings were not visible.
    const unconfigured = await run(
      cli,
      ["setup", "--client", "claude_code", "--skill=false", "--yes"],
      clientEnvironment,
    );
    expect(unconfigured.result.exitCode, unconfigured.result.stdout).toBe(0);
    expect(await saved()).not.toHaveProperty("GHIDRA_INSTALL_DIR");

    // The registration's own environment is what a client without these
    // settings gives its server; it does not reach the terminal's result.
    const served = await doctor(cli, ["--provider", "ghidra"], {
      ...(await saved()),
      HOME: home,
      USERPROFILE: home,
      PATH: clientEnvironment.PATH,
    });
    expect(served.exitCode).toBe(1);
    expect(served.report.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "ghidra",
        ok: false,
        classification: "missing_analysis_engine",
      }),
    );
    expect(names(served.report.scope_checks)).not.toContain(CHECK);

    for (const scope of [
      ["--provider", "ghidra"],
      ["--client", "claude_code"],
      ["--provider", "ghidra", "--client", "claude_code"],
    ]) {
      const scoped = await doctor(cli, scope, terminal);
      expect(scoped.report.scope_checks, scope.join(" ")).toContainEqual(
        expect.objectContaining({
          name: CHECK,
          ok: true,
          classification: "unknown",
          detail: expect.stringContaining(
            "does not record GHIDRA_INSTALL_DIR, JAVA_HOME",
          ),
          details: {
            effective_environment: "unknown",
            providers: ["ghidra"],
          },
          remediation: expect.stringContaining(
            "rea setup --client claude_code --skill=false --dry-run",
          ),
        }),
      );
      // An unobserved environment is neither a failure nor a healthy match.
      expect(scoped.report.healthy, scope.join(" ")).toBe(true);
      expect(scoped.exitCode, scope.join(" ")).toBe(0);
      expect(scoped.report.identity.registrations).toEqual([
        expect.objectContaining({
          client: "claude_code",
          state: "aligned",
          provider_settings: {
            unrecorded: ["GHIDRA_INSTALL_DIR", "JAVA_HOME"],
            differing: [],
            unresolved: [],
          },
        }),
      ]);
    }

    const unrelated = await doctor(cli, ["--skill"], terminal);
    expect(names(unrelated.report.scope_checks)).not.toContain(CHECK);
    expect(names(unrelated.report.informational_checks)).toContain(CHECK);

    // Doctor reads; the configuration is unchanged until setup is approved.
    const before = await readFile(configPath, "utf8");
    await doctor(cli, [], terminal);
    expect(await readFile(configPath, "utf8")).toBe(before);

    // The named remediation records exactly these settings and then clears it.
    const planned = await run(
      cli,
      ["setup", "--client", "claude_code", "--skill=false", "--dry-run"],
      terminal,
    );
    expect(planned.result.stdout).toContain(`GHIDRA_INSTALL_DIR=${install}`);
    expect(planned.result.stdout).toContain(`JAVA_HOME=${jdk}`);
    expect(await readFile(configPath, "utf8")).toBe(before);
    const applied = await run(
      cli,
      ["setup", "--client", "claude_code", "--skill=false", "--yes"],
      terminal,
    );
    expect(applied.result.exitCode, applied.result.stdout).toBe(0);
    expect(await saved()).toMatchObject({
      GHIDRA_INSTALL_DIR: install,
      JAVA_HOME: jdk,
    });
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(before);

    const recorded = await doctor(cli, ["--provider", "ghidra"], terminal);
    expect(recorded.exitCode).toBe(0);
    expect(names(recorded.report.scope_checks)).not.toContain(CHECK);
    expect(recorded.report.identity.registrations[0]).not.toHaveProperty(
      "provider_settings",
    );

    // Another terminal selecting a different JDK spelling is reported as that.
    const alias = join(root, "jdk-alias");
    await symlink(jdk, alias);
    const otherTerminal = { ...terminal, JAVA_HOME: alias };
    const other = await doctor(cli, ["--provider", "ghidra"], otherTerminal);
    expect(other.report.identity.registrations[0]).toMatchObject({
      provider_settings: {
        unrecorded: [],
        differing: ["JAVA_HOME"],
        unresolved: [],
      },
    });

    // Setup's own spelling of a caller selection compares as recorded.
    await run(
      cli,
      ["setup", "--client", "claude_code", "--skill=false", "--yes"],
      otherTerminal,
    );
    expect(await saved()).toMatchObject({ JAVA_HOME: alias });
    const aliased = await doctor(cli, ["--provider", "ghidra"], otherTerminal);
    expect(names(aliased.report.scope_checks)).not.toContain(CHECK);
  },
);

cliTest.skipIf(!["darwin", "linux"].includes(process.platform))(
  "doctor adds nothing when the terminal's provider is not available",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-doctor-registration-off-");
    const home = join(root, "home");
    await mkdir(home);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      PATH: "/usr/bin:/bin",
      HOPPER_LAUNCHER_PATH: join(root, "missing-hopper"),
      REA_LOG_LEVEL: "silent",
    };
    await run(
      cli,
      ["setup", "--client", "claude_code", "--skill=false", "--yes"],
      environment,
    );
    // A provider setting that fails its own check has no green result to
    // misread; that failure is the report.
    const { report } = await doctor(cli, ["--provider", "ghidra"], {
      ...environment,
      GHIDRA_INSTALL_DIR: join(root, "missing-ghidra"),
    });
    expect(report.healthy).toBe(false);
    expect(names(report.scope_checks)).not.toContain(CHECK);
    expect(names(report.informational_checks)).not.toContain(CHECK);
    expect(report.identity.registrations[0]).not.toHaveProperty(
      "provider_settings",
    );
  },
);
