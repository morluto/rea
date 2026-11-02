import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import type { TestProcesses } from "../../support/process/processFixture.js";

/** Close after a byte threshold, or acknowledge a complete JSON document. */
const runWithClosedReader = async (
  processes: TestProcesses,
  arguments_: readonly string[],
  bytes: number | "complete-json",
) => {
  const child = processes.spawn(
    process.execPath,
    [
      ...(bytes === "complete-json"
        ? ["--import", resolve("tests/fixtures/stdoutReadCompletion.mjs")]
        : []),
      resolve("scripts/rea.mjs"),
      ...arguments_,
    ],
    { env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" } },
  );
  let received = 0;
  const chunks: Buffer[] = [];
  let json: unknown;
  if (bytes === 0) child.stdout.destroy();
  else
    child.stdout.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (bytes === "complete-json") {
        chunks.push(chunk);
        if (chunk.at(-1) !== 10) return;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return;
        }
        child.stdout.once("close", () => child.stdin.end("reader closed\n"));
        child.stdout.destroy();
      } else if (received >= bytes) child.stdout.destroy();
    });
  if (bytes !== "complete-json") child.stdin.end();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((done) =>
    child.once("close", done),
  );
  return { code, stderr, received, json };
};

// Windows reports a closed pipe reader through a different error path.
describe.skipIf(process.platform === "win32")(
  "CLI with a closed stdout",
  () => {
    cliTest(
      "keeps the command status when the reader closes after the complete diagnostic",
      async ({ processes }) => {
        const count = 2_048;
        const result = await runWithClosedReader(
          processes,
          [
            "demangle-swift",
            "missing",
            ...Array.from({ length: count }, () => "bad\nsymbol"),
            "--json",
          ],
          "complete-json",
        );
        expect(result).toMatchObject({
          code: 1,
          stderr: "",
          json: {
            code: "VALIDATION_ERROR",
            fieldErrors: expect.arrayContaining([
              expect.objectContaining({ path: `symbols.${count - 1}` }),
            ]),
          },
        });
      },
    );

    cliTest.for([
      ["toon", ["capabilities", "--format", "toon"]],
      ["json", ["capabilities", "--format", "json"]],
      ["mcp doctor", ["mcp", "doctor", "--json"]],
      [
        "validation error",
        ["inspect-keyed-archive", "missing", "--limit", "0", "--json"],
      ],
    ] as const)(
      "stops quietly with the SIGPIPE status when the reader closes first ($0)",
      async ([, arguments_], { processes }) => {
        const result = await runWithClosedReader(processes, arguments_, 0);
        expect(result).toMatchObject({ code: 141, stderr: "" });
      },
    );

    cliTest(
      "stops quietly when the reader closes during streamed JSON",
      async ({ processes }) => {
        const directory = await createTestTempDirectory("rea-closed-stdout-");
        const database = join(directory, "rows.db");
        const writer = new DatabaseSync(database);
        writer.exec("CREATE TABLE t (v TEXT)");
        const insert = writer.prepare("INSERT INTO t VALUES (?)");
        // 4 MiB of rows outlasts any pipe buffer, so writes continue after close.
        for (let row = 0; row < 64; row += 1) insert.run("x".repeat(65_536));
        writer.close();
        const result = await runWithClosedReader(
          processes,
          [
            "inspect-sqlite-database",
            database,
            "--table",
            "t",
            "--row-limit",
            "64",
            "--format",
            "json",
          ],
          1,
        );
        expect(result.received).toBeGreaterThan(0);
        expect(result).toMatchObject({ code: 141, stderr: "" });
      },
    );
  },
);
