import type { ProgressReporter } from "../application/ProgressReporter.js";
import type {
  CaptureWebScreenshotInput,
  WebScreenshot,
} from "../domain/webScreenshot.js";
import { createWebScreenshotArtifact } from "../domain/webScreenshot.js";
import { BrowserObservationError } from "../domain/errors.js";
import { isMainFrameNavigation } from "./CdpCaptureEventHelpers.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import type { CdpConnection, CdpEvent } from "./CdpConnection.js";
import {
  allowedSanitizedUrl,
  recordValue,
  stringValue,
} from "./CdpCaptureValues.js";
import { mainFrameUrl } from "./CdpCaptureDocuments.js";
import { captureFrames } from "./CdpCaptureDocuments.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { decodeCanonicalBase64 } from "../domain/webScreenshot.js";

interface ScreenshotContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: CaptureWebScreenshotInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

/** Capture the current viewport without navigation, evaluation, or page mutation. */
export const captureCdpScreenshot = async (
  context: ScreenshotContext,
): Promise<WebScreenshot> => {
  const origins = new Set(context.input.allowed_origins);
  await context.progress?.report({
    phase: "browser_observation",
    completed: 1,
    total: 2,
    message: "Authorizing current screenshot frame",
  });
  await context.connection.send(
    "Page.enable",
    {},
    context.sessionId,
    context.signal,
  );
  const before = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  const beforeUrl = mainFrameUrl(before);
  const authorized = allowedSanitizedUrl(beforeUrl, origins);
  const mainFrame = captureFrames(before, origins, 1).items[0];
  if (authorized === undefined || mainFrame === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  const navigation = { changed: false, leftScope: false };
  const removeListener = context.connection.onEvent((event) => {
    if (event.sessionId !== context.sessionId) return;
    observeScreenshotNavigation(event, mainFrame.frame_id, origins, navigation);
  });
  let result: ReturnType<typeof recordValue>;
  let after: unknown;
  try {
    result = recordValue(
      await context.connection.send(
        "Page.captureScreenshot",
        { format: "png", fromSurface: true, captureBeyondViewport: false },
        context.sessionId,
        context.signal,
      ),
    );
    after = await context.connection.send(
      "Page.getFrameTree",
      {},
      context.sessionId,
      context.signal,
    );
  } finally {
    removeListener();
  }
  const encoded = stringValue(result?.data);
  const bytes =
    encoded === undefined ? undefined : decodeCanonicalBase64(encoded);
  if (bytes === undefined)
    throw new BrowserObservationError("inspect_web_page", "payload_limit");
  const dimensions = pngDimensions(bytes);
  if (navigation.leftScope)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  const afterUrl = mainFrameUrl(after);
  if (
    navigation.changed ||
    afterUrl !== beforeUrl ||
    allowedSanitizedUrl(afterUrl, origins) === undefined
  )
    throw new BrowserObservationError("inspect_web_page", "target_changed");
  await context.progress?.report({
    phase: "browser_observation",
    completed: 2,
    total: 2,
    message: "Screenshot capture complete",
    terminal: true,
  });
  return {
    browser: context.discovery.version,
    target: {
      target_id: context.target.id,
      url: authorized.url,
      origin: authorized.origin ?? "",
    },
    captured_at: new Date().toISOString(),
    viewport: dimensions,
    artifact: createWebScreenshotArtifact(bytes),
    completeness: new CdpCaptureCompleteness().snapshot(),
    limitations: [
      "The screenshot contains the visible viewport, including on-screen content.",
      "REA does not scroll, evaluate JavaScript, or capture beyond the current viewport.",
    ],
  };
};

const observeScreenshotNavigation = (
  event: CdpEvent,
  mainFrameId: string,
  origins: ReadonlySet<string>,
  state: { changed: boolean; leftScope: boolean },
): void => {
  if (!isMainFrameNavigation(event, mainFrameId)) return;
  const params = recordValue(event.params);
  if (params === undefined) return;
  const frame =
    event.method === "Page.frameNavigated" ? recordValue(params.frame) : params;
  state.changed = true;
  if (allowedSanitizedUrl(frame?.url, origins) === undefined)
    state.leftScope = true;
};

const pngDimensions = (
  bytes: Buffer,
): { readonly width: number; readonly height: number } => {
  if (
    bytes.byteLength < 24 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  )
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  return { width, height };
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
