import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { TestReverseEngineeringService } from "../../../tests/support/reverseEngineeringService.js";
import type { runOwnedCommand } from "../../process/OwnedCommand.js";

const fakeRizin = (stderr: string) =>
  (async () => ({
    diagnosticTruncated: false,
    stdout: { text: "", bytes: 0, observedBytes: 0 },
    stderr: {
      text: stderr,
      bytes: Buffer.byteLength(stderr),
      observedBytes: Buffer.byteLength(stderr),
    },
    exitCode: 0,
    signal: null,
  })) as unknown as typeof runOwnedCommand;

it("surfaces a Rizin unknown-command rejection in the limitations", async () => {
  const root = await createTestTempDirectory("rea-rizin-rejection-");
  const path = join(root, "artifact");
  await writeFile(path, "inert artifact fixture");
  const stderr =
    "ERROR: Command 'axffj' does not exist.\n" +
    "ERROR: Displaying the help of command 'axf'.\n";
  const service = new TestReverseEngineeringService({
    runOwned: fakeRizin(stderr),
  });

  const result = await service.executeRizinCommand({ path, command: "axffj" });
  if (!result.ok) throw new Error(result.error.message);

  const evidence = result.value;
  const observation = evidence.normalized_result as Record<string, unknown>;
  // The raw provider facts stay authoritative: complete with exit code 0.
  expect(observation.completion_status).toBe("complete");
  expect(observation.exit_code).toBe(0);
  expect(
    evidence.limitations.some((line) =>
      line.includes("Rizin rejected 'axffj'"),
    ),
  ).toBe(true);

  await service.close();
});

it("leaves the limitations unchanged for other stderr content", async () => {
  const root = await createTestTempDirectory("rea-rizin-rejection-ok-");
  const path = join(root, "artifact");
  await writeFile(path, "inert artifact fixture");
  const service = new TestReverseEngineeringService({
    runOwned: fakeRizin("note: no loader selected\n"),
  });

  const result = await service.executeRizinCommand({ path, command: "iI" });
  if (!result.ok) throw new Error(result.error.message);

  const evidence = result.value;
  expect(
    evidence.limitations.some((line) => line.includes("Rizin rejected")),
  ).toBe(false);

  await service.close();
});
