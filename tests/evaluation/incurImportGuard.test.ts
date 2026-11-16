import { expect, it } from "vitest";
import {
  incurImportedNameCount,
  incurZodImportCount,
} from "../../scripts/verify/incur-import-guard.mjs";

it("counts every name a declaration takes from incur", () => {
  expect(incurImportedNameCount('import { Cli } from "incur";')).toBe(1);
  expect(
    incurImportedNameCount(
      'import { Errors, type MiddlewareHandler } from "incur";',
    ),
  ).toBe(2);
  expect(incurImportedNameCount("import type { Cli as C } from 'incur';")).toBe(
    1,
  );
  expect(
    incurImportedNameCount(
      'import { Help } from "incur";\nexport { Filter } from "incur";',
    ),
  ).toBe(2);
  expect(incurImportedNameCount('import { Help } from "./help.js";')).toBe(0);
  expect(incurImportedNameCount('// import { Help } from "incur";')).toBe(0);
});

it("counts namespace, default, star, side-effect and dynamic imports", () => {
  expect(incurImportedNameCount('import * as Incur from "incur";')).toBe(1);
  expect(incurImportedNameCount('import type * as I from "incur";')).toBe(1);
  expect(incurImportedNameCount('import incur from "incur";')).toBe(1);
  expect(incurImportedNameCount('import incur, { Help } from "incur";')).toBe(
    2,
  );
  expect(incurImportedNameCount('import incur, * as I from "incur";')).toBe(2);
  expect(incurImportedNameCount('export * from "incur";')).toBe(1);
  expect(incurImportedNameCount('export * as Incur from "incur";')).toBe(1);
  expect(incurImportedNameCount('import "incur";')).toBe(1);
  expect(incurImportedNameCount('const m = await import("incur");')).toBe(1);
  expect(incurImportedNameCount('import * as Zod from "zod";')).toBe(0);
  expect(incurImportedNameCount("export const from = 1;")).toBe(0);
  expect(incurImportedNameCount('const u = import.meta.url; "incur";')).toBe(0);
});

it("counts declarations that take z from incur in every spelling", () => {
  expect(incurZodImportCount('import { z } from "incur";')).toBe(1);
  expect(incurZodImportCount("import type { z } from 'incur';")).toBe(1);
  expect(incurZodImportCount('import { Cli, type z } from "incur";')).toBe(1);
  expect(incurZodImportCount('import { z as zod } from "incur";')).toBe(1);
  expect(incurZodImportCount('export { z } from "incur";')).toBe(1);
  expect(
    incurZodImportCount(
      'import {\n  Cli,\n  z,\n} from "incur";\nconst a = 1;',
    ),
  ).toBe(1);
});

it("ignores other names, other modules and non-declaration text", () => {
  expect(incurZodImportCount('import { Cli } from "incur";')).toBe(0);
  expect(incurZodImportCount('import { schema as z } from "incur";')).toBe(0);
  expect(incurZodImportCount('import { z } from "zod";')).toBe(0);
  expect(incurZodImportCount('// import { z } from "incur";')).toBe(0);
  expect(incurZodImportCount('/* import { z } from "incur"; */')).toBe(0);
  expect(
    incurZodImportCount("const fixture = 'import { z } from \"incur\";';"),
  ).toBe(0);
  expect(
    incurZodImportCount('const fixture = `\nimport { z } from "incur";\n`;'),
  ).toBe(0);
});
