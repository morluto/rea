import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { RuleTester } from "oxlint/plugins-dev";
import rule from "../../scripts/lint/rules/project-wait-deadline.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const filename = fileURLToPath(
  new URL("../boundary/ruleControl.test.ts", import.meta.url),
);
const vitest = `import { expect, vi } from "vitest";`;
tester.run("project-wait-deadline", rule, {
  valid: [
    `${vitest} await expect.poll(() => ready).toBe(true);`,
    `${vitest} await expect.poll(() => ready, { interval: 10 }).toBe(true);`,
    `${vitest} await expect.poll(() => ready, { message: "ready" }).toBe(true);`,
    `${vitest} await expect.poll(() => ready, { ["interval"]: 10 }).toBe(true);`,
    `import { waitFor } from "../support/testWait.js"; await waitFor(() => ready, { interval: 10 });`,
    // Same names that are not Vitest's: a fixture method, or a shadowed local.
    `${vitest} await fixture.vi.waitFor(() => ready, { timeout: 5_000 });`,
    `import { expect } from "vitest"; const vi = { waitFor: (f: Function) => f() }; await vi.waitFor(() => ready);`,
    `import { vi } from "./local.js"; await vi.waitFor(() => ready);`,
    `${vitest} function local(expect: { poll: Function }) { return expect.poll(() => 1, { timeout: 5 }); }`,
    `${vitest} vi.waitUntil;`,
  ].map((code) => ({ code, filename })),
  invalid: [
    ...[
      `${vitest} await vi.waitFor(() => ready);`,
      `${vitest} await vi.waitFor(() => ready, { interval: 10 });`,
      `import { vi as mocks } from "vitest"; await mocks.waitFor(() => ready);`,
      `import * as vitest from "vitest"; await vitest.vi.waitFor(() => ready);`,
      `${vitest} await vi?.waitFor(() => ready);`,
    ].map((code) => ({ code, filename, errors: [{ messageId: "viWaitFor" }] })),
    ...[
      `${vitest} await expect.poll(() => ready, { timeout: 5_000 }).toBe(true);`,
      `${vitest} await expect.poll(() => ready, { interval: 10, timeout: limit }).toBe(true);`,
      `${vitest} await expect.poll(() => ready, 5_000).toBe(true);`,
      `${vitest} await expect.poll(() => ready, options).toBe(true);`,
      `import { expect as assert } from "vitest"; await assert.poll(() => ready, { timeout: 5 }).toBe(true);`,
      `import * as vitest from "vitest"; await vitest.expect.poll(() => ready, { "timeout": 5 }).toBe(true);`,
      `${vitest} await expect.poll(() => ready, { ["timeout"]: 5 }).toBe(true);`,
      `${vitest} await expect.poll(() => ready, { ...{ timeout: 5 } }).toBe(true);`,
      `${vitest} await expect.poll(() => ready, { [key]: 5 }).toBe(true);`,
    ].map((code) => ({
      code,
      filename,
      errors: [{ messageId: "pollTimeout" }],
    })),
  ],
});
