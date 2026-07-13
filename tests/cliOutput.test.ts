import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { sanitizeCliOutput } from "../src/cliOutput.js";

const execFileAsync = promisify(execFile);

describe("CLI output boundary", () => {
  it("preserves normal output and sanitizes text and JSON validation errors", () => {
    expect(sanitizeCliOutput("result: ok\n")).toBe("result: ok\n");
    expect(sanitizeCliOutput("result: VALIDATION_ERROR\n")).toBe(
      "result: VALIDATION_ERROR\n",
    );
    const raw =
      'code: VALIDATION_ERROR\nmessage: "raw Zod details"\nfieldErrors: SECRET\n';
    expect(sanitizeCliOutput(raw)).toBe(
      'code: VALIDATION_ERROR\nmessage: "REA could not read the command arguments. Run `rea --help`, correct the arguments, then try again."\n',
    );
    expect(
      JSON.parse(
        sanitizeCliOutput(
          JSON.stringify({
            code: "VALIDATION_ERROR",
            message: "raw Zod details",
            fieldErrors: [{ code: "invalid_type" }],
          }),
        ),
      ),
    ).toEqual({
      code: "VALIDATION_ERROR",
      message:
        "REA could not read the command arguments. Run `rea --help`, correct the arguments, then try again.",
    });
    expect(
      JSON.parse(
        sanitizeCliOutput(
          JSON.stringify({
            ok: false,
            error: {
              code: "VALIDATION_ERROR",
              message: "raw Zod details",
              fieldErrors: [{ code: "invalid_type" }],
            },
            meta: { command: "analyze" },
          }),
        ),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message:
          "REA could not read the command arguments. Run `rea --help`, correct the arguments, then try again.",
      },
      meta: { command: "analyze" },
    });
  });

  it("sanitizes a real missing-argument dispatcher failure", async () => {
    await expect(
      execFileAsync(process.execPath, ["scripts/rea.mjs", "analyze"], {
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({
      stdout:
        'code: VALIDATION_ERROR\nmessage: "REA could not read the command arguments. Run `rea --help`, correct the arguments, then try again."\n',
    });
    await expect(
      execFileAsync(
        process.execPath,
        ["scripts/rea.mjs", "--full-output", "--json", "analyze"],
        { cwd: process.cwd() },
      ),
    ).rejects.toMatchObject({
      stdout: expect.not.stringContaining("fieldErrors"),
    });
    await expect(
      execFileAsync(
        process.execPath,
        ["scripts/rea.mjs", "--full-output", "analyze"],
        { cwd: process.cwd() },
      ),
    ).rejects.toMatchObject({
      stdout:
        'ok: false\nerror:\n  code: VALIDATION_ERROR\n  message: "REA could not read the command arguments. Run `rea --help`, correct the arguments, then try again."\n',
    });
  });
});
