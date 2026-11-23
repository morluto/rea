import { execFile } from "node:child_process";
import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

/** A tree holding the scanner under test and the modules it imports. */
const scannerFixture = async (
  prefix: string,
): Promise<{ scanner: string; source: string; bridge: string }> => {
  const root = await createTestTempDirectory(prefix);
  const scripts = join(root, "scripts");
  const source = join(root, "src");
  const bridge = join(root, "bridge");
  await Promise.all([mkdir(scripts), mkdir(source), mkdir(bridge)]);
  const scanner = join(scripts, "scan-todos.mjs");
  await copyFile(join(process.cwd(), "scripts/scan-todos.mjs"), scanner);
  // The scanner resolves @babel/parser from the checkout that owns it.
  await symlink(
    join(process.cwd(), "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return { scanner, source, bridge };
};

describe("tech-debt marker scan", () => {
  it("passes a clean tree and rejects a tree containing a marker", async () => {
    const { scanner, source } = await scannerFixture("rea-scan-todos-");
    await writeFile(join(source, "clean.ts"), "export const clean = true;\n");

    await expect(execute(process.execPath, [scanner])).resolves.toMatchObject({
      stdout: "No tech-debt markers found.\n",
    });

    const marker = `TO${"DO"}`;
    await writeFile(join(source, "debt.ts"), `// ${marker}: close the gap\n`);
    await expect(execute(process.execPath, [scanner])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining(`${marker} - close the gap`),
    });
  });

  it("ignores quoted sample text and still reports a marker after it", async () => {
    const { scanner, source } = await scannerFixture("rea-scan-todos-quoted-");
    const marker = `TO${"DO"}`;
    await writeFile(
      join(source, "fixture.ts"),
      `export const sample = "capabilities: {}, // ${marker}: commented out";\n`,
    );

    await expect(execute(process.execPath, [scanner])).resolves.toMatchObject({
      stdout: "No tech-debt markers found.\n",
    });

    // The earlier quoted marker must not consume the real one on the same line.
    await writeFile(
      join(source, "mixed.ts"),
      `export const sample = "${marker}: quoted"; // ${marker}: real store\n`,
    );
    const mixed: { readonly stdout?: string } = await execute(
      process.execPath,
      [scanner],
    ).catch((error: { readonly stdout?: string }) => error);
    expect(mixed.stdout).toContain(`${marker} - real store`);
    expect(mixed.stdout).not.toContain("quoted");
  });

  it("reads comments in the languages the scan covers", async () => {
    const { scanner, bridge, source } = await scannerFixture(
      "rea-scan-todos-langs-",
    );
    const marker = `TO${"DO"}`;
    await writeFile(
      join(source, "regex.ts"),
      `const pattern = /'/; // ${marker}: after a regex literal\n`,
    );
    await writeFile(
      join(bridge, "script.py"),
      `value = 1  # it's a ${marker}: python comment\n`,
    );
    await writeFile(
      join(bridge, "Bridge.java"),
      `class Bridge { /* ${marker}: java block comment */ }\n`,
    );

    const scanned: { readonly code?: number; readonly stdout?: string } =
      await execute(process.execPath, [scanner]).catch(
        (error: { readonly code?: number; readonly stdout?: string }) => error,
      );
    expect(scanned.code).toBe(1);
    for (const expected of [
      `${marker} - after a regex literal`,
      `${marker} - python comment`,
      `${marker} - java block comment`,
    ])
      expect(scanned.stdout).toContain(expected);
  });

  it("reports bare markers on CRLF lines and comments in Python interpolation", async () => {
    const { scanner, bridge, source } = await scannerFixture(
      "rea-scan-todos-comments-",
    );
    const marker = `TO${"DO"}`;
    await writeFile(join(source, "crlf.ts"), `// ${marker}\r\n`);
    await writeFile(
      join(bridge, "interpolation.py"),
      `value = f"""{\n  1 # ${marker}: f-string replacement expression\n}"""\n`,
    );

    const scanned: { readonly code?: number; readonly stdout?: string } =
      await execute(process.execPath, [scanner]).catch(
        (error: { readonly code?: number; readonly stdout?: string }) => error,
      );
    expect(scanned.code).toBe(1);
    expect(scanned.stdout).toContain(`${join("src", "crlf.ts")}:1: ${marker}`);
    expect(scanned.stdout).toContain(
      `${join("bridge", "interpolation.py")}:2: ${marker} - f-string replacement expression`,
    );
  });

  it("bounds markers and their messages to the comment body", async () => {
    const { scanner, bridge, source } = await scannerFixture(
      "rea-scan-todos-comment-body-",
    );
    const marker = `TO${"DO"}`;
    await writeFile(
      join(source, "comments.ts"),
      `/* ${marker} */ export const value = 0;\n// ${marker}  \n/* ${marker}: short */ value;\n// ${marker} is a term here\n`,
    );
    await writeFile(
      join(bridge, "Bridge.java"),
      `class Bridge { /* ${marker} */ }\n`,
    );
    const scanned: { readonly code?: number; readonly stdout?: string } =
      await execute(process.execPath, [scanner]).catch(
        (error: { readonly code?: number; readonly stdout?: string }) => error,
      );
    expect(scanned.code).toBe(1);
    expect(scanned.stdout?.trim().split("\n").filter(Boolean).sort()).toEqual(
      [
        `${join("src", "comments.ts")}:1: ${marker}`,
        `${join("src", "comments.ts")}:2: ${marker}`,
        `${join("src", "comments.ts")}:3: ${marker} - short`,
        `${join("bridge", "Bridge.java")}:1: ${marker}`,
        "4 tech-debt marker(s) found.",
      ].sort(),
    );
  });

  it("reports Java markers when Unicode escapes can form comment delimiters", async () => {
    const { scanner, bridge } = await scannerFixture("rea-scan-todos-java-");
    const marker = `TO${"DO"}`;
    await writeFile(
      join(bridge, "EscapedDelimiter.java"),
      `\\u002f\\u002f ${marker}: escaped Java delimiter\nclass EscapedDelimiter {}\n`,
    );
    await expect(execute(process.execPath, [scanner])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining(`${marker} - escaped Java delimiter`),
    });
  });
});
