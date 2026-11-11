import { describe, expect } from "vitest";

import { nativeDataTypeInputSchema } from "../../../src/domain/native/nativeDataType.js";
import { cliTest, runFileCli } from "../../support/cli/cliFixture.js";

const selectors = [
  ["function", "procedure", "analyze_function"],
  ["inspect-native-api", "procedure", "inspect_native_api"],
  ["instructions", "procedure", "read_function_instructions"],
  ["decompile", "procedure", "procedure_pseudo_code"],
  ["xrefs", "address", "xrefs"],
  ["search", "pattern", "search_strings"],
  ["trace", "query", "trace_feature"],
] as const;

describe("CLI analysis selector boundaries", () => {
  cliTest(
    "accepts file offsets and rejects mixed coordinate selectors before opening a target",
    async ({ cli }) => {
      const selected = await cli.run({
        arguments: [
          "decompile",
          "does-not-exist",
          "--file-offset=0x210",
          "--json",
        ],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(selected.json).toMatchObject({ code: "target_unavailable" });
      const conflicting = await cli.run({
        arguments: [
          "decompile",
          "does-not-exist",
          "0x140001010",
          "--file-offset=0x210",
          "--json",
        ],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(conflicting.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "procedure_pseudo_code",
          issues: [{ path: ["file-offset"], reason: "invalid_value" }],
        },
      });
    },
  );
  for (const [command, option, operation] of selectors) {
    cliTest(
      `rejects missing and conflicting ${command} selectors before opening a target`,
      async ({ cli }) => {
        for (const [selection, reason] of [
          [[], "missing_argument"],
          [["first", `--${option}=-second`], "invalid_value"],
        ] as const) {
          const result = await cli.run({
            arguments: [
              command,
              "does-not-exist",
              ...selection,
              "--format",
              "json",
            ],
            environment: { REA_LOG_LEVEL: "silent" },
          });
          expect(result.exitCode).not.toBe(0);
          expect(result.json).toMatchObject({
            code: "invalid_request",
            details: { operation, issues: [{ path: [option], reason }] },
          });
        }
      },
    );
    cliTest(
      `keeps named ${command} dash values out of global-option parsing`,
      async ({ cli }) => {
        const result = await cli.run({
          arguments: [
            command,
            "does-not-exist",
            `--${option}=--help`,
            "--format",
            "json",
          ],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.json).toMatchObject({ code: "target_unavailable" });
      },
    );
  }

  cliTest(
    "admits positional, named, and identical selectors before opening a missing target",
    async ({ cli }) => {
      for (const [command, option] of selectors) {
        for (const selection of [
          ["selector"],
          [`--${option}=selector`],
          ["selector", `--${option}=selector`],
        ]) {
          const label = `${command} ${selection.join(" ")}`;
          const result = await runFileCli(cli, {
            arguments: [
              command,
              "does-not-exist",
              ...selection,
              "--format",
              "json",
            ],
            environment: { REA_LOG_LEVEL: "silent" },
          });
          expect(result.exitCode, label).not.toBe(0);
          expect(result.json, label).toMatchObject({
            code: "target_unavailable",
          });
        }
      }
    },
  );
});

cliTest(
  "accepts an Objective-C instance method through inspect-native-api's named selector",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: [
        "inspect-native-api",
        "does-not-exist",
        "--procedure=-[Widget run]",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({ code: "target_unavailable" });
  },
);

const dataTypeChoiceMessage = (): string => {
  const parsed = nativeDataTypeInputSchema.safeParse({});
  if (parsed.success)
    throw new Error("nativeDataTypeInputSchema accepted empty input");
  const issue = parsed.error.issues.find((item) => item.path.length === 0);
  if (issue === undefined)
    throw new Error("nativeDataTypeInputSchema omitted root selector issue");
  return issue.message;
};

cliTest(
  "admits exactly one nonempty native data type selector before opening a target",
  async ({ cli }) => {
    const message = dataTypeChoiceMessage();
    expect(message).toContain("type");
    expect(message).toContain("address");
    const invalid = (issue: Record<string, unknown>) => ({
      code: "invalid_request",
      details: { operation: "inspect_native_data_type", issues: [issue] },
    });
    const choice = invalid({ path: [], reason: "invalid_value", message });
    for (const [selection, expected] of [
      [[], choice],
      [["--type", "/MyStruct", "--address", "0x1000"], choice],
      [
        ["--type", ""],
        invalid({ path: ["type"], reason: "out_of_range", minimum: 1 }),
      ],
      [
        ["--address", ""],
        invalid({ path: ["address"], reason: "out_of_range", minimum: 1 }),
      ],
      [["--type", "/MyStruct"], { code: "target_unavailable" }],
      [["--address", "0x1000"], { code: "target_unavailable" }],
    ] as const) {
      const label = `inspect-native-data-type ${selection.join(" ")}`;
      const result = await runFileCli(cli, {
        arguments: [
          "inspect-native-data-type",
          "does-not-exist",
          ...selection,
          "--format",
          "json",
        ],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(result.exitCode, label).not.toBe(0);
      expect(result.json, label).toMatchObject(expected);
    }
  },
);

cliTest(
  "validates native operation inputs before opening a target",
  async ({ cli }) => {
    for (const [selection, code] of [
      [
        ["inspect-native-instruction", "missing-target", ""],
        "VALIDATION_ERROR",
      ],
      [
        ["resolve-native-call-targets", "missing-target", ""],
        "VALIDATION_ERROR",
      ],
      [["annotate-native-function", "missing-target", ""], "VALIDATION_ERROR"],
      [
        ["annotate-native-function", "missing-target", "main"],
        "invalid_request",
      ],
      [
        ["annotate-native-function", "missing-target", "main", "--comment="],
        "target_unavailable",
      ],
    ] as const) {
      const result = await cli.run({
        arguments: [...selection, "--json"],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(result.json, JSON.stringify(selection)).toMatchObject({ code });
    }
  },
);

for (const [command, option] of [
  ["xrefs", "address"],
  ["function", "procedure"],
  ["instructions", "procedure"],
  ["decompile", "procedure"],
  ["inspect-native-api", "procedure"],
] as const) {
  cliTest(
    `admits equivalent native coordinates through ${command}`,
    async ({ cli }) => {
      const result = await cli.run({
        arguments: [
          command,
          "does-not-exist",
          "0x1a",
          `--${option}=0x001A`,
          "--json",
        ],
      });
      expect(result.json).toMatchObject({ code: "target_unavailable" });
      if (command === "xrefs") {
        for (const [left, right] of [
          ["ram:0x1", "RAM:0x1"],
          ["Symbol", "symbol"],
        ] as const) {
          const conflict = await cli.run({
            arguments: [
              command,
              "does-not-exist",
              left,
              `--${option}=${right}`,
              "--json",
            ],
          });
          expect(conflict.json).toMatchObject({ code: "invalid_request" });
        }
      }
    },
  );
}
cliTest("keeps address-looking search text exact", async ({ cli }) => {
  const result = await cli.run({
    arguments: ["search", "does-not-exist", "0x1a", "--pattern=0x1A", "--json"],
  });
  expect(result.json).toMatchObject({ code: "invalid_request" });
});
