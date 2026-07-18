import type { WebPageInspection } from "../domain/browserObservation.js";
import type { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import {
  allowedSanitizedUrl,
  boundedText,
  isHttpUrl,
  recordValue,
  recordsValue,
  stringValue,
} from "./CdpCaptureValues.js";
import type { CaptureContext } from "./CdpPageCapture.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";

interface CaptureWorkersInput {
  readonly context: CaptureContext;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly limitations: string[];
  readonly events: CdpCaptureEvents;
}

export const captureWorkers = async (
  input: CaptureWorkersInput,
  frameIds: ReadonlySet<string>,
): Promise<{
  readonly total: number;
  readonly items: WebPageInspection["workers"];
}> => {
  const { context, allowedOrigins, limitations, events } = input;
  const completeness = events.completeness;
  const result = await optionalCdpCommand(
    { ...context, sessionId: undefined },
    "Target.getTargets",
    {},
    limitations,
  );
  const items: WebPageInspection["workers"] = [];
  let total = 0;
  if (result === undefined) completeness.unavailable("workers");
  for (const target of recordsValue(recordValue(result)?.targetInfos)) {
    const type = stringValue(target.type) ?? "";
    const url = allowedSanitizedUrl(target.url, allowedOrigins);
    const relatedToPage =
      stringValue(target.openerId) === context.target.id ||
      (stringValue(target.parentFrameId) !== undefined &&
        frameIds.has(stringValue(target.parentFrameId) ?? ""));
    if (!type.includes("worker")) continue;
    if (!relatedToPage) {
      completeness.exclude("workers", "out_of_target_scope");
      continue;
    }
    if (url === undefined) {
      const rawUrl = stringValue(target.url);
      completeness.exclude(
        "workers",
        rawUrl === undefined || rawUrl === ""
          ? "unattributed_origin"
          : isHttpUrl(rawUrl)
            ? "disallowed_origin"
            : "unsupported_url",
      );
      continue;
    }
    total += 1;
    if (items.length >= context.input.limits.max_workers) continue;
    items.push({
      target_id: (stringValue(target.targetId) ?? "").slice(0, 256),
      type: type.slice(0, 100),
      url: url.url,
      origin: url.origin,
      attached: target.attached === true,
      opener_target_id: boundedText(target.openerId, 256) ?? null,
      parent_frame_id: boundedText(target.parentFrameId, 256) ?? null,
    });
  }
  return { total, items };
};
