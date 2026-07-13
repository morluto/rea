import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createPackageWithOptions } from "@electron/asar";
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
  }, 20_000);

  it("preserves artifact diagnostics in ordinary and full JSON output", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-cli-diagnostics-"));
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "main.js"), "console.log('ok');\n");
    const archive = join(root, "fixture.asar");
    await createPackageWithOptions(source, archive, { unpack: "*.js" });
    await writeFile(join(`${archive}.unpacked`, "main.js"), "changed();\n");

    for (const flags of [["--json"], ["--full-output", "--json"]]) {
      const execution = execFileAsync(process.execPath, [
        "scripts/rea.mjs",
        ...flags,
        "inventory-artifact",
        archive,
      ]);
      const failure = await execution.catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ code: 1 });
      const { stdout } = failure as { readonly stdout: string };
      const output = JSON.stringify(JSON.parse(stdout) as unknown);
      expect(output).toContain('"logical_path":"main.js"');
      expect(output).toMatch(/"declared_sha256":"[a-f0-9]{64}"/u);
      expect(output).toMatch(/"calculated_sha256":"[a-f0-9]{64}"/u);
      expect(output).toContain('"unpacked":true');
    }
  }, 20_000);

  it("keeps operation failure status independent of output controls", async () => {
    const variants = [
      ["--format", "toon"],
      ["--format", "json"],
      ["--format", "yaml"],
      ["--format", "md"],
      ["--format", "jsonl"],
      ["--full-output", "--json"],
      ["--filter-output", "category", "--json"],
      ["--token-limit", "5", "--json"],
      ["--token-count", "--json"],
    ];

    for (const flags of variants) {
      await expect(
        execFileAsync(process.execPath, [
          "scripts/rea.mjs",
          ...flags,
          "investigate-versions",
          "/tmp/left",
          "/tmp/right",
          "/tmp/workspace.json",
        ]),
      ).rejects.toMatchObject({ code: 1, stdout: expect.any(String) });
    }
  }, 20_000);

  it("keeps failure logs out of structured stdout", async () => {
    const execution = execFileAsync(
      process.execPath,
      [
        "scripts/rea.mjs",
        "--json",
        "investigate-versions",
        "/tmp/left",
        "/tmp/right",
        "/tmp/workspace.json",
      ],
      { env: { ...process.env, REA_LOG_LEVEL: "error" } },
    );
    const failure = await execution.catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('"status":"error"'),
    });
    const { stdout } = failure as { readonly stdout: string };
    expect(JSON.parse(stdout)).toMatchObject({ error: "ApprovalRequired" });
  }, 20_000);
});
