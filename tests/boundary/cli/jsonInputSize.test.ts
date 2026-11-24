import { constants } from "node:buffer";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "traces valid Evidence beyond the whole-document string limit",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-json-streamed-evidence-");
    const source = join(root, "application");
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "streamed-evidence",
        type: "module",
        main: "entry.mjs",
      }),
    );
    await writeFile(
      join(source, "entry.mjs"),
      'export const observed = "source-owned";',
    );
    const application = await cli.run({
      arguments: [
        "analyze-javascript-application",
        source,
        "--artifact-format",
        "directory",
        "--json",
      ],
    });
    expect(application.exitCode).toBe(0);
    const request = JSON.stringify({
      application: application.json,
      seed: { kind: "module", value: "entry.mjs", match: "contains" },
      direction: "incoming",
    });
    const input = join(root, "trace.json");
    await writeFile(input, request);
    const ordinary = await cli.run({
      arguments: ["trace-application-feature", input, "--json"],
    });
    expect(ordinary.exitCode).toBe(0);
    const file = await open(input, "a");
    try {
      const whitespace = Buffer.alloc(1024 * 1024, 0x20);
      let remaining =
        constants.MAX_STRING_LENGTH + 1 - Buffer.byteLength(request);
      while (remaining > 0) {
        const length = Math.min(remaining, whitespace.length);
        await file.writeFile(whitespace.subarray(0, length));
        remaining -= length;
      }
    } finally {
      await file.close();
    }
    const streamed = await cli.run({
      arguments: ["trace-application-feature", input, "--json"],
    });
    expect(streamed.exitCode).toBe(0);
    expect(streamed.json).toEqual(ordinary.json);
    expect(streamed.stderr).toBe("");
  },
);

cliTest(
  "returns a typed container assembly constraint and allows a following read",
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-json-container-headroom-");
    const input = join(root, "containers.json");
    const following = join(root, "following.json");
    const file = await open(input, "wx");
    try {
      await file.writeFile("[");
      const chunk = Buffer.from("[],".repeat(65_536));
      for (let index = 0; index < 128; index++) await file.writeFile(chunk);
      await file.writeFile("null]");
    } finally {
      await file.close();
    }
    await writeFile(following, '{"after":true}');
    const evidence = await processes.run(process.execPath, [
      "--max-old-space-size=768",
      "--input-type=module",
      "-e",
      `import { readJsonFile } from "./dist/application/JsonFiles.js";
       import { projectAnalysisError } from "./dist/domain/analysisErrorProjection.js";
       import { ArtifactResourceScope } from "./dist/resources/ArtifactResourceScope.js";
       const resources = new ArtifactResourceScope();
       try {
         const large = await readJsonFile(process.argv[1], undefined, resources);
         const pendingAfterRefusal = resources.hasPending;
         const following = await readJsonFile(process.argv[2], undefined, resources);
         console.log(JSON.stringify({
           large: large.ok ? large : projectAnalysisError(large.error),
           pendingAfterRefusal,
           following,
         }));
       } finally {
         await resources.close();
       }`,
      input,
      following,
    ]);
    expect(evidence.exitCode, evidence.stderr).toBe(0);
    expect(evidence.stderr).toBe("");
    expect(JSON.parse(evidence.stdout)).toMatchObject({
      large: {
        code: "resource_constraint",
        details: {
          resource: "memory",
          reported_limits: {
            input_path: input,
            projected_value_bytes: expect.any(Number),
            assembly_headroom_bytes: expect.any(Number),
          },
        },
      },
      pendingAfterRefusal: false,
      following: { ok: true, value: { after: true } },
    });
  },
);

cliTest(
  "returns a typed string assembly constraint under a bounded heap",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-json-string-headroom-");
    const input = join(root, "long-string.json");
    const contentBytes = constants.MAX_STRING_LENGTH + 1;
    const file = await open(input, "wx");
    try {
      await file.writeFile('"');
      const chunk = Buffer.alloc(1024 * 1024, 0x78);
      let remaining = contentBytes;
      while (remaining > 0) {
        const length = Math.min(remaining, chunk.length);
        await file.writeFile(chunk.subarray(0, length));
        remaining -= length;
      }
      await file.writeFile('"');
    } finally {
      await file.close();
    }
    const result = await cli.run({
      arguments: ["trace-application-feature", input, "--json"],
      environment: { NODE_OPTIONS: "--max-old-space-size=768" },
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.json).toMatchObject({
      code: "resource_constraint",
      input_path: input,
      input_reason: "too-large",
      details: {
        resource: "memory",
        reported_limits: {
          input_file_bytes: contentBytes + 2,
          string_code_units: expect.any(Number),
          string_assembly_headroom_bytes: expect.any(Number),
        },
      },
      remediation: {
        action: expect.stringContaining("re-analyze a smaller selection"),
      },
    });
  },
);
