import { expect, it } from "vitest";

import { invokeApktoolCli } from "../../support/cli/apktoolCli.js";

it("enables strings and leaves the decode deadline unset by default", async () => {
  const result = await invokeApktoolCli([
    "decode-android-resources",
    "/targets/app.apk",
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.requests).toEqual([
    {
      operation: "decode_android_resources",
      input: { path: "/targets/app.apk", include_strings: true },
    },
  ]);
});

it("forwards a selected decode deadline and refuses invalid bounds", async () => {
  const selected = await invokeApktoolCli([
    "decode-android-resources",
    "/targets/app.apk",
    "--decode-timeout-ms",
    "900000",
    "--json",
  ]);
  expect(selected.exitCode).toBe(0);
  expect(selected.requests).toEqual([
    {
      operation: "decode_android_resources",
      input: {
        path: "/targets/app.apk",
        include_strings: true,
        decode_timeout_ms: 900_000,
      },
    },
  ]);

  for (const value of ["0", "2147483648"]) {
    const rejected = await invokeApktoolCli([
      "decode-android-resources",
      "/targets/app.apk",
      "--decode-timeout-ms",
      value,
      "--json",
    ]);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.requests).toEqual([]);
  }
});

it("documents the supported negative flag in command help", async () => {
  const result = await invokeApktoolCli(["decode-android-resources", "--help"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--no-strings");
});

it("preserves selected string pages and budgets and rejects an invalid page before decoding", async () => {
  const result = await invokeApktoolCli([
    "decode-android-resources",
    "/targets/app.apk",
    "--string-offset",
    "2000",
    "--string-limit",
    "100",
    "--max-total-strings",
    "200",
    "--max-string-table-bytes",
    "12000000",
    "--max-total-string-table-bytes",
    "24000000",
    "--json",
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.requests[0]?.input).toMatchObject({
    string_offset: 2000,
    string_limit: 100,
    max_total_strings: 200,
    max_string_table_bytes: 12000000,
    max_total_string_table_bytes: 24000000,
  });
  const refused = await invokeApktoolCli([
    "decode-android-resources",
    "/targets/app.apk",
    "--string-limit",
    "0",
    "--json",
  ]);
  expect(refused.exitCode).not.toBe(0);
  expect(refused.requests).toEqual([]);
});
