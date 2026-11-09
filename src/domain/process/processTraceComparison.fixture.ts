import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "./processCaptureExample.js";
import { hasCaptureTruncation } from "./processCaptureCoverage.js";
import { accountFullyObservedProcessCapture } from "./processCapture.fixture.js";
import {
  parseProcessCapture,
  type ProcessCapture,
} from "./processCaptureParsing.js";
import type { ProcessTraceSpecification } from "./processTraceSpecification.js";

export const emptyCapture = parseProcessCapture(EMPTY_PROCESS_CAPTURE_EXAMPLE);
export const terminal = { sequence: 0, at_ms: 900, data: "Ready" };
export const processStarted = {
  at_ms: 1,
  pid: 1,
  parent_pid: 0,
  command: "worker",
  process_group_id: 1,
  session_id: 1,
};

export const capture = (
  values: Pick<ProcessCapture, "frames" | "process_samples"> & {
    readonly rendered_frames?: ProcessCapture["rendered_frames"];
    readonly event_journal: readonly Pick<
      NonNullable<ProcessCapture["event_journal"]>[number],
      "collection" | "index"
    >[];
  },
  options: {
    readonly omittedTerminalFrame?: boolean;
    readonly residualUnknowns?: ProcessCapture["residual_unknowns"];
  } = {},
): ProcessCapture => {
  const observed = accountFullyObservedProcessCapture({
    ...emptyCapture,
    frames: values.frames,
    rendered_frames: values.rendered_frames ?? [],
    process_samples: values.process_samples,
    event_journal: [
      { capture_order: 0, collection: "filesystem_checkpoints", index: 0 },
      ...values.event_journal.map((entry, index) => ({
        ...entry,
        capture_order: index + 1,
      })),
      {
        capture_order: values.event_journal.length + 1,
        collection: "lifecycle",
        index: 0,
      },
      {
        capture_order: values.event_journal.length + 2,
        collection: "lifecycle",
        index: 1,
      },
      {
        capture_order: values.event_journal.length + 3,
        collection: "filesystem_checkpoints",
        index: 1,
      },
    ],
    residual_unknowns: options.residualUnknowns ?? [],
  });
  if (!options.omittedTerminalFrame) return parseProcessCapture(observed);

  const raw = observed.truncation_details.raw_terminal;
  const truncationDetails = {
    ...observed.truncation_details,
    raw_terminal: {
      ...raw,
      observed_bytes: raw.observed_bytes + 1,
      observed_frames: raw.observed_frames + 1,
    },
  };
  return parseProcessCapture({
    ...observed,
    truncated: hasCaptureTruncation(truncationDetails),
    truncation_details: truncationDetails,
  });
};

export const values = (
  order: readonly ("terminal" | "process")[],
): Parameters<typeof capture>[0] => ({
  frames: [terminal],
  process_samples: [processStarted],
  event_journal: order.map((event) => ({
    collection: event === "terminal" ? "frames" : "process_samples",
    index: 0,
  })),
});

export const partialSpecification = (): ProcessTraceSpecification => ({
  events: [
    {
      id: "ready",
      source: "terminal_raw",
      exact: terminal,
      cardinality: { kind: "required" },
    },
    {
      id: "worker",
      source: "process",
      exact: processStarted,
      cardinality: { kind: "required" },
    },
  ],
  language: {
    kind: "partial_order",
    happens_before: [{ before: "ready", after: "worker" }],
    not_before: [],
    unordered_groups: [],
    prefix: ["ready"],
    suffix: ["worker"],
  },
});
