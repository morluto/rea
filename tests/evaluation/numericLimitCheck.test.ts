import { expect, it } from "vitest";
import {
  NUMERIC_LIMIT_DECLARATION,
  discoverNumericLimitUses,
  isNumericLimit,
} from "../../scripts/verify/rea-numeric-limits.mjs";

const ENDPOINT_CANDIDATES = "REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES";

it("recognizes the documented endpoint-candidate limit as numeric", () => {
  expect(isNumericLimit(ENDPOINT_CANDIDATES)).toBe(true);
  const discovered = discoverNumericLimitUses([
    {
      path: "src/domain/webBundleAnalysis.ts",
      source: `const candidates = process.env.${ENDPOINT_CANDIDATES};`,
    },
  ]);
  expect(discovered.get(ENDPOINT_CANDIDATES)).toBe(
    "src/domain/webBundleAnalysis.ts",
  );
});

it("does not treat a registry declaration as a producer", () => {
  const name = "REA_REMOVED_MAX_BYTES";
  const discovered = discoverNumericLimitUses([
    {
      path: NUMERIC_LIMIT_DECLARATION,
      source: `name: "${name}",`,
    },
    {
      path: "src/config/removedLimit.ts",
      source: `const value = process.env.${name};`,
    },
  ]);
  expect(discovered.get(name)).toBe("src/config/removedLimit.ts");
  expect(
    discoverNumericLimitUses([
      { path: NUMERIC_LIMIT_DECLARATION, source: `name: "${name}",` },
    ]).has(name),
  ).toBe(false);
});
