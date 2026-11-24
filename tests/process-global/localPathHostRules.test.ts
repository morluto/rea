import { posix, win32 } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";

const host = vi.hoisted(() => ({ pathStyle: "posix" as "posix" | "win32" }));
vi.mock("node:path", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:path")>();
  return {
    ...original,
    isAbsolute: (value: string) => original[host.pathStyle].isAbsolute(value),
  };
});

import { absoluteLocalPathStringSchema } from "../../src/domain/localPath.js";

it("keeps the serialized contract fixed while enforcing the executing host's path rules", () => {
  const paths = [
    "/absolute/path",
    "C:\\absolute\\path",
    "c:/absolute/path",
    "\\\\server\\share\\path",
    "\\rooted\\path",
    "C:relative",
    "relative/path",
    "file:///absolute/path",
  ];
  const serialized = JSON.stringify(
    z.toJSONSchema(absoluteLocalPathStringSchema),
  );
  const validate = new Ajv2020({ strict: false }).compile(
    JSON.parse(serialized),
  );
  for (const pathStyle of ["posix", "win32"] as const) {
    host.pathStyle = pathStyle;
    const rules = pathStyle === "posix" ? posix : win32;
    for (const path of paths) {
      const parsed = absoluteLocalPathStringSchema.safeParse(path);
      expect(parsed.success, `${pathStyle}: ${path}`).toBe(
        rules.isAbsolute(path),
      );
      if (!parsed.success)
        expect(parsed.error.issues).toEqual([
          expect.objectContaining({ code: "invalid_format", format: "regex" }),
        ]);
      if (posix.isAbsolute(path) || win32.isAbsolute(path))
        expect(validate(path), path).toBe(true);
    }
    expect(JSON.stringify(z.toJSONSchema(absoluteLocalPathStringSchema))).toBe(
      serialized,
    );
  }
});
