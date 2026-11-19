import { expect, it } from "vitest";
import { parseClientRegistrationCommand } from "./clientRegistrationCommand.js";

it.each([
  {
    text: '"/fixture/server path" "" --mcp',
    command: "/fixture/server path",
    args: ["", "--mcp"],
  },
  {
    text: String.raw`'C:\Program Files\server.exe' 'C:\data\file'`,
    command: String.raw`C:\Program Files\server.exe`,
    args: [String.raw`C:\data\file`],
  },
  {
    text: `fix'ture-'"server" 'a'"'"'b'`,
    command: "fixture-server",
    args: ["a'b"],
  },
  {
    text: "fixture-server '$TOKEN' ';' 'a\tb'",
    command: "fixture-server",
    args: ["$TOKEN", ";", "a\tb"],
  },
])(
  "preserves exact registration words from $text",
  ({ text, command, args }) => {
    expect(parseClientRegistrationCommand(text)).toEqual({
      ok: true,
      value: { command, args },
    });
  },
);

it.each([
  "",
  "   ",
  '""',
  "'' --mcp",
  "'unfinished",
  'server "unfinished',
  null,
  [1],
])("refuses a registration without an admitted executable (%j)", (input) =>
  expect(parseClientRegistrationCommand(input).ok).toBe(false),
);

it("preserves structured default words without command-text tokenization", () => {
  const selected = [
    String.raw`C:\fixture\server.exe`,
    "",
    "a'b",
    'x"y',
    "tab\there",
    "$TOKEN",
  ];
  const parsed = parseClientRegistrationCommand(selected);
  expect(parsed).toEqual({
    ok: true,
    value: { command: selected[0], args: selected.slice(1) },
  });
  expect(selected[1]).toBe("");
});

it("refuses HTTP transport sources without echoing URL credentials", () => {
  for (const source of [
    "https://fixture.invalid/mcp",
    "HTTPS://fixture.invalid/mcp",
    "http://fixture-user:fixture-secret@fixture.invalid/mcp",
  ]) {
    const parsed = parseClientRegistrationCommand(source);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("Expected an unsupported transport");
    expect(parsed.error.kind).toBe("unsupported_transport");
    expect(parsed.error.message).toContain("stdio");
    expect(parsed.error.message).not.toContain("fixture-secret");
    expect(parsed.error.message).not.toContain("fixture-user");
  }
  expect(
    parseClientRegistrationCommand("server https://fixture.invalid/argument"),
  ).toEqual({
    ok: true,
    value: { command: "server", args: ["https://fixture.invalid/argument"] },
  });
});

it.each([
  { input: "server\0suffix argument" },
  { input: "server 'arg\0suffix'" },
  { input: ["server\0suffix", "argument"] },
  { input: ["server", "arg\0suffix"] },
])(
  "refuses OS-unrepresentable NUL in authored command/arguments: $input",
  ({ input }) => {
    const parsed = parseClientRegistrationCommand(input);
    expect(parsed).toMatchObject({
      ok: false,
      error: { kind: "invalid_argument" },
    });
    if (parsed.ok) throw Error("Expected rejected process arguments");
    expect(parsed.error.message).toContain("NUL");
  },
);
