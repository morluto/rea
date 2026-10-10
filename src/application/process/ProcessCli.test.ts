import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureProcessScenarioFile,
  projectProcessCliError,
} from "./ProcessCli.js";
import { JSON_BYTE_ORDER_MARK_MESSAGE } from "../Utf8JsonInput.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-process-cli-diagnostics-"));
  roots.push(root);
  return root;
};

describe("process CLI input diagnostics", () => {
  it("preserves local diagnostics for unexpected process failures", () => {
    const projected = projectProcessCliError(
      new Error("SECRET internal failure /private/path"),
    );
    expect(projected).toEqual({
      error: "Process command failed",
      category: "execution_failure",
      message:
        "Process command could not complete: SECRET internal failure /private/path",
    });
    expect(JSON.stringify(projected)).not.toContain("stack");
  });

  it("projects missing, malformed JSON, and invalid scenario files", async () => {
    const root = await fixture();
    const malformed = join(root, "malformed.json");
    const invalid = join(root, "invalid.json");
    const invalidUtf8 = join(root, "invalid-utf8.json");
    await writeFile(malformed, "not-json");
    await writeFile(invalid, "{}");
    await writeFile(
      invalidUtf8,
      Buffer.concat([
        Buffer.from('{"executable":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]),
    );

    expect(
      await captureProcessScenarioFile(join(root, "missing.json")),
    ).toEqual({
      error: "Process command failed",
      category: "invalid_input",
      message: expect.stringContaining(
        `Process input file could not be read: ${join(root, "missing.json")} (ENOENT`,
      ),
    });
    expect(await captureProcessScenarioFile(malformed)).toEqual({
      error: "Process command failed",
      category: "invalid_input",
      message: expect.stringContaining(
        `Process input file is not valid UTF-8 JSON: ${malformed}`,
      ),
    });
    expect(await captureProcessScenarioFile(invalidUtf8)).toEqual({
      error: "Process command failed",
      category: "invalid_input",
      message: expect.stringContaining(
        `Process input file is not valid UTF-8 JSON: ${invalidUtf8}`,
      ),
    });
    expect(await captureProcessScenarioFile(invalid)).toEqual({
      error: "Process command failed",
      code: "invalid_request",
      category: "invalid_input",
      message: "Analysis input is invalid. Check the arguments and try again.",
      retryable: true,
      remediation: { action: "Correct the listed arguments and retry." },
      details: expect.objectContaining({
        operation: "capture_process_scenario",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["executable"] }),
        ]),
      }),
    });
  });

  it("names a leading byte-order mark instead of quoting it as a token", async () => {
    const path = join(await fixture(), "scenario.json");
    await writeFile(path, '\uFEFF{"executable":"/bin/echo"}');
    expect(await captureProcessScenarioFile(path)).toEqual({
      error: "Process command failed",
      category: "invalid_input",
      message: `Process input file is not valid UTF-8 JSON: ${path} (${JSON_BYTE_ORDER_MARK_MESSAGE}). Repair the file, then try again.`,
    });
  });
});
