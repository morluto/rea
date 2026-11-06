import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  cliTest,
  runFileCli,
  type CliResult,
} from "../../support/cli/cliFixture.js";

const SESSION_ID = "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a";
const NON_INTEGER_TEXT = [
  "",
  " ",
  "\t",
  "1\n",
  "0x1",
  "0b1",
  "1e0",
  "+1",
  "1.0",
  "9007199254740992",
];
const NON_INTEGER_OPTION_TEXT = [...NON_INTEGER_TEXT, "-0"];

/** A readable 256-byte file, so only option parsing can refuse the request. */
const entropySample = async (): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-entropy-options-"),
    "sample.bin",
  );
  await writeFile(
    path,
    Uint8Array.from({ length: 256 }, (_, index) => index),
  );
  return path;
};

const expectCliValidationError = (result: CliResult, field: string): void => {
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining(field) }),
    ]),
  });
};

describe("CLI integer arguments", () => {
  // Run independent processes before retaining the shared validation worker.
  cliTest.for(NON_INTEGER_OPTION_TEXT)(
    "rejects %j as an Android method overload index",
    async (value, { cli }) => {
      const result = await cli.run({
        arguments: [
          "inspect-android-method",
          "/nonexistent/missing.apk",
          "com.example.Main",
          "run",
          `--overload-index=${value}`,
          "--json",
        ],
      });

      expectCliValidationError(result, "overloadIndex");
    },
  );

  cliTest(
    "keeps an explicit decimal zero as an Android method overload index",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: [
          "inspect-android-method",
          "/nonexistent/missing.apk",
          "com.example.Main",
          "run",
          "--overload-index=0",
          "--json",
        ],
      });

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "target_unavailable",
      });
    },
  );

  cliTest(
    "keeps an explicit decimal zero as an Android reference overload index",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: [
          "trace-android-references",
          "/nonexistent/missing.apk",
          "com.example.Main",
          "--overload-index=0",
          "--json",
        ],
      });

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "target_unavailable",
      });
    },
  );

  cliTest(
    "keeps the one-based source line lower bound at the CLI boundary",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: [
          "trace-web-source-location",
          "/nonexistent/manifest.json",
          "0",
          "/nonexistent/app.js.map",
          "https://example.test/app.js.map",
          "0",
          "0",
          "--json",
        ],
      });

      expectCliValidationError(result, "line");
    },
  );

  cliTest.for(NON_INTEGER_OPTION_TEXT)(
    "rejects %j as an Android reference overload index",
    async (value, { cli }) => {
      const result = await runFileCli(cli, {
        arguments: [
          "trace-android-references",
          "/nonexistent/missing.apk",
          "com.example.Main",
          `--overload-index=${value}`,
          "--json",
        ],
      });

      expectCliValidationError(result, "overloadIndex");
    },
  );

  cliTest.for(NON_INTEGER_TEXT)(
    "rejects %j as a Cutter expected generation",
    async (value, { cli }) => {
      const result = await runFileCli(cli, {
        arguments: ["cutter-command", SESSION_ID, value, "pdi", "--json"],
      });

      expectCliValidationError(result, "expectedGeneration");
    },
  );

  cliTest.for(NON_INTEGER_TEXT)(
    "rejects %j as a web module script index",
    async (value, { cli }) => {
      const result = await runFileCli(cli, {
        arguments: [
          "trace-web-module-imports",
          "/nonexistent/manifest.json",
          value,
          "--json",
        ],
      });

      expectCliValidationError(result, "scriptIndex");
    },
  );

  cliTest.for(NON_INTEGER_OPTION_TEXT)(
    "rejects %j in a repeated web capture record selector",
    async (value, { cli }) => {
      const result = await runFileCli(cli, {
        arguments: [
          "inspect-web-network-capture",
          "/nonexistent/capture.qlog",
          "qlog",
          "--record",
          "0",
          "--record",
          value,
          "--json",
        ],
      });

      expectCliValidationError(result, "record");
    },
  );
});

describe("byte-entropy window options", () => {
  // The options share one parser, so one takes every malformed spelling.
  // Numeric coercion reads "0x10" as a valid length and "0x100" as a valid
  // block size; "384" is decimal but not a power of two.
  for (const [flag, field, values] of [
    ["--offset", "offset", NON_INTEGER_OPTION_TEXT],
    ["--length", "length", ["0x10"]],
    ["--block-size", "blockSize", ["0x100", "384"]],
  ] as const) {
    cliTest.for(values)(
      `rejects %j as a byte-entropy ${flag} value`,
      async (value, { cli }) => {
        const result = await runFileCli(cli, {
          arguments: [
            "inspect-byte-entropy",
            await entropySample(),
            `${flag}=${value}`,
            "--json",
          ],
        });

        expectCliValidationError(result, field);
      },
    );
  }

  cliTest(
    "keeps decimal byte-entropy windows and the omitted-length default",
    async ({ cli }) => {
      const path = await entropySample();
      const window = async (...flags: string[]): Promise<unknown> => {
        const result = await runFileCli(cli, {
          arguments: ["inspect-byte-entropy", path, ...flags, "--json"],
        });
        expect(result.exitCode, result.stdout).toBe(0);
        const { normalized_result: report } = JSON.parse(result.stdout) as {
          normalized_result: { block_size: number; window: unknown };
        };
        return { block_size: report.block_size, window: report.window };
      };

      expect(await window()).toEqual({
        block_size: 4096,
        window: { offset: 0, length: 256 },
      });
      expect(
        await window("--offset=016", "--length=16", "--block-size=256"),
      ).toEqual({ block_size: 256, window: { offset: 16, length: 16 } });
      expect(await window("--offset=0", "--length=0")).toEqual({
        block_size: 4096,
        window: { offset: 0, length: 0 },
      });
    },
  );
});

describe("artifact decimal options", () => {
  // Same admission as byte-entropy windows. One option takes every malformed
  // spelling; siblings in artifactCommands.ts take one coercion each.
  for (const [command, flag, field, values] of [
    ["inspect-keyed-archive", "--offset", "offset", NON_INTEGER_OPTION_TEXT],
    ["inspect-keyed-archive", "--limit", "limit", ["", "0x10", "1e2"]],
    ["inspect-asset-catalog", "--offset", "offset", ["", "0x10"]],
    ["inspect-asset-catalog", "--limit", "limit", ["1e2"]],
    ["decode-interface-builder", "--max-documents", "maxDocuments", ["0x10"]],
    ["decode-interface-builder", "--max-objects", "maxObjects", [""]],
    [
      "decode-interface-builder",
      "--max-connections",
      "maxConnections",
      ["1e2"],
    ],
  ] as const) {
    cliTest.for(values)(
      `rejects %j as ${command} ${flag}`,
      async (value, { cli }) => {
        const result = await runFileCli(cli, {
          arguments: [
            command,
            "/nonexistent/missing-artifact",
            `${flag}=${value}`,
            "--json",
          ],
        });

        expectCliValidationError(result, field);
      },
    );
  }

  cliTest("keeps decimal keyed-archive offset and limit", async ({ cli }) => {
    const result = await runFileCli(cli, {
      arguments: [
        "inspect-keyed-archive",
        "/nonexistent/missing-archive",
        "--offset=016",
        "--limit=1",
        "--json",
      ],
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "target_unavailable",
    });
  });
});

describe("objdump and Rizin command timeouts", () => {
  // The three commands share one parser, so one takes every malformed
  // spelling. Numeric coercion reads "0x10" as a 16 ms deadline.
  const missing = "/nonexistent/missing.bin";
  for (const [command, values] of [
    [["list-objdump-architectures"], NON_INTEGER_OPTION_TEXT],
    [["inspect-with-objdump", missing, "file_headers"], ["0x10"]],
    [["execute-rizin-command", missing, "i"], ["1e3"]],
  ] as const) {
    cliTest.for(values)(
      `rejects %j as ${command[0]} --command-timeout-ms`,
      async (value, { cli }) => {
        const result = await runFileCli(cli, {
          arguments: [...command, `--command-timeout-ms=${value}`, "--json"],
        });

        expectCliValidationError(result, "commandTimeoutMs");
      },
    );
  }

  cliTest("keeps a decimal Rizin command timeout", async ({ cli }) => {
    const result = await runFileCli(cli, {
      arguments: [
        "execute-rizin-command",
        missing,
        "i",
        "--command-timeout-ms=00120000",
        "--json",
      ],
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "invalid_request",
      details: { issues: [expect.objectContaining({ path: ["path"] })] },
    });
  });
});
