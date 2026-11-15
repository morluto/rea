import type { CDPSession } from "playwright-core";
import { z } from "zod";

import {
  observeCdpFrameUrl,
  type CdpFrameUrlObservation,
} from "../CdpCaptureDocuments.js";
import { recordValue } from "../CdpCaptureValues.js";
import {
  cdpFrameEventPayloadFacts,
  type CdpFrameEventKind,
  type CdpFrameFacts,
} from "../CdpFrameIdentity.js";

// Playwright ships the generated protocol event table only through the
// generic `CDPSession.on` overload, which precedes its `'close'` and
// `'event'` session overloads.
type ProtocolEventOverload<On> = On extends {
  (event: infer Event, listener: never): unknown;
  (event: "close", listener: never): unknown;
  (event: "event", listener: never): unknown;
}
  ? Event
  : never;

/** Every event name in the protocol version Playwright ships. */
export type CdpProtocolEvent = Exclude<
  ProtocolEventOverload<CDPSession["on"]>,
  symbol
>;

/**
 * One frame lifecycle event, parsed once at the connection. It has the same
 * shape as a frame-tree node: identity facts plus the frame URL observation.
 * Malformed identity stays in `facts` as explicit issues, never as absence.
 */
export interface CdpFrameEvent {
  readonly facts: CdpFrameFacts;
  /** `missing` for attach and detach events, which carry no URL. */
  readonly url: CdpFrameUrlObservation;
}

const frameEvent = (kind: CdpFrameEventKind) =>
  z.unknown().transform((params): CdpFrameEvent => {
    const record = recordValue(params);
    const urlSource =
      kind === "navigated"
        ? recordValue(record?.frame)
        : kind === "within_document" || kind === "requested"
          ? record
          : undefined;
    return {
      facts: cdpFrameEventPayloadFacts(kind, params),
      url: observeCdpFrameUrl(urlSource),
    };
  });

/**
 * One payload schema per subscribed event. The connection parses each
 * registered event once, before any subscriber sees it. A schema never
 * rejects: malformed members become explicit facts that each subscriber
 * reports as a protocol failure or a recorded coverage gap.
 */
const CDP_EVENT_PAYLOADS = {
  "Page.frameAttached": frameEvent("attached"),
  "Page.frameDetached": frameEvent("detached"),
  "Page.frameNavigated": frameEvent("navigated"),
  "Page.frameRequestedNavigation": frameEvent("requested"),
  "Page.navigatedWithinDocument": frameEvent("within_document"),
} as const satisfies {
  readonly [E in CdpProtocolEvent]?: z.ZodType<unknown, unknown>;
};

export type CdpEventName = keyof typeof CDP_EVENT_PAYLOADS;

export type CdpEventPayload<E extends CdpEventName> = z.output<
  (typeof CDP_EVENT_PAYLOADS)[E]
>;

/** A registered event with its parsed payload, discriminated by method. */
export type CdpRegisteredEvent = {
  readonly [E in CdpEventName]: {
    readonly method: E;
    readonly payload: CdpEventPayload<E>;
  };
}[CdpEventName];

const isRegistered = (method: string): method is CdpEventName =>
  Object.hasOwn(CDP_EVENT_PAYLOADS, method);

/** Parse one event's payload by its registered schema, or undefined when unregistered. */
export const registeredCdpEvent = (
  method: string,
  params: unknown,
): CdpRegisteredEvent | undefined => {
  if (!isRegistered(method)) return undefined;
  const schema: z.ZodType<unknown, unknown> = CDP_EVENT_PAYLOADS[method];
  return {
    method,
    payload: schema.parse(params),
  } as CdpRegisteredEvent;
};

const FRAME_EVENTS: ReadonlySet<string> = new Set<CdpEventName>([
  "Page.frameAttached",
  "Page.frameDetached",
  "Page.frameNavigated",
  "Page.frameRequestedNavigation",
  "Page.navigatedWithinDocument",
]);

/** The parsed frame lifecycle payload of a registered frame event. */
export const cdpFrameEvent = (event: {
  readonly registered: CdpRegisteredEvent | undefined;
}): CdpFrameEvent | undefined =>
  event.registered !== undefined && FRAME_EVENTS.has(event.registered.method)
    ? event.registered.payload
    : undefined;
