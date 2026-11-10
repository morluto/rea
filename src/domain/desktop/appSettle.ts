import { createHash } from "node:crypto";

/** How an app's data/get is read until its files settle; the exported verifier renders the same values. */
export interface SettleTiming {
  /** Between one read's start and the next. */
  readonly intervalMs: number;
  /** How long the files must hold, from the read that returned them, before they are graded. */
  readonly windowMs: number;
  /** After the first read begins: no read starts then, one in flight is cut, and the last completed read is graded. */
  readonly boundMs: number;
}

/**
 * Grading waits for the app's own save: Gnote saves a note 4 s after the
 * last key, so a read right after the agent stops sees the text unsaved. A
 * save that lands more than the window after the first read is still
 * missed, and an app whose files never change pays the window.
 */
export const SETTLE_TIMING: SettleTiming = {
  intervalMs: 500,
  windowMs: 3_000,
  boundMs: 15_000,
};

/** Where a data/get file part names its path in the home. */
const DATA_OBJECTS = "urn:agentenv:data-objects/v1";

const textField = (value: unknown, key: string): string | undefined => {
  const field =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  return typeof field === "string" ? field : undefined;
};

/**
 * The files an app's data/get answer holds, each by its home path, or its
 * place among the parts, with the SHA-256 of its bytes as sent: what
 * changes when the app saves, compared between reads.
 */
export const appFileDigests = (parts: readonly unknown[]): string =>
  JSON.stringify(
    parts
      .flatMap((part, index) => {
        if (textField(part, "kind") !== "file") return [];
        const { file, metadata } = part as {
          readonly file?: unknown;
          readonly metadata?: Record<string, unknown> | null;
        };
        const content = textField(file, "bytes") ?? textField(file, "uri");
        return [
          [
            textField(metadata?.[DATA_OBJECTS], "path") ?? `#${String(index)}`,
            createHash("sha256")
              .update(content ?? "")
              .digest("hex"),
          ],
        ];
      })
      .sort(([left = ""], [right = ""]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
  );
