import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

export function createRuleTester(
  config: RuleTester.Config = {
    languageOptions: { parserOptions: { lang: "ts" } },
  },
): RuleTester {
  RuleTester.describe = describe;
  RuleTester.it = it;
  return new RuleTester(config);
}
