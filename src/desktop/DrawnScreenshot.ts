import { setTimeout as delay } from "node:timers/promises";

import { isOneColourPng } from "../browser/PngVisualDiff.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** How often REA retakes a first screenshot the desktop has not drawn on, and the time the retries share. */
const DRAWN_POLL_MS = 500;
const DRAWN_WAIT_MS = 10_000;

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
 * 500 ms while it is. Retries share 10 s, each given only what is left of
 * it; when that runs out, the latest frame is returned.
 */
export const drawnScreenshot = async <Shot extends Screenshot>(
  take: (signal: AbortSignal) => Promise<Shot>,
  signal: AbortSignal,
): Promise<Shot> => {
  const deadline = Date.now() + DRAWN_WAIT_MS;
  let shot = await take(signal);
  while (!shot.isError && undrawn(shot)) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await delay(Math.min(DRAWN_POLL_MS, left), undefined, { signal });
    const retry = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
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
