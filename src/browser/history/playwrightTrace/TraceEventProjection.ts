import type { JsonValue } from "../../../domain/jsonValue.js";
import type { TraceEvent } from "../../../domain/playwrightTrace/playwrightTrace.js";
import { CaptureRedaction, captureObject } from "../CaptureRedaction.js";
import { projectRecordedHarEntry } from "../HarCapture.js";

const string = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const object = (value: unknown) => (captureObject(value) ? value : {});

/** Action payload scope is explicit; omitted arguments/results are not alleged secrets. */
const actionFacts = (
  raw: Record<string, unknown>,
  redactor: CaptureRedaction,
) => {
  const facts: Record<string, unknown> = {};
  for (const key of [
    "type",
    "callId",
    "parentId",
    "pageId",
    "startTime",
    "endTime",
    "class",
    "method",
    "title",
  ])
    if (Object.hasOwn(raw, key)) facts[key] = raw[key];
  const params = object(raw.params);
  const selected: Record<string, unknown> = {};
  if (Object.hasOwn(params, "selector")) selected.selector = params.selector;
  if (
    (raw.class === "Frame" || raw.class === "Page") &&
    raw.method === "goto" &&
    typeof params.url === "string"
  )
    selected.url = redactor.text(params.url, "/params/url", {});
  if (Object.keys(selected).length > 0) facts.params = selected;
  if (Object.hasOwn(raw, "error")) {
    const error = object(raw.error);
    facts.error = captureObject(raw.error)
      ? Object.fromEntries(
          ["name", "message"]
            .filter((key) => Object.hasOwn(error, key))
            .map((key) => [key, error[key]]),
        )
      : raw.error;
  }
  return facts;
};

const selectedEvent = (
  raw: Record<string, unknown>,
  redactor: CaptureRedaction,
) => {
  let kind: TraceEvent["kind"];
  let selected: unknown;
  if (raw.type === "before" || raw.type === "after") {
    if (typeof raw.callId !== "string") return undefined;
    kind = raw.type === "before" ? "action-before" : "action-after";
    selected = actionFacts(raw, redactor);
  } else if (raw.type === "console") {
    kind = "console";
    const consoleFacts = Object.fromEntries(
      ["type", "messageType", "text", "time", "pageId"]
        .filter((key) => Object.hasOwn(raw, key))
        .map((key) => [key, raw[key]]),
    );
    const location = object(raw.location);
    if (captureObject(raw.location))
      Object.assign(consoleFacts, {
        location: {
          ...location,
          ...(typeof location.url === "string"
            ? { url: redactor.text(location.url, "/location/url", {}) }
            : {}),
        },
      });
    selected = consoleFacts;
  } else if (raw.type === "resource-snapshot") {
    kind = "network";
    if (!captureObject(raw.snapshot)) return undefined;
    selected = raw.snapshot;
  } else if (raw.type === "screencast-frame") {
    kind = "screenshot";
    selected = Object.fromEntries(
      [
        "type",
        "pageId",
        "file",
        "width",
        "height",
        "timestamp",
        "frameSwapWallTime",
      ]
        .filter((key) => Object.hasOwn(raw, key))
        .map((key) => [key, raw[key]]),
    );
  } else return undefined;
  return { kind, selected };
};

/** Recognize only pinned v10 event meanings; no live browser attribution or clock alignment. */
export const projectTraceEvent = (
  raw: Record<string, unknown>,
  identity: Pick<TraceEvent, "event_id" | "stream_id" | "ordinal" | "source">,
): TraceEvent | undefined => {
  const redactor = new CaptureRedaction([]);
  const selected = selectedEvent(raw, redactor);
  if (selected === undefined) return undefined;
  const { kind } = selected;
  const projected = projectRecordedHarEntry(selected.selected, []);
  const facts = object(projected.reported);
  const params = object(facts.params),
    request = object(facts.request),
    response = object(facts.response);
  const error = object(facts.error);
  const redactions = [...projected.redactions, ...redactor.redactions].map(
    ({ pointer, reason }) => ({ pointer, reason }),
  );
  const references: TraceEvent["resource_references"] = [];
  const reference = (value: unknown, pointer: string) => {
    if (typeof value === "string")
      references.push({
        path: value,
        source_pointer: pointer,
        state: "missing",
        member_id: null,
        matching_members: 0,
      });
  };
  if (kind === "screenshot") reference(facts.file, "/file");
  if (kind === "network") {
    reference(
      object(request.postData)._file,
      "/snapshot/request/postData/_file",
    );
    reference(
      object(response.content)._file,
      "/snapshot/response/content/_file",
    );
  }
  return {
    ...identity,
    kind,
    call_id: string(facts.callId),
    page_id: string(kind === "network" ? facts.pageref : facts.pageId),
    time: number(
      kind === "network"
        ? facts._monotonicTime
        : kind === "screenshot"
          ? facts.timestamp
          : kind === "action-before"
            ? facts.startTime
            : kind === "action-after"
              ? facts.endTime
              : facts.time,
    ),
    method: string(kind === "network" ? request.method : facts.method),
    url: string(kind === "network" ? request.url : params.url),
    status: number(response.status),
    text: string(
      kind === "console"
        ? facts.text
        : kind === "action-after"
          ? error.message
          : facts.title,
    ),
    selector: string(params.selector),
    resource_references: references,
    credential_redacted: redactions.some(
      (row) => row.reason === "transport-credential",
    ),
    reported: projected.reported as JsonValue,
    numeric_literals: projected.numeric_literals.map(
      ({ pointer, literal }) => ({ pointer, literal }),
    ),
    redactions,
  };
};
