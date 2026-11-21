import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it("requires the default Flutter AOT result to belong to the identified ABI set", async () => {
  const invoke = (kind: string) =>
    execute(
      process.execPath,
      [
        "--import",
        resolve("tests/fixtures/flutterVerifierPreload.mjs"),
        "scripts/verify-flutter.mjs",
        "--apk",
        "/tmp/fixture.apk",
      ],
      { env: { ...process.env, REA_FLUTTER_PROBE: kind }, timeout: 10_000 },
    );
  await expect(invoke("wrong")).rejects.toMatchObject({
    stderr: expect.stringContaining(
      "Default AOT selection must be one of the identified ABIs",
    ),
  });
  const result = await invoke("correct");
  expect(result.stdout).toContain("all asserted Flutter CLI/MCP checks passed");
});
