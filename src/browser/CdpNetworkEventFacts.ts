import { z } from "zod";
import {
  cdpStringValue,
  numberValue,
  recordValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";

const integer = z.int().min(0);
/** Active runtime admission remains stricter than passive request observations. */
export const runtimeRequestSchema = z.object({
  requestId: z.string().min(1),
  frameId: z.string().optional(),
  timestamp: z.number().min(0),
  request: z.object({ url: z.string(), method: z.string() }),
  initiator: z
    .object({
      type: z.string(),
      stack: z.unknown().optional(),
      url: z.string().optional(),
      lineNumber: integer.optional(),
      columnNumber: integer.optional(),
    })
    .passthrough(),
});

/** A CDP Response occurs in both responseReceived and redirect continuation events. */
export interface CdpResponseFacts {
  readonly source: UnknownRecord;
  readonly url: string | undefined;
  readonly status: number | undefined;
  readonly mimeType: string | undefined;
  readonly encodedDataLength: number | undefined;
  readonly headers: unknown;
}
export const readCdpResponseFacts = (
  reported: unknown,
): CdpResponseFacts | undefined => {
  const source = recordValue(reported);
  return source === undefined
    ? undefined
    : {
        source,
        url: cdpStringValue(source.url),
        status: numberValue(source.status),
        mimeType: cdpStringValue(source.mimeType),
        encodedDataLength: numberValue(source.encodedDataLength),
        headers: source.headers,
      };
};

const requestIdentity = (source: UnknownRecord | undefined): string | null => {
  const id = cdpStringValue(source?.requestId);
  return id === undefined || id === "" ? null : id;
};
export interface CdpRequestWillBeSentFacts {
  readonly source: UnknownRecord | undefined;
  readonly requestId: string | null;
  readonly frameId: string | undefined;
  readonly loaderId: string | undefined;
  readonly resourceType: string | undefined;
  readonly timestamp: number | undefined;
  readonly request:
    | {
        readonly source: UnknownRecord;
        readonly url: string | undefined;
        readonly method: string | undefined;
      }
    | undefined;
  readonly initiator:
    | {
        readonly source: UnknownRecord;
        readonly type: string | undefined;
      }
    | undefined;
  readonly redirect:
    | { readonly kind: "missing" }
    | { readonly kind: "malformed" }
    | { readonly kind: "response"; readonly response: CdpResponseFacts };
}

/** Borrow raw declarations while parsing each shared field once, before consumer policy. */
export const readCdpRequestWillBeSent = (
  reported: unknown,
): CdpRequestWillBeSentFacts => {
  const source = recordValue(reported);
  const request = recordValue(source?.request);
  const initiator = recordValue(source?.initiator);
  const response = readCdpResponseFacts(source?.redirectResponse);
  return {
    source,
    requestId: requestIdentity(source),
    frameId: cdpStringValue(source?.frameId),
    loaderId: cdpStringValue(source?.loaderId),
    resourceType: cdpStringValue(source?.type),
    timestamp: numberValue(source?.timestamp),
    request:
      request === undefined
        ? undefined
        : {
            source: request,
            url: cdpStringValue(request.url),
            method: cdpStringValue(request.method),
          },
    initiator:
      initiator === undefined
        ? undefined
        : { source: initiator, type: cdpStringValue(initiator.type) },
    redirect:
      source === undefined || !Object.hasOwn(source, "redirectResponse")
        ? { kind: "missing" }
        : response === undefined
          ? { kind: "malformed" }
          : { kind: "response", response },
  };
};

export const readCdpResponseReceived = (reported: unknown) => {
  const source = recordValue(reported);
  return {
    source,
    requestId: requestIdentity(source),
    response: readCdpResponseFacts(source?.response),
  };
};
export const readCdpLoadingFinished = (reported: unknown) => {
  const source = recordValue(reported);
  return {
    source,
    requestId: requestIdentity(source),
    timestamp: numberValue(source?.timestamp),
    encodedDataLength: numberValue(source?.encodedDataLength),
  };
};
export const readCdpLoadingFailed = (reported: unknown) => {
  const source = recordValue(reported);
  return {
    source,
    requestId: requestIdentity(source),
    timestamp: numberValue(source?.timestamp),
    errorText: source?.errorText,
  };
};
