import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect } from "vitest";

import { RELEASE_EXPOSURE_TOOL_CONTRACTS } from "../../src/contracts/releaseExposureToolContracts.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const PLANTED_SOURCE = "release-exposure-planted-secret-7c2e9a";
const releaseExposureContract = RELEASE_EXPOSURE_TOOL_CONTRACTS.find(
  (contract) => contract.name === "audit_release_exposure",
);
if (releaseExposureContract === undefined)
  throw new Error("Missing release exposure contract");
const outputSchema = releaseExposureContract.outputSchema;

cliTest(
  "retains observed findings without treating lossy text as complete",
  async ({ cli }) => {
    const invalidMap = (embedded: boolean) =>
      Buffer.concat([
        Buffer.from('{"version":3,"sources":["src/'),
        Buffer.from([0xff]),
        Buffer.from(
          embedded
            ? '"],"sourcesContent":["export {};"],"mappings":""}'
            : '"],"mappings":""}',
        ),
      ]);
    const cases = [
      {
        name: "app.js",
        bytes: Buffer.from('const x = "ok";'),
        id: "text.credential_markers",
        status: "not_observed",
      },
      {
        name: "app.js",
        bytes: Buffer.concat([
          Buffer.from('const x = "'),
          Buffer.from([0xff]),
          Buffer.from('";'),
        ]),
        id: "text.credential_markers",
        status: "unknown",
      },
      {
        name: "app.js",
        bytes: Buffer.concat([
          Buffer.from("-----BEGIN PRIVATE KEY-----\n"),
          Buffer.from([0xff]),
        ]),
        id: "text.credential_markers",
        status: "exposed",
      },
      {
        name: "app.js.map",
        bytes: Buffer.from(
          '{"version":3,"sources":["src/app.js"],"mappings":""}',
        ),
        id: "javascript.source_map_sources",
        status: "not_observed",
      },
      {
        name: "app.js.map",
        bytes: invalidMap(false),
        id: "javascript.source_map_sources",
        status: "unknown",
      },
      {
        name: "app.js.map",
        bytes: invalidMap(true),
        id: "javascript.source_map_sources",
        status: "exposed",
      },
    ] as const;
    for (const item of cases) {
      const root = await createTestTempDirectory("rea-release-lossy-cli-");
      const file = join(root, item.name);
      await writeFile(file, item.bytes);
      const hash = createHash("sha256").update(item.bytes).digest("hex");
      const result = await cli.run({
        arguments: ["audit-release-exposure", root, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = outputSchema.parse(result.json);
      expect(
        evidence.normalized_result.checks.find(({ id }) => id === item.id)
          ?.status,
      ).toBe(item.status);
      expect(
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ).toBe(hash);
      expect(JSON.stringify(evidence)).not.toContain(
        "-----BEGIN PRIVATE KEY-----",
      );
    }
  },
);

cliTest("exits 3 when a shipped source map embeds sources", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-release-exposure-cli-");
  await writeFile(join(root, "app.js"), "export const value = 1;\n");
  await writeFile(
    join(root, "app.js.map"),
    JSON.stringify({
      version: 3,
      file: "app.js",
      sources: ["app.js"],
      names: [],
      mappings: "",
      sourcesContent: [`export const value = "${PLANTED_SOURCE}";\n`],
    }),
  );
  const clean = await cli.run({
    arguments: ["audit-release-exposure", root, "--json"],
  });
  expect(clean.exitCode, clean.stderr).toBe(0);
  const evidence = outputSchema.parse(clean.json);
  const report = evidence.normalized_result;
  expect(
    report.checks.find((check) => check.id === "javascript.source_map_sources"),
  ).toMatchObject({ status: "exposed", severity: "high" });
  expect(
    report.checks.find((check) => check.id === "electron.run_as_node")?.status,
  ).toBe("unknown");
  expect(
    report.checks.find((check) => check.id === "native.pdb_path")?.status,
  ).toBe("not_applicable");
  expect(
    report.checks.find((check) => check.id === "go.build_paths")?.status,
  ).toBe("not_applicable");
  expect(JSON.stringify(evidence)).not.toContain(PLANTED_SOURCE);
  const gated = await cli.run({
    arguments: ["audit-release-exposure", root, "--fail_on", "high", "--json"],
  });
  expect(gated.exitCode, gated.stderr).toBe(3);
});

cliTest(
  "gates a marker in a text file outside the extension list",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-release-exposure-key-");
    await writeFile(join(root, "hello.txt"), "hello\n");
    await writeFile(
      join(root, ".env.production"),
      "-----BEGIN PRIVATE KEY-----\n",
    );
    const result = await cli.run({
      arguments: [
        "audit-release-exposure",
        root,
        "--fail_on",
        "high",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(3);
    expect(
      outputSchema
        .parse(result.json)
        .normalized_result.checks.find(
          (check) => check.id === "text.credential_markers",
        ),
    ).toMatchObject({
      status: "exposed",
      locations: [
        { kind: "artifact-path", path: join(root, ".env.production") },
      ],
    });
  },
);

cliTest(
  "keeps a clean directory at exit 0 when the gate is high",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-release-exposure-clean-");
    await writeFile(join(root, "hello.txt"), "hello\n");
    const result = await cli.run({
      arguments: [
        "audit-release-exposure",
        root,
        "--fail_on",
        "high",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = outputSchema.parse(result.json).normalized_result;
    expect(report.summary.no_exposure_observed_in_assessed_checks).toBe(true);
    expect(report.summary.by_status.not_assessed).toBe(3);
  },
);

cliTest.for(["map", "script"])(
  "retains the distinct linker-map source across declaration owners, %s first",
  async (firstRole, { cli, skip }) => {
    const root = await createTestTempDirectory("rea-release-map-identity-cli-");
    const declared = "café.map";
    const companion = "cafe\u0301.map";
    await writeFile(join(root, declared), "linker map\n");
    await writeFile(join(root, companion), "linker map\n");
    if ((await readdir(root)).length !== 2) {
      skip();
      return;
    }
    await writeFile(
      join(root, firstRole === "map" ? "z.js" : "zz.js"),
      `//# ${"sourceMappingURL"}=${declared}\n`,
    );
    await writeFile(
      join(root, firstRole === "script" ? "z.html" : "zz.html"),
      `<script src="${declared}"></script>`,
    );
    const result = await cli.run({
      arguments: ["audit-release-exposure", root, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = outputSchema.parse(result.json).normalized_result;
    expect(
      report.checks.find(({ id }) => id === "native.debug_companions"),
    ).toMatchObject({
      status: "exposed",
      confidence: "inferred",
      observation: {
        counts: { companions: 1 },
        samples: [join(root, companion)],
      },
    });
  },
);

cliTest(
  "retracts a script target guessed after its early declaration",
  async ({ cli, skip }) => {
    const root = await createTestTempDirectory("rea-release-late-guess-cli-");
    const declared = "café.map";
    const other = "cafe\u0301.map";
    await writeFile(join(root, declared), "linker map\n");
    await writeFile(join(root, other), "linker map\n");
    if ((await readdir(root)).length !== 2) {
      skip();
      return;
    }
    await writeFile(
      join(root, "a.html"),
      `<script src="${declared}"></script>`,
    );
    await writeFile(join(root, "b.js"), `//# ${"sourceMappingURL"}=${other}\n`);
    await writeFile(
      join(root, "z.js"),
      `//# ${"sourceMappingURL"}=${declared}\n`,
    );
    const result = await cli.run({
      arguments: ["audit-release-exposure", root, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = outputSchema.parse(result.json).normalized_result;
    const check = report.checks.find(
      ({ id }) => id === "native.debug_companions",
    );
    expect(check?.status).not.toBe("exposed");
    expect(check?.observation).toMatchObject({
      counts: { companions: 0 },
      samples: [],
    });
  },
);

cliTest(
  "audits Node shebang maps using env option operand ownership",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-release-env-operands-cli-");
    const path = join(root, "runner");
    const map = Buffer.from(
      JSON.stringify({
        version: 3,
        sources: ["source.ts"],
        sourcesContent: ["export const value = 1;"],
        mappings: "",
      }),
    ).toString("base64");
    for (const [arguments_, status, exitCode] of [
      ["-iu NODE_OPTIONS node", "exposed", 3],
      ["-i -u NODE_OPTIONS node", "exposed", 3],
      ["MODE=production -i node", "not_observed", 0],
    ] as const) {
      const bytes = Buffer.from(
        `#!/usr/bin/env -S ${arguments_}\nrun();\n//# sourceMappingURL=data:application/json;base64,${map}\n`,
      );
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: [
          "audit-release-exposure",
          root,
          "--fail_on",
          "high",
          "--json",
        ],
      });
      expect(result.exitCode, result.stderr).toBe(exitCode);
      const report = outputSchema.parse(result.json).normalized_result;
      expect(
        report.checks.find(({ id }) => id === "javascript.source_map_sources")
          ?.status,
      ).toBe(status);
      expect((await readFile(path)).equals(bytes)).toBe(true);
    }
  },
);
