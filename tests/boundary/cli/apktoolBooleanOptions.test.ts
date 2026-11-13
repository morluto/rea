import { expect, it } from "vitest";

import { invokeApktoolCli } from "../../support/cli/apktoolCli.js";

it("dispatches --no-strings as include_strings false", async () => {
  const result = await invokeApktoolCli([
    "decode-android-resources",
    "/targets/app.apk",
    "--no-strings",
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.requests).toEqual([
    {
      operation: "decode_android_resources",
      input: { path: "/targets/app.apk", include_strings: false },
    },
  ]);
});

it("keeps string projection enabled when the flag is omitted", async () => {
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

it("passes decode_timeout_ms only when the caller selects it", async () => {
  const omitted = await invokeApktoolCli([
    "decode-android-resources",
    "/targets/app.apk",
    "--json",
  ]);
  expect(omitted.exitCode).toBe(0);
  expect(omitted.requests[0]?.input).not.toHaveProperty("decode_timeout_ms");

  const selected = await invokeApktoolCli([
    "decode-android-resources",
    "/targets/app.apk",
    "--decode-timeout-ms",
    "900000",
    "--json",
  ]);
  expect(selected.exitCode).toBe(0);
  expect(selected.requests[0]?.input).toMatchObject({
    decode_timeout_ms: 900_000,
  });

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
