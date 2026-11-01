import { describe, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import rule from "../../scripts/lint/rules/no-bulk-append-spread.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
tester.run("no-bulk-append-spread", rule, {
  valid: [
    "appendAll(target, items);",
    "target.push(item);",
    "target.push(first, second);",
    "target.unshift(item);",
    "target.splice(0, target.length);",
    "const copy = [...items];",
    "call(...items);",
    "Math.max(...values);",
    "target[method](...items);",
  ],
  invalid: (
    [
      ["target.push(...items);", "push"],
      ["target.push(first, ...items);", "push"],
      ["state.pending.push(...directories.reverse());", "push"],
      ["target?.push(...items);", "push"],
      ['target["push"](...items);', "push"],
      ["target.unshift(...items);", "unshift"],
      ["target.splice(0, target.length, ...items);", "splice"],
      // Type-only and grouping wrappers leave the evaluated callee unchanged.
      ["target.push!(...items);", "push"],
      ["(target.push)(...items);", "push"],
      ["(target.push as typeof target.push)(...items);", "push"],
      ["(target.push satisfies Function)(...items);", "push"],
      ["(<typeof target.push>target.push)(...items);", "push"],
      ["target!.push(...items);", "push"],
      ["(target as string[]).unshift(...items);", "unshift"],
      ["(<string[]>target).splice(0, 0, ...items);", "splice"],
    ] as const
  ).map(([code, method]) => ({
    code,
    errors: [{ messageId: "spread", data: { method } }],
  })),
});
