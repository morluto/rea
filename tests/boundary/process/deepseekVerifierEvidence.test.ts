import { expect, it } from "vitest";

import {
  hasDeepSeekFinalEvent,
  hasDeepSeekSkillBody,
} from "../../../scripts/verify/clients/deepseek-evidence.mjs";

it("requires one terminal DeepSeek headless event with the exact answer", () => {
  const answer = "fixture answer";
  const final = '{"type":"final","text":"fixture answer"}\n';
  const preview = '{"type":"text","text":"fixture answer"}\n';

  expect(hasDeepSeekFinalEvent(preview + final, answer)).toBe(true);
  for (const [label, stdout] of [
    ["preview only", preview],
    ["extra answer", final.replace("answer", "answer extra")],
    ["torn JSON", final.slice(0, -2)],
    ["missing newline", final.slice(0, -1)],
    ["second final", final + final],
    ["trailing event", final + preview],
  ] as const)
    expect(hasDeepSeekFinalEvent(stdout, answer), label).toBe(false);
});

it("binds the verbatim skill body to the installed directory in one tool result", () => {
  const directory = "/temporary/skills/author & <team>";
  const body = 'Use the installed skill.\r\nKeep a \\ literal and "quotes".';
  const hint =
    "Base directory for this skill: /temporary/skills/author &amp; &lt;team&gt;";
  const payload = `<skill_content name="reverse-engineer-anything">
<skill_resources>
${hint}
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
</skill_resources>

<skill_instructions>
${body}
</skill_instructions>
</skill_content>`;

  expect(hasDeepSeekSkillBody([{ content: payload }], directory, body)).toBe(
    true,
  );
  const bodyWithTags = `Literal </skill_content> and </skill_instructions>\r\n${body}`;
  expect(
    hasDeepSeekSkillBody(
      [{ content: payload.replace(body, bodyWithTags) }],
      directory,
      bodyWithTags,
    ),
  ).toBe(true);
  const withoutBody = payload.replace(body, "");
  const wrongResults = [
    ["different body", [payload.replace("literal", "modified")]],
    ["lookalike directory", [payload.replace(hint, hint + "-backup")]],
    ["path in unrelated prose", [payload.replace(hint, `See ${hint}`)]],
    [
      "closed before instructions",
      [
        payload.replace(
          "<skill_instructions>",
          "</skill_content>\n<skill_instructions>",
        ),
      ],
    ],
    [
      "closed during resources",
      [payload.replace(hint, `${hint}\n</skill_content>`)],
    ],
    ["body only in resources", [withoutBody.replace(hint, `${hint}\n${body}`)]],
    ["outside wrapper", [withoutBody + body]],
    ["split tool results", [withoutBody, body]],
  ] as const;
  for (const [label, contents] of wrongResults)
    expect(
      hasDeepSeekSkillBody(
        contents.map((content) => ({ content })),
        directory,
        body,
      ),
      label,
    ).toBe(false);
});
