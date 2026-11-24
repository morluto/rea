import { expect, it } from "vitest";
import { moduleReExportCount } from "../../scripts/verify/module-re-export-guard.mjs";

it.each([
  'export * from "./owner.js";',
  'export * as Legacy from "./owner.js";',
  'export type * as Legacy from "./owner.js";',
  'export /* forwarding */ type *\n  as Legacy\n  from "./owner.js";',
  'export type * from "./owner.js";',
  'export { value as legacy, type Options } from "./owner.js";',
  'export type { Options } from "./owner.js";',
])("counts a forwarding declaration in %s", (source) => {
  expect(moduleReExportCount(source)).toBe(1);
});

it.each([
  "export type Options = { enabled: boolean };",
  "export { local };",
  "export {};",
  'import { value } from "./owner.js";',
  '// export * as Legacy from "./owner.js";',
  'const sample = `\nexport * as Legacy from "./owner.js";\n`;',
])("ignores %s", (source) => {
  expect(moduleReExportCount(source)).toBe(0);
});

it("counts repeated forwarding declarations independently", () => {
  const source =
    'export * as Value from "./owner.js";\nexport type * as Types from "./owner.js";';
  expect(moduleReExportCount(source)).toBe(2);
});
