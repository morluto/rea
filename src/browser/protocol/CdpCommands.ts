import type { CDPSession } from "playwright-core";
import { z } from "zod";

import { BrowserObservationError } from "../../domain/browserObservationError.js";
import { cdpResourceColumnSchema } from "../../domain/cdpObservationSchemas.js";
import type { BrowserObservationOperation } from "../../domain/browserObservationErrors.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  cdpFrameTreeReplySchema,
  cdpResourceTreeReplySchema,
} from "./CdpFrameTree.js";

// Playwright ships the generated Chrome DevTools Protocol command table. Its
// names and parameter types are reused; its result types are unchecked casts,
// so REA validates each reply with its own schema below.
declare const protocolSend: CDPSession["send"];

/** Every command name in the protocol version Playwright ships. */
export type CdpProtocolMethod = Parameters<CDPSession["send"]>[0];

/** A command whose reply REA does not read beyond its success. */
const acknowledgement = z.object({});

const coverageOffset = z.int().min(0);
const nodeId = z.int().min(1);
const positive = z.number().positive();

/** CSS clip geometry and device-pixel viewport for one screenshot. */
const layoutMetricsReply = z.object({
  visualViewport: z.object({
    clientWidth: positive,
    clientHeight: positive,
    scale: positive,
  }),
  cssVisualViewport: z.object({
    pageX: z.number(),
    pageY: z.number(),
    clientWidth: positive,
    clientHeight: positive,
    scale: positive,
  }),
});

/** Native listener descriptors; live remote handles are not read. */
const eventListenersReply = z.object({
  listeners: z.array(
    z.object({
      type: z.string(),
      useCapture: z.boolean(),
      passive: z.boolean(),
      once: z.boolean(),
      scriptId: z.string(),
      lineNumber: z.int().min(0),
      columnNumber: cdpResourceColumnSchema,
    }),
  ),
});

/** Precise coverage keeps every nested producer range; counts are not flattened. */
const preciseCoverageReply = z.object({
  timestamp: z.number().min(0),
  result: z.array(
    z.object({
      scriptId: z.string().min(1),
      url: z.string(),
      functions: z.array(
        z.object({
          functionName: z.string(),
          isBlockCoverage: z.boolean(),
          ranges: z.array(
            z.object({
              startOffset: coverageOffset,
              endOffset: coverageOffset,
              count: coverageOffset,
            }),
          ),
        }),
      ),
    }),
  ),
});

/**
 * An inventory whose entries the reading section admits one by one, so one
 * malformed entry is counted there as a gap instead of rejecting the reply.
 */
const inventory = z.array(z.unknown());

/**
 * IndexedDB versions are exact non-negative integers. An omitted or other value
 * leaves only the version unknown; the database's stores stay readable.
 */
const indexedDbVersion = z
  .unknown()
  .transform((value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined,
  )
  .optional();

/**
 * One result schema per command REA sends. Each schema is the only reader of
 * that command's raw reply; consumers receive its parsed output.
 */
const CDP_COMMAND_REPLIES = {
  "DOM.describeNode": z.object({
    node: z.object({
      backendNodeId: nodeId,
      nodeName: z.string(),
      nodeType: z.int(),
      // CDP omits isSVG for non-SVG nodes.
      isSVG: z.boolean().optional(),
    }),
  }),
  "DOM.disable": acknowledgement,
  "DOM.enable": acknowledgement,
  "DOM.getDocument": z.object({ root: z.object({ nodeId }) }),
  // Zero is the protocol's "no match".
  "DOM.querySelector": z.object({ nodeId: z.int().min(0) }),
  "DOM.resolveNode": z.object({
    object: z.object({ objectId: z.string().min(1) }),
  }),
  "DOMDebugger.getEventListeners": eventListenersReply,
  "Accessibility.getFullAXTree": z.object({ nodes: inventory }),
  "CacheStorage.requestCacheNames": z.object({ caches: inventory }),
  "CacheStorage.requestCachedResponse": z.object({
    response: z.object({ body: z.string() }),
  }),
  "CacheStorage.requestEntries": z.object({
    cacheDataEntries: inventory,
    returnCount: z.int().min(0),
  }),
  "DOMSnapshot.captureSnapshot": z.object({
    // A snapshot always describes at least one document.
    documents: inventory.min(1),
    strings: inventory,
  }),
  "DOMStorage.getDOMStorageItems": z.object({ entries: inventory }),
  "Debugger.disable": acknowledgement,
  "Debugger.enable": acknowledgement,
  "Debugger.evaluateOnCallFrame": z.object({
    result: z.looseObject({}),
    exceptionDetails: z.unknown().optional(),
  }),
  "Debugger.getScriptSource": z.object({ scriptSource: z.string() }),
  "Debugger.resume": acknowledgement,
  "Debugger.setBreakpointByUrl": z.object({ breakpointId: z.string() }),
  "Emulation.clearDeviceMetricsOverride": acknowledgement,
  "Emulation.setDeviceMetricsOverride": acknowledgement,
  "Emulation.setEmulatedMedia": acknowledgement,
  "Emulation.setFocusEmulationEnabled": acknowledgement,
  "Emulation.setLocaleOverride": acknowledgement,
  "Emulation.setTimezoneOverride": acknowledgement,
  "IndexedDB.requestData": z.object({
    objectStoreDataEntries: inventory,
    hasMore: z.boolean(),
  }),
  "IndexedDB.requestDatabase": z.object({
    databaseWithObjectStores: z.object({
      name: z.string(),
      version: indexedDbVersion,
      objectStores: inventory,
    }),
  }),
  "IndexedDB.requestDatabaseNames": z.object({ databaseNames: inventory }),
  "Network.disable": acknowledgement,
  "Network.enable": acknowledgement,
  "Network.getCookies": z.object({ cookies: inventory }),
  "Network.getResponseBody": z.object({
    body: z.string(),
    base64Encoded: z.boolean(),
  }),
  "Page.addScriptToEvaluateOnNewDocument": z.object({
    identifier: z.string(),
  }),
  "Page.disable": acknowledgement,
  "Page.enable": acknowledgement,
  // `data` is base64 PNG; its canonical decoding stays with the screenshot owner.
  "Page.captureScreenshot": z.object({ data: z.string() }),
  "Page.getFrameTree": cdpFrameTreeReplySchema,
  "Page.getLayoutMetrics": layoutMetricsReply,
  "Page.getResourceTree": cdpResourceTreeReplySchema,
  "Page.removeScriptToEvaluateOnNewDocument": acknowledgement,
  "Page.setLifecycleEventsEnabled": acknowledgement,
  "Page.stopLoading": acknowledgement,
  "Performance.enable": acknowledgement,
  "Performance.getMetrics": z.object({
    metrics: z.array(z.object({ name: z.string(), value: z.number() })),
  }),
  "Profiler.disable": acknowledgement,
  "Profiler.enable": acknowledgement,
  "Profiler.startPreciseCoverage": z.object({ timestamp: z.number().min(0) }),
  "Profiler.stopPreciseCoverage": acknowledgement,
  "Profiler.takePreciseCoverage": preciseCoverageReply,
  "Runtime.disable": acknowledgement,
  "Runtime.enable": acknowledgement,
  "Runtime.releaseObjectGroup": acknowledgement,
  "Runtime.runIfWaitingForDebugger": acknowledgement,
  "Storage.getStorageKey": z.object({ storageKey: z.string() }),
  "Storage.getUsageAndQuota": z.object({
    usage: z.number(),
    quota: z.number(),
  }),
  "Target.attachToTarget": z.object({ sessionId: z.string().min(1) }),
  "Target.detachFromTarget": acknowledgement,
  "Target.getTargetInfo": z.object({
    targetInfo: z.object({ targetId: z.string() }),
  }),
  "Target.setAutoAttach": acknowledgement,
  "WebMCP.disable": acknowledgement,
  "WebMCP.enable": acknowledgement,
} as const satisfies { readonly [M in CdpProtocolMethod]?: z.ZodType };

export type CdpCommand = keyof typeof CDP_COMMAND_REPLIES;

type DomainOf<C, Verb extends string> = C extends `${infer Domain}.${Verb}`
  ? Domain
  : never;

/**
 * A domain whose `${domain}.${verb}` command is registered. Code that builds a
 * command name at run time takes its domain as this type, so an unregistered
 * name fails to compile.
 */
export type CdpDomainWith<Verb extends string> = DomainOf<CdpCommand, Verb>;

export type CdpCommandParams<M extends CdpCommand> = NonNullable<
  Parameters<typeof protocolSend<M>>[1]
>;

export type CdpCommandResult<M extends CdpCommand> = z.output<
  (typeof CDP_COMMAND_REPLIES)[M]
>;

/**
 * Parameters a send accepts: the protocol's for a registered command, an
 * untyped record for a method that has no result schema yet.
 */
export type CdpSendParams<M extends string> = M extends CdpCommand
  ? CdpCommandParams<M>
  : Readonly<Record<string, unknown>>;

/**
 * A registered command resolves to its parsed result. Any other method is the
 * raw reply, which the untyped-command guard baseline counts.
 */
export type CdpSendResult<M extends string> = M extends CdpCommand
  ? CdpCommandResult<M>
  : unknown;

export const isCdpCommand = (method: string): method is CdpCommand =>
  Object.hasOwn(CDP_COMMAND_REPLIES, method);

/** A well-formed JSON-RPC reply whose result does not match the command's schema. */
export interface CdpMalformedReplyFacts {
  readonly command: CdpCommand;
  /** RFC 6901 pointer to the first rejected member of `result`. */
  readonly pointer: string;
  readonly issue: string;
}

/** A command-level protocol failure; the connection itself stays usable. */
export class CdpMalformedReply extends BrowserObservationError {
  readonly command: CdpCommand;
  readonly pointer: string;

  constructor(
    operation: BrowserObservationOperation,
    facts: CdpMalformedReplyFacts,
  ) {
    super(operation, "protocol_error", {
      detail: `CDP ${facts.command} returned a malformed result at ${facts.pointer === "" ? "/" : facts.pointer}: ${facts.issue}`,
    });
    this.command = facts.command;
    this.pointer = facts.pointer;
  }
}

const jsonPointer = (path: readonly PropertyKey[]): string =>
  path
    .map(
      (segment) =>
        `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`,
    )
    .join("");

/** Parse one raw reply with its command's schema. Issue text never quotes producer values. */
export const parseCdpCommandResult = <M extends CdpCommand>(
  command: M,
  value: unknown,
): Result<CdpCommandResult<M>, CdpMalformedReplyFacts> => {
  const schema: z.ZodType = CDP_COMMAND_REPLIES[command];
  const parsed = schema.safeParse(value) as z.ZodSafeParseResult<
    CdpCommandResult<M>
  >;
  if (parsed.success) return ok(parsed.data);
  const issue = parsed.error.issues[0];
  return err({
    command,
    pointer: jsonPointer(issue?.path ?? []),
    issue: issue?.message ?? "The result did not match its protocol schema.",
  });
};

/**
 * Admit one command reply at a transport boundary: `CdpConnection` and the
 * Playwright CDP sessions both call this. A registered command's reply is
 * parsed or rejected; any other reply is returned raw.
 */
export const admitCdpReply = <M extends string>(
  method: M,
  reply: unknown,
  operation: BrowserObservationOperation,
): CdpSendResult<M> => {
  if (!isCdpCommand(method)) return reply as CdpSendResult<M>;
  const parsed = parseCdpCommandResult(method, reply);
  if (!parsed.ok) throw new CdpMalformedReply(operation, parsed.error);
  return parsed.value as CdpSendResult<M>;
};
