import { chmod, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  packageRunnerSetupPlan,
  runPackageRunnerSetupBootstrap,
} from "../../../scripts/package-runner-bootstrap.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("package-runner setup bootstrap", () => {
  it("reruns bare setup through the current release when npm selected a package", () => {
    expect(
      packageRunnerSetupPlan({
        args: ["setup", "--client", "codex"],
        environment: {
          npm_lifecycle_event: "npx",
          npm_config_local_prefix: "/work/project",
        },
        packageRoot: "/work/project/node_modules/rea-agents",
        packageName: "rea-agents",
      }),
    ).toEqual({
      command: "npm",
      args: [
        "exec",
        "--yes",
        "--prefer-online",
        "--package=rea-agents@latest",
        "--",
        "rea",
        "setup",
        "--client",
        "codex",
      ],
    });
  });

  it("leaves explicit rollback invocations untouched and refreshes cached packages", () => {
    const base = {
      args: ["setup"],
      packageRoot: "/work/project/node_modules/rea-agents",
      packageName: "rea-agents",
    } as const;

    expect(
      packageRunnerSetupPlan({
        ...base,
        environment: {
          npm_lifecycle_event: "npx",
          npm_config_local_prefix: "/work/project",
          npm_config_package: "rea-agents@2.4.0",
        },
      }),
    ).toBeUndefined();
    expect(
      packageRunnerSetupPlan({
        ...base,
        environment: {
          npm_lifecycle_event: "npx",
          npm_config_local_prefix: "/work/project",
          npm_config_package: "rea-agents@^2.4.0",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        args: expect.arrayContaining(["--package=rea-agents@latest"]),
      }),
    );
    expect(
      packageRunnerSetupPlan({
        ...base,
        packageRoot: "/root/.npm/_npx/cache/node_modules/rea-agents",
        environment: {
          npm_lifecycle_event: "npx",
          npm_config_local_prefix: "/work/project",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        args: expect.arrayContaining([
          "--prefer-online",
          "--package=rea-agents@latest",
        ]),
      }),
    );
  });

  it("does not redirect recursively or affect commands other than setup", () => {
    const environment = {
      npm_lifecycle_event: "npx",
      npm_config_local_prefix: "/work/project",
      REA_PACKAGE_RUNNER_BOOTSTRAPPED: "1",
    };

    expect(
      packageRunnerSetupPlan({
        args: ["setup"],
        environment,
        packageRoot: "/work/project/node_modules/rea-agents",
        packageName: "rea-agents",
      }),
    ).toBeUndefined();
    expect(
      packageRunnerSetupPlan({
        args: ["doctor"],
        environment: {
          npm_lifecycle_event: "npx",
          npm_config_local_prefix: "/work/project",
        },
        packageRoot: "/work/project/node_modules/rea-agents",
        packageName: "rea-agents",
      }),
    ).toBeUndefined();
  });

  it("forwards setup arguments to npm with a recursion marker", async () => {
    const directory = await createTestTempDirectory("rea-bootstrap-");
    const npm = join(directory, "npm");
    const log = join(directory, "invocation.json");
    await writeFile(
      npm,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.REA_BOOTSTRAP_TEST_LOG, JSON.stringify({
  args: process.argv.slice(2),
  marker: process.env.REA_PACKAGE_RUNNER_BOOTSTRAPPED,
}));
`,
    );
    await chmod(npm, 0o755);

    await expect(
      runPackageRunnerSetupBootstrap({
        args: ["setup", "--dry-run"],
        environment: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
          REA_BOOTSTRAP_TEST_LOG: log,
          npm_lifecycle_event: "npx",
          npm_config_local_prefix: "/work/project",
        },
        packageRoot: "/work/project/node_modules/rea-agents",
        packageName: "rea-agents",
      }),
    ).resolves.toBe(0);
    await expect(readFile(log, "utf8").then(JSON.parse)).resolves.toEqual({
      args: [
        "exec",
        "--yes",
        "--prefer-online",
        "--package=rea-agents@latest",
        "--",
        "rea",
        "setup",
        "--dry-run",
      ],
      marker: "1",
    });
  });
});
