import { fileURLToPath } from "node:url";
import { createRuleTester } from "../support/createRuleTester.js";

import rule from "../../scripts/lint/rules/no-shared-module-mock.mjs";

const tester = createRuleTester({
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
  languageOptions: { parserOptions: { lang: "ts" } },
});
const sharedFilename = fileURLToPath(
  new URL("./noSharedModuleMockRule.test.ts", import.meta.url),
);
tester.run("no-shared-module-mock", rule, {
  valid: [
    {
      filename: sharedFilename,
      code: 'import { vi } from "vitest"; vi.spyOn(target, "method");',
    },
    {
      filename: sharedFilename,
      code: 'const source = "vi.mock(\\"./dependency.js\\")"; // vi.mock("./dependency.js")',
    },
    {
      filename: sharedFilename,
      code: 'import { vi as testing } from "vitest"; function local(testing: { mock(): void }) { testing.mock(); }',
    },
    {
      filename: sharedFilename,
      code: 'import * as vitest from "vitest"; function local(vitest: { vi: { mock(): void } }) { vitest.vi.mock(); }',
    },
    {
      filename: fileURLToPath(
        new URL("../../tests/unknown/ignored.test.ts", import.meta.url),
      ),
      code: 'import { vi } from "vitest"; vi.mock("./dependency.js");',
    },
  ],
  invalid: [
    {
      filename: sharedFilename,
      code: 'import * as vitest from "vitest"; vitest.vi["doMock"]("./dependency.js");',
      errors: [{ messageId: "shared" }],
    },
  ],
});
