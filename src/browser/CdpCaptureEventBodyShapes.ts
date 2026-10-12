import { inferJsonShape, type JsonShape } from "../domain/jsonShape.js";
import {
  recordValue,
  cdpStringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import { decodeBase64, isJsonContentType } from "./CdpCaptureEventHelpers.js";
import type { CdpCaptureEventsState } from "./CdpCaptureEventState.js";
import type { NetworkState } from "./CdpCaptureEventTypes.js";

export const ingestResponseBodyShape = (
  state: CdpCaptureEventsState,
  requestId: string,
  value: unknown,
): void => {
  const result = recordValue(value);
  const body = cdpStringValue(result?.body);
  const base64Encoded = result?.base64Encoded;
  if (body === undefined || typeof base64Encoded !== "boolean") {
    invalidResponseBodyShape(state, requestId);
    return;
  }
  const decoded = base64Encoded ? decodeBase64(body)?.toString("utf8") : body;
  if (decoded === undefined) {
    invalidResponseBodyShape(state, requestId);
    return;
  }
  const shape = inferJsonShape(decoded);
  if (shape === null) state.completeness.unavailable("json_body_shapes");
  updateResponseBodyShape(state, requestId, shape);
};

export const requestBodyShape = (
  state: CdpCaptureEventsState,
  request: UnknownRecord,
): NetworkState["body_shapes"] => {
  if (!state.input.include_json_body_shapes)
    return { status: "not_approved", request: null, response: null };
  const body = cdpStringValue(request.postData);
  if (!isJsonContentType(recordValue(request.headers)) || body === undefined)
    return { status: "unavailable", request: null, response: null };
  const shape = inferJsonShape(body);
  if (shape === null) state.completeness.unavailable("json_body_shapes");
  return {
    status: shape === null ? "unavailable" : "included",
    request: shape,
    response: null,
  };
};

export const updateResponseBodyShape = (
  state: CdpCaptureEventsState,
  requestId: string,
  response: JsonShape | null,
): void => {
  const current = state.network.get(requestId);
  if (current === undefined) return;
  const request = current.body_shapes.request;
  const status =
    response !== null
      ? "included"
      : request !== null
        ? "partial"
        : "unavailable";
  state.network.set(requestId, {
    ...current,
    body_shapes: { status, request, response },
  });
};

const invalidResponseBodyShape = (
  state: CdpCaptureEventsState,
  requestId: string,
): void => {
  updateResponseBodyShape(state, requestId, null);
  state.completeness.exclude("json_body_shapes", "invalid_protocol_value");
};
