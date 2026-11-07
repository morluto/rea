import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

it("pins the verification worker link to the checked source revision", () => {
  const text = readFileSync(
    resolve(
      root,
      "docs/verification/javascript-analysis-effects-2026-10-15.md",
    ),
    "utf8",
  );
  const link = text.match(/\[worker\]\(([^)]+)\)/u)?.[1];
  expect(link).toMatch(
    /^https:\/\/github\.com\/morluto\/rea\/blob\/[a-f0-9]{40}\/src\/javascript\/analysis\/JavaScriptAnalysisWorker\.ts$/u,
  );
  expect(
    existsSync(
      resolve(root, "src/javascript/analysis/JavaScriptAnalysisWorker.ts"),
    ),
  ).toBe(true);
});
