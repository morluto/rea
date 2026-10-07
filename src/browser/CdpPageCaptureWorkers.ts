import type { WebPageInspection } from "../domain/browserObservation.js";
import type { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import {
  allowedSanitizedUrl,
  isHttpUrl,
  recordValue,
  recordsValue,
  cdpStringValue,
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
): Promise<WebPageInspection["workers"]> => {
  const { context, allowedOrigins, limitations, events } = input;
  const completeness = events.completeness;
  const result = await optionalCdpCommand(
    { ...context, sessionId: undefined },
    "Target.getTargets",
    {},
    limitations,
  );
  const items: WebPageInspection["workers"] = [];
  if (result === undefined) completeness.unavailable("workers");
  for (const target of recordsValue(recordValue(result)?.targetInfos)) {
    const type = cdpStringValue(target.type) ?? "";
    const url = allowedSanitizedUrl(target.url, allowedOrigins);
    const relatedToPage =
      cdpStringValue(target.openerId) === context.target.id ||
      (cdpStringValue(target.parentFrameId) !== undefined &&
        frameIds.has(cdpStringValue(target.parentFrameId) ?? ""));
    if (!type.includes("worker")) continue;
    if (!relatedToPage) {
      completeness.exclude("workers", "out_of_target_scope");
      continue;
    }
    if (url === undefined) {
      const rawUrl = cdpStringValue(target.url);
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
    items.push({
      target_id: cdpStringValue(target.targetId) ?? "",
      type,
      url: url.url,
      origin: url.origin,
      attached: target.attached === true,
      opener_target_id: cdpStringValue(target.openerId) ?? null,
      parent_frame_id: cdpStringValue(target.parentFrameId) ?? null,
    });
  }
  return items;
};
