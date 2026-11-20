import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  resolveSupportedClientName,
  skillClientSchema,
  supportedClientSchema,
} from "../../../src/cli/clientNameInput.js";

describe("resolveSupportedClientName", () => {
  it.each([
    ["claude_code", "claude_code"],
    ["claude-code", "claude_code"],
    ["Claude Code", "claude_code"],
    ["CLAUDE_CODE", "claude_code"],
    [" claude -- code ", "claude_code"],
    ["claude-desktop", "claude_desktop"],
    ["gemini", "gemini_cli"],
    ["github-copilot", "vscode"],
    ["kilocode", "kilo"],
    ["Pi Agent", "pi"],
  ])("resolves %j to %s", (input, expected) => {
    expect(resolveSupportedClientName(input)).toBe(expected);
  });

  it.each(["nonsense", "", "claud_code"])("leaves %j unresolved", (input) => {
    expect(resolveSupportedClientName(input)).toBeUndefined();
  });
});

describe("client option schemas", () => {
  const options = z.object({
    client: z.array(supportedClientSchema),
    skillClient: z.array(skillClientSchema),
  });
  const failure = (value: Record<string, unknown>) => {
    const parsed = options.partial().safeParse(value);
    if (parsed.success) throw new Error("expected a validation failure");
    return parsed.error.issues;
  };

  it("parses typed spellings to canonical ids", () => {
    expect(
      options.parse({
        client: ["claude-code", "Gemini"],
        skillClient: ["Shared", "cursor", "claude-desktop"],
      }),
    ).toEqual({
      client: ["claude_code", "gemini_cli"],
      skillClient: ["shared", "cursor", "claude_desktop"],
    });
  });

  it("suggests the closest client on a typo", () => {
    const [issue] = failure({ client: ["claud_code"] });
    expect(issue).toMatchObject({ code: "invalid_value", path: ["client", 0] });
    expect(issue?.message).toBe(
      "Unknown client 'claud_code'. Did you mean 'claude_code'?",
    );
    expect(failure({ skillClient: ["shraed"] })[0]?.message).toBe(
      "Unknown client 'shraed'. Did you mean 'shared'?",
    );
  });

  it("lists the supported clients when nothing is close", () => {
    const [issue] = failure({ client: ["zzzz"] });
    expect(issue?.path).toEqual(["client", 0]);
    expect(issue?.message).toMatch(
      /^Unknown client 'zzzz'\. Supported clients: claude_code, claude_desktop, .*\.$/u,
    );
    const [skill] = failure({ skillClient: ["zzzz"] });
    expect(skill?.path).toEqual(["skillClient", 0]);
    expect(skill?.message).toMatch(
      /^Unknown client 'zzzz'\. Supported clients: shared, claude_code, /u,
    );
  });
});
