import type { CallToolResult } from "@modelcontextprotocol/server";

import type { DesktopBuildComputers } from "../application/desktop/DesktopBuildComputers.js";
import type { ProgressReporter } from "../ports/ProgressReporter.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** The build computers the desktop build tools drive. */
export type DesktopBuildToolComputers = Pick<
  DesktopBuildComputers,
  "start" | "act" | "close" | "steps" | "measure" | "redaction" | "progressMs"
>;

/**
 * Report progress every `intervalMs` while a long build step works, so a
 * client's request timeout can reset; the step reports on the same
 * reporter, whose notifications keep one order.
 */
export const withHeartbeat = async <Value>(
  progress: ProgressReporter,
  phase: string,
  intervalMs: number,
  run: (progress: ProgressReporter) => Promise<Value>,
): Promise<Value> => {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    void progress
      .report({
        phase,
        completed: 0,
        total: null,
        message: `working (${String(Math.round((Date.now() - startedAt) / 1000))} s)`,
      })
      .catch(() => undefined);
  }, intervalMs);
  try {
    return await run(progress);
  } finally {
    clearInterval(timer);
  }
};

/**
 * A result with each typed secret's value replaced by its handle, in its
 * text and structured content; images pass as they are.
 */
export const redactedResult = (
  result: CallToolResult,
  redact: DesktopBuildComputers["redaction"],
): CallToolResult => ({
  ...result,
  content: result.content.map((block) =>
    block.type === "text"
      ? { ...block, text: redact.redact(block.text) }
      : block,
  ),
  ...(result.structuredContent === undefined
    ? {}
    : {
        structuredContent: redact.redactJson(
          result.structuredContent as JsonValue,
        ) as Record<string, unknown>,
      }),
});
