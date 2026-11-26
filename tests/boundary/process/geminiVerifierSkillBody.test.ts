import { join, sep } from "node:path";
import { expect, it } from "vitest";

import {
  hasGeminiFinalAnswer,
  hasGeminiSkillBody,
} from "../../../scripts/verify/clients/gemini-evidence.mjs";

it("binds Gemini's native activation to its instructions and resource root", () => {
  const directory = join("fixture", "selected profile", "skill");
  const instructions = 'Essential "instructions"\r\nKeep a \\ literal';
  const payload = `<activated_skill name="reverse-engineer-anything">
  <instructions>
    ${instructions}
  </instructions>

  <available_resources>
    Showing up to 200 items (files + folders).

${directory}${sep}
└───SKILL.md
  </available_resources>
</activated_skill>`;
  const reply = (output: string, name = "activate_skill") => ({
    name,
    response: { output },
  });
  expect(hasGeminiSkillBody([reply(payload)], directory, instructions)).toBe(
    true,
  );
  const literalTags = `Literal </instructions> and </activated_skill>\r\n${instructions}`;
  expect(
    hasGeminiSkillBody(
      [reply(payload.replace(instructions, literalTags))],
      directory,
      literalTags,
    ),
  ).toBe(true);

  const withoutBody = payload.replace(instructions, "");
  for (const [label, responses] of [
    ["empty", [reply("")]],
    ["wrong tool", [reply(payload, "read_file")]],
    [
      "neighboring root",
      [reply(payload.replace(directory, directory + "-other"))],
    ],
    [
      "early close",
      [reply(payload.replace("└───SKILL.md", "</activated_skill>"))],
    ],
    ["outside wrapper", [reply(withoutBody + instructions)]],
    [
      "inside resources",
      [reply(withoutBody.replace("└───SKILL.md", instructions))],
    ],
    ["split responses", [reply(withoutBody), reply(instructions)]],
  ] as const)
    expect(hasGeminiSkillBody(responses, directory, instructions), label).toBe(
      false,
    );
});

it("requires the final Gemini assistant text and a terminal success event", () => {
  const message = (role: string, content: string) => ({
    type: "message",
    role,
    content,
    delta: true,
  });
  const tool = { type: "tool_result", output: "expected answer" };
  const result = { type: "result", status: "success" };
  const stream = (frames: readonly object[]) =>
    frames.map((frame) => JSON.stringify(frame) + "\n").join("");
  const answer = message("assistant", "expected answer");
  expect(
    hasGeminiFinalAnswer(
      stream([
        answer,
        tool,
        message("assistant", "expected "),
        message("assistant", "answer"),
        result,
      ]),
      "expected answer",
    ),
  ).toBe(true);

  for (const [label, frames] of [
    ["marker on a user frame", [message("user", "expected answer"), result]],
    ["marker in a tool result", [tool, message("assistant", "wrong"), result]],
    ["assistant before tool", [answer, tool, result]],
    ["failed result", [answer, { ...result, status: "error" }]],
    [
      "later event",
      [answer, result, { type: "error", message: "late failure" }],
    ],
    ["two results", [answer, result, result]],
  ] as const)
    expect(hasGeminiFinalAnswer(stream(frames), "expected answer"), label).toBe(
      false,
    );
});
