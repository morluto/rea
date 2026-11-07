import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const fixture = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-raw-bytes-cli-");
  const path = join(root, "data.bin");
  const bytes = Buffer.alloc(256, 0xaa);
  Buffer.from([0x50, 0x45, 0x00, 0x00]).copy(bytes, 0x78);
  await writeFile(path, bytes);
  return path;
};

cliTest("reads a raw file slice through the public CLI", async ({ cli }) => {
  const path = await fixture();
  const result = await cli.run({
    arguments: [
      "inspect-raw-bytes",
      path,
      "--offset",
      "120",
      "--length",
      "8",
      "--json",
    ],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = toolContract("inspect_raw_bytes").outputSchema.parse(
    result.json,
  );
  expect(evidence.normalized_result.data_hex).toBe("50450000aaaaaaaa");
});

cliTest("searches a raw file through the public CLI", async ({ cli }) => {
  const path = await fixture();
  const result = await cli.run({
    arguments: ["search-raw-bytes", path, "50 45 00 00", "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = toolContract("search_raw_bytes").outputSchema.parse(
    result.json,
  );
  expect(
    evidence.normalized_result.matches.map(({ offset }) => offset),
  ).toEqual([120]);
});

cliTest("refuses a read longer than the ceiling", async ({ cli }) => {
  const path = await fixture();
  const result = await cli.run({
    arguments: ["inspect-raw-bytes", path, "--length", "4097", "--json"],
  });
  expect(result.exitCode).not.toBe(0);
});
