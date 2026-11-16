import { expect, it } from "vitest";
import { incurZodImportCount } from "../../scripts/verify/incur-import-guard.mjs";

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
