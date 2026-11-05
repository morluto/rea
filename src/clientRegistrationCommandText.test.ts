import { describe, expect, it } from "vitest";

import { clientRegistrationCommandText } from "./cli/clientRegistrationCommandText.js";

describe("client registration command text", () => {
  it("leaves plain paths and words unquoted", () => {
    expect(
      clientRegistrationCommandText([
        "/opt/homebrew/bin/node",
        "/opt/homebrew/bin/rea",
        "mcp",
      ]),
    ).toBe("/opt/homebrew/bin/node /opt/homebrew/bin/rea mcp");
  });

  it("keeps package specifiers with @ and = unquoted", () => {
    expect(
      clientRegistrationCommandText(["npx", "-y", "rea-agents@6.8.0"]),
    ).toBe("npx -y rea-agents@6.8.0");
  });

  it.each([
    ["a path with a space", "/Users/a b/node", "'/Users/a b/node'"],
    ["an empty argument", "", "''"],
    ["a single quote", "it's", `'it'"'"'s'`],
    ["a shell metacharacter", "a;b", "'a;b'"],
  ])("quotes %s", (_name, argument, expected) => {
    expect(clientRegistrationCommandText([argument])).toBe(expected);
  });
});
