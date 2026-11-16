import { setTimeout as delay } from "node:timers/promises";

import { isOneColourPng } from "../domain/pngVisualDiff.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { Deadline } from "../domain/deadline.js";

/** How often REA retakes a first screenshot the desktop has not drawn on. */
const DRAWN_POLL_MS = 500;
/** The time those retries share unless a test shortens it. */
export const DRAWN_WAIT_MS = 10_000;

/** A driver's screenshot answer, as far as the wait reads it. */
interface Screenshot {
  readonly isError: boolean;
  readonly content: readonly Readonly<Record<string, JsonValue>>[];
}

/** Whether a screenshot's PNG is one colour throughout, as a display is before the desktop draws. */
const undrawn = (shot: Screenshot): boolean => {
  const image = shot.content.find(
    (block) => block.type === "image" && block.mimeType === "image/png",
  );
  return typeof image?.data === "string" && isOneColourPng(image.data) === true;
};

/**
 * A whole-screen PNG screenshot once the desktop has drawn: readiness can
 * pass while the display is still one colour, so REA takes another every
 * 500 ms while it is. Retries share `waitMs` (10 s), each given only what is left of
 * it; when that runs out, the latest frame is returned.
 */
export const drawnScreenshot = async <Shot extends Screenshot>(
  take: (signal: AbortSignal) => Promise<Shot>,
  signal: AbortSignal,
  waitMs: number = DRAWN_WAIT_MS,
): Promise<Shot> => {
  const deadline = Deadline.after(waitMs);
  let shot = await take(signal);
  while (!shot.isError && undrawn(shot)) {
    const left = deadline.remainingMs();
    if (left <= 0) break;
    await delay(Math.min(DRAWN_POLL_MS, left), undefined, { signal });
    const retry = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, deadline.remainingMs())),
    ]);
    try {
      shot = await take(retry);
    } catch (cause: unknown) {
      if (signal.aborted || !retry.aborted) throw cause;
      break;
    }
  }
  return shot;
};
