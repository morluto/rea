import { createHash } from "node:crypto";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  createQwenSkillReadback,
  hasQwenSuccessfulResult,
  qwenPersistedOutput,
  qwenSavedSkillPath,
  qwenToolResponseText,
} from "../../../scripts/verify/clients/qwen-evidence.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("binds Qwen skill text to the selected native tool reply", () => {
  const skill = "Base directory for this skill: /owned/skill";
  const body = "The complete authored skill body.";
  const reply = { role: "tool", tool_call_id: "selected" };
  const unrelated = [
    { ...reply, role: "user", content: body },
    { ...reply, tool_call_id: "other", content: body },
    { ...reply, content: skill },
  ];

  expect(qwenToolResponseText(unrelated, undefined)).toBe("");
  expect(qwenToolResponseText(unrelated, "selected")).toBe(skill);
  expect(
    qwenToolResponseText(
      [{ ...reply, content: [{ text: skill }, { text: body }] }, ...unrelated],
      "selected",
    ),
  ).toBe(`${skill}\n${body}`);
});

it("re-reads Qwen's clipped final line and verifies the complete skill", () => {
  const expected =
    "Base directory for this skill: /owned/skill\nKeep paths literal.\n";
  const text = expected + "Next instruction.\n";
  const digest = createHash("sha256").update(text).digest("hex");
  const notice = `<persisted-output>
Output too large (47 KB). Full output saved to: /owned/saved
Full output sha256: ${digest}
Preview (up to 2000 chars):
${expected}
</persisted-output>`;
  expect(qwenPersistedOutput(notice)).toEqual({ path: "/owned/saved", digest });
  expect(
    qwenPersistedOutput(notice.replace("sha256:", "unknown:")),
  ).toBeUndefined();
  expect(qwenPersistedOutput(notice.slice(19))).toBeUndefined();

  const readback = createQwenSkillReadback(digest, expected);
  expect(readback.range).toEqual({});
  const clipped =
    "Showing lines 1-2 of 4 total lines.\n\n---\n\nBase directory for this skill: /owned/skill\nKeep";
  expect(readback.receive(clipped)).toBe(false);
  expect(readback.range).toEqual({ offset: 1, limit: 3 });
  expect(() =>
    readback.receive(
      "Showing lines 3-4 of 4 total lines.\n\n---\n\nNext instruction.\n",
    ),
  ).toThrow("unexpected saved-skill page range");
  expect(
    readback.receive(
      "Showing lines 2-4 of 4 total lines.\n\n---\n\nKeep paths literal.\nNext instruction.\n",
    ),
  ).toBe(true);
  expect(createQwenSkillReadback(digest, expected).receive(text)).toBe(true);
  expect(() =>
    createQwenSkillReadback(digest, expected).receive(
      text.replace("Next", "Other"),
    ),
  ).toThrow("did not return the complete saved skill");
});

it.skipIf(process.platform === "win32")(
  "rejects a saved-skill alias outside the owned runtime",
  async () => {
    const parent = await createTestTempDirectory("rea-qwen-skill-path-");
    const runtime = join(parent, "runtime");
    const saved = join(runtime, "owned");
    const foreign = join(parent, "foreign");
    const alias = join(runtime, "alias");
    await mkdir(runtime);
    await Promise.all([
      writeFile(saved, "owned"),
      writeFile(foreign, "foreign"),
    ]);
    await symlink(foreign, alias);

    await expect(qwenSavedSkillPath(saved, runtime)).resolves.toBe(
      await realpath(saved),
    );
    await expect(qwenSavedSkillPath(alias, runtime)).rejects.toThrow(
      "outside the verifier's runtime",
    );
  },
);

it("requires Qwen's last result to confirm the exact final answer", () => {
  const init = { type: "system", subtype: "init" };
  const success = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "answer",
  };
  const failed = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
  };
  expect(hasQwenSuccessfulResult([init, success], "answer")).toBe(true);
  expect(hasQwenSuccessfulResult([init], "answer")).toBe(false);
  expect(
    hasQwenSuccessfulResult([init, { ...success, result: "" }], "answer"),
  ).toBe(false);
  expect(hasQwenSuccessfulResult([init, success, failed], "answer")).toBe(
    false,
  );
});
