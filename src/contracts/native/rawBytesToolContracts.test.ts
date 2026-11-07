import { expect, it } from "vitest";

import { toolContract } from "../toolContracts.js";

const inspect = toolContract("inspect_raw_bytes");
const search = toolContract("search_raw_bytes");

it("explains the difference between a raw file offset and a program memory address", () => {
  for (const contract of [inspect, search]) {
    expect(contract.description).toContain("RAW FILE OFFSET");
    expect(contract.description).toContain("not a program memory address");
  }
  expect(inspect.description).toContain("read_bytes");
  expect(search.description).toContain("search_bytes");
});

it("keeps both public inputs closed and bounded", () => {
  expect(
    inspect.inputSchema.parse({ path: "/file", length: 16 }),
  ).toMatchObject({ offset: 0, length: 16 });
  expect(
    inspect.inputSchema.safeParse({ path: "/file", length: 16, extra: 1 })
      .success,
  ).toBe(false);
  expect(
    inspect.inputSchema.safeParse({ path: "/file", length: 4097 }).success,
  ).toBe(false);
  expect(
    search.inputSchema.parse({ path: "/file", pattern: "50 45" }),
  ).toMatchObject({ start_offset: 0, max_matches: 100, context_lines: 0 });
  expect(
    search.inputSchema.safeParse({ path: "/file", pattern: "??" }).success,
  ).toBe(false);
});

it("declares both tools read-only evidence producers that return target content", () => {
  for (const contract of [inspect, search]) {
    expect(contract.effects).toMatchObject({
      mutatesTarget: false,
      writesFilesystem: false,
      launchesProcess: false,
      executesForeignCode: false,
      idempotent: true,
    });
    expect(contract.returnsTargetContent).toBe(true);
  }
});
