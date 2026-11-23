import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isPathWithinRoot } from "#dist/domain/localPath.js";

/**
 * @param {readonly {role?: string, tool_call_id?: string, content?: unknown}[]} messages
 * @param {string | undefined} callId
 */
export function qwenToolResponseText(messages, callId) {
  if (callId === undefined) return "";
  const content = messages.find(
    (message) => message.role === "tool" && message.tool_call_id === callId,
  )?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** @param {string} text */
export function qwenPersistedOutput(text) {
  if (!text.endsWith("\n</persisted-output>")) return undefined;
  const match =
    /^<persisted-output>\nOutput too large \([^)]+\)\. Full output saved to: ([^\r\n]+)\nFull output sha256: ([a-f0-9]{64})\n/u.exec(
      text,
    );
  return match === null ? undefined : { path: match[1], digest: match[2] };
}

/** @param {string} path @param {string} runtime */
export async function qwenSavedSkillPath(path, runtime) {
  assert(isAbsolute(path), "Qwen reported a relative saved-skill path.");
  const [canonicalPath, root] = await Promise.all([
    realpath(path),
    realpath(runtime),
  ]);
  assert(
    canonicalPath !== root && isPathWithinRoot(root, canonicalPath),
    "Qwen saved the skill outside the verifier's runtime.",
  );
  return canonicalPath;
}

/**
 * @param {readonly {type?: string, subtype?: string, is_error?: boolean, result?: string}[]} events
 * @param {string} answer
 */
export function hasQwenSuccessfulResult(events, answer) {
  const result = events.findLast((event) => event.type === "result");
  return (
    result?.subtype === "success" &&
    result.is_error === false &&
    result.result === answer
  );
}

/**
 * Join Qwen's read_file pages from matched tool replies. Its byte limit can
 * clip the last reported line of a page, so re-read that line with the next
 * page. The saved-output digest proves the observed text is complete.
 * @param {string} digest
 * @param {string} expectedSkill
 */
export function createQwenSkillReadback(digest, expectedSkill) {
  /** @type {string[]} */
  const chunks = [];
  let offset = 0;
  let total = 0;
  return {
    get range() {
      return offset === 0 ? {} : { offset, limit: total - offset };
    },
    /** @param {string} reply */
    receive(reply) {
      const page =
        /^Showing lines (\d+)-(\d+) of (\d+) total lines\.\n\n---\n\n([\s\S]*)$/u.exec(
          reply,
        );
      if (page === null) {
        assert(offset === 0, "Qwen omitted the saved-skill page range.");
        chunks.push(reply);
      } else {
        const start = Number(page[1]);
        const end = Number(page[2]);
        const reportedTotal = Number(page[3]);
        assert(
          start === offset + 1 &&
            end >= start &&
            end <= reportedTotal &&
            Number.isSafeInteger(reportedTotal) &&
            (total === 0 || total === reportedTotal),
          "Qwen returned an unexpected saved-skill page range.",
        );
        total = reportedTotal;
        const lines = page[4].split("\n");
        assert.equal(
          lines.length,
          end - start + 1,
          "Qwen omitted saved-skill lines.",
        );
        if (end < total) {
          assert(
            end > start,
            "Qwen's read limit prevented a complete saved-skill line.",
          );
          chunks.push(lines.slice(0, -1).join("\n"));
          offset = end - 1;
          return false;
        }
        chunks.push(page[4]);
      }
      const text = chunks.join("\n");
      assert.equal(
        createHash("sha256").update(text).digest("hex"),
        digest,
        "Qwen did not return the complete saved skill to the model.",
      );
      assert(
        text.includes(expectedSkill),
        "Qwen did not load the installed skill.",
      );
      return true;
    },
  };
}
