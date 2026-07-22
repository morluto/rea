import type { ProcessCapture } from "./processCapture.js";
import type { ProcessTraceSource } from "./processTraceSpecification.js";

export type ProcessComparisonDimension =
  | "terminal"
  | "interaction"
  | "exit"
  | "filesystem"
  | "protocol"
  | "process"
  | "shim";

/** Map declared trace sources to legacy process-comparison dimensions. */
export const dimensionsForTraceSources = (
  sources: ReadonlySet<ProcessTraceSource>,
): ReadonlySet<ProcessComparisonDimension> => {
  const dimensions = new Set<ProcessComparisonDimension>();
  for (const source of sources) {
    if (source.startsWith("terminal_")) dimensions.add("terminal");
    else if (source === "interaction") dimensions.add("interaction");
    else if (source === "lifecycle") dimensions.add("exit");
    else if (source === "filesystem") dimensions.add("filesystem");
    else if (
      source === "http" ||
      source === "websocket" ||
      source === "replay_transition"
    )
      dimensions.add("protocol");
    else if (source === "process") dimensions.add("process");
    else if (source === "shim") dimensions.add("shim");
  }
  return dimensions;
};

/** Whether a trace specification covers every observed source in a dimension. */
export const traceCoversObservedDimension = (
  dimension: ProcessComparisonDimension,
  sources: ReadonlySet<ProcessTraceSource>,
  left: ProcessCapture,
  right: ProcessCapture,
): boolean => {
  const any = <Value>(
    leftValues: readonly Value[],
    rightValues: readonly Value[],
  ): boolean => leftValues.length > 0 || rightValues.length > 0;
  switch (dimension) {
    case "terminal":
      return (
        (!any(left.frames, right.frames) || sources.has("terminal_raw")) &&
        (!any(left.rendered_frames, right.rendered_frames) ||
          sources.has("terminal_rendered"))
      );
    case "interaction":
      return sources.has("interaction");
    case "exit":
      return sources.has("lifecycle");
    case "filesystem":
      return false;
    case "protocol":
      return (
        (![...left.protocol_events, ...right.protocol_events].some(
          ({ protocol }) => protocol === "http",
        ) ||
          sources.has("http")) &&
        (![...left.protocol_events, ...right.protocol_events].some(
          ({ protocol }) => protocol === "websocket",
        ) ||
          sources.has("websocket")) &&
        (!any(left.replay_transitions, right.replay_transitions) ||
          sources.has("replay_transition"))
      );
    case "process":
      return sources.has("process");
    case "shim":
      return sources.has("shim");
  }
};
