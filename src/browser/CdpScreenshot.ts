import type { ProgressReporter } from "../ports/ProgressReporter.js";
import type {
  CaptureWebScreenshotInput,
  WebScreenshot,
} from "../domain/webScreenshot.js";
import {
  createWebScreenshotArtifact,
  decodeCanonicalBase64,
} from "../domain/webScreenshot.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { cdpOriginScopeRefusal } from "./CdpOriginScopeError.js";
import type { CdpFrameTree } from "./protocol/CdpFrameTree.js";
import {
  cdpRootDocument,
  unverifiedDocumentLimitation,
} from "./CdpTargetSession.js";
import {
  CdpTargetDocument,
  type CdpRootNavigation,
} from "./CdpTargetDocument.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import type { CdpConnection } from "./CdpConnection.js";
import { classifyCdpFrameUrl } from "./CdpCaptureDocuments.js";

import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { readPngHeaderDimensions } from "../domain/pngHeader.js";

interface ScreenshotContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: CaptureWebScreenshotInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

const screenshotOperation = "capture_web_screenshot";

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
  const beforeObservation = before.root.url;
  const beforeFacts = classifyCdpFrameUrl(beforeObservation, origins);
  if (
    beforeFacts.scope === "outside_policy" ||
    beforeFacts.scope === "unsupported"
  )
    throw cdpOriginScopeRefusal(screenshotOperation);
  if (beforeObservation.kind !== "observed")
    throw new BrowserObservationError(screenshotOperation, "protocol_error");
  const beforeUrl = beforeFacts.url;
  const selected = cdpRootDocument(before);
  if (
    beforeUrl === undefined ||
    beforeFacts.origin === null ||
    selected === undefined
  )
    throw new BrowserObservationError(screenshotOperation, "protocol_error");
  const navigation: ScreenshotNavigation = {
    document: CdpTargetDocument.watch(context, selected),
    urlChanged: false,
    leftScope: false,
    invalidIdentity: false,
    completeness: new CdpCaptureCompleteness(),
  };
  navigation.document.onNavigation((root) =>
    observeScreenshotNavigation(root, origins, navigation),
  );
  // A changed document comes first; scope applies to an unchanged one. The
  // visible URL moving within the document still invalidates the image.
  const assertCurrentDocument = () => {
    if (navigation.document.changed)
      throw new BrowserObservationError(screenshotOperation, "target_changed");
    if (navigation.leftScope) throw cdpOriginScopeRefusal(screenshotOperation);
    if (navigation.invalidIdentity)
      throw new BrowserObservationError(screenshotOperation, "protocol_error");
    if (navigation.urlChanged)
      throw new BrowserObservationError(screenshotOperation, "target_changed");
  };
  let screenshot: Awaited<ReturnType<typeof captureScreenshotImage>>;
  let after: CdpFrameTree;
  try {
    const viewport = await readScreenshotViewport(context);
    assertCurrentDocument();
    screenshot = await captureScreenshotImage(context);
    assertCurrentDocument();
    const currentViewport = await readScreenshotViewport(context);
    assertCurrentDocument();
    assertSameViewport(viewport, currentViewport);
    if (!coversViewport(screenshot, currentViewport)) {
      // Refresh geometry before clipping, and reject a moving viewport rather
      // than capture a region that is no longer visible.
      screenshot = await captureScreenshotImage(context, currentViewport.clip);
      assertCurrentDocument();
      const recoveredViewport = await readScreenshotViewport(context);
      assertCurrentDocument();
      assertSameViewport(currentViewport, recoveredViewport);
      if (!coversViewport(screenshot, recoveredViewport))
        throw new BrowserObservationError(
          screenshotOperation,
          "protocol_error",
          {
            detail:
              "The screenshot does not cover the reported visual viewport.",
          },
        );
    }
    after = await context.connection.send(
      "Page.getFrameTree",
      {},
      context.sessionId,
      context.signal,
    );
  } catch (cause: unknown) {
    // A navigation can fail an in-flight screenshot or metrics read. Report
    // the proven document change first, keeping the command failure as its
    // cause, while preserving caller cancellation.
    if (
      navigation.document.changed &&
      context.signal?.aborted !== true &&
      !(cause instanceof AnalysisCancelledError) &&
      !(cause instanceof AnalysisError && cause.userCategory === "cancelled")
    )
      throw new BrowserObservationError(screenshotOperation, "target_changed", {
        cause,
      });
    throw cause;
  } finally {
    navigation.document.close();
  }
  assertCurrentDocument();
  const final = cdpRootDocument(after);
  if (final === undefined)
    throw new BrowserObservationError(screenshotOperation, "protocol_error");
  const comparison = navigation.document.observeTree(after);
  if (comparison === "changed")
    throw new BrowserObservationError(screenshotOperation, "target_changed");
  const afterObservation = after.root.url;
  const afterFacts = classifyCdpFrameUrl(afterObservation, origins);
  if (
    afterFacts.scope === "outside_policy" ||
    afterFacts.scope === "unsupported"
  )
    throw cdpOriginScopeRefusal(screenshotOperation);
  if (afterObservation.kind !== "observed")
    throw new BrowserObservationError(screenshotOperation, "protocol_error");
  if (afterFacts.url === undefined || final.url !== selected.url)
    throw new BrowserObservationError(screenshotOperation, "target_changed");
  const unverified = navigation.document.unknown || comparison === "unknown";
  if (unverified) navigation.completeness.attachLimited("screenshot");
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
      url: beforeUrl,
      origin: beforeFacts.origin,
    },
    captured_at: new Date().toISOString(),
    viewport: screenshot.dimensions,
    artifact: createWebScreenshotArtifact(screenshot.bytes),
    completeness: navigation.completeness.snapshot(),
    limitations: [
      ...(unverified ? [unverifiedDocumentLimitation(selected)] : []),
      "The screenshot contains the visible viewport, including on-screen content.",
      "REA does not scroll, evaluate JavaScript, or capture beyond the current viewport.",
    ],
  };
};

/** Parse CSS clip geometry and device-pixel coverage at their owning boundary. */
const readScreenshotViewport = async (context: ScreenshotContext) => {
  const { visualViewport, cssVisualViewport } = await context.connection.send(
    "Page.getLayoutMetrics",
    {},
    context.sessionId,
    context.signal,
  );
  const {
    pageX,
    pageY,
    clientWidth: width,
    clientHeight: height,
    scale,
  } = cssVisualViewport;
  const { clientWidth: pixelWidth, clientHeight: pixelHeight } = visualViewport;
  // Both viewports describe one page zoom; disagreement is incoherent geometry.
  if (visualViewport.scale !== scale)
    throw new BrowserObservationError(screenshotOperation, "protocol_error");
  // Keep ordinary surface captures, including their scrollbars and pixel
  // density. The visual viewport excludes scrollbars and supplies only a
  // lower bound on the expected image size, allowing subpixel rounding.
  const minimumWidth = Math.max(1, Math.floor(pixelWidth * scale));
  const minimumHeight = Math.max(1, Math.floor(pixelHeight * scale));
  if (
    !Number.isSafeInteger(minimumWidth) ||
    !Number.isSafeInteger(minimumHeight)
  )
    throw new BrowserObservationError(screenshotOperation, "protocol_error");
  return {
    clip: { x: pageX, y: pageY, width, height, scale },
    pixelWidth,
    pixelHeight,
    minimumWidth,
    minimumHeight,
  };
};

type ScreenshotViewport = Awaited<ReturnType<typeof readScreenshotViewport>>;

const coversViewport = (
  image: Awaited<ReturnType<typeof captureScreenshotImage>>,
  viewport: ScreenshotViewport,
) =>
  image.dimensions.width >= viewport.minimumWidth &&
  image.dimensions.height >= viewport.minimumHeight;

const assertSameViewport = (
  before: ScreenshotViewport,
  after: ScreenshotViewport,
): void => {
  if (
    before.clip.x !== after.clip.x ||
    before.clip.y !== after.clip.y ||
    before.clip.width !== after.clip.width ||
    before.clip.height !== after.clip.height ||
    before.clip.scale !== after.clip.scale ||
    before.pixelWidth !== after.pixelWidth ||
    before.pixelHeight !== after.pixelHeight
  )
    throw new BrowserObservationError(screenshotOperation, "target_changed", {
      detail: "The visual viewport changed during screenshot capture.",
    });
};

interface ScreenshotClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/** Decode every capture at the same boundary, including a clipped recovery. */
const captureScreenshotImage = async (
  context: ScreenshotContext,
  clip?: ScreenshotClip,
) => {
  const { data } = await context.connection.send(
    "Page.captureScreenshot",
    {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: clip !== undefined,
      ...(clip === undefined ? {} : { clip }),
    },
    context.sessionId,
    context.signal,
  );
  const screenshot = decodeScreenshot(data);
  if (screenshot === undefined)
    throw new BrowserObservationError(screenshotOperation, "protocol_error");
  return screenshot;
};

const decodeScreenshot = (
  encoded: string,
):
  | {
      readonly bytes: Buffer;
      readonly dimensions: { width: number; height: number };
    }
  | undefined => {
  const bytes = decodeCanonicalBase64(encoded);
  if (bytes === undefined) return undefined;
  const dimensions = readPngHeaderDimensions(bytes);
  return dimensions === undefined ? undefined : { bytes, dimensions };
};

interface ScreenshotNavigation {
  readonly document: CdpTargetDocument;
  urlChanged: boolean;
  leftScope: boolean;
  invalidIdentity: boolean;
  readonly completeness: CdpCaptureCompleteness;
}

/**
 * Any committed root navigation away from the selected document or URL
 * invalidates the image. The target session's document owner has already
 * classified the event and compared the document.
 */
const observeScreenshotNavigation = (
  navigation: CdpRootNavigation,
  origins: ReadonlySet<string>,
  state: ScreenshotNavigation,
): void => {
  if (navigation.kind === "unreadable_child") {
    state.completeness.exclude("screenshot", "invalid_protocol_value");
    return;
  }
  if (navigation.kind === "unidentified") {
    state.completeness.exclude("screenshot", "invalid_protocol_value");
    state.invalidIdentity = true;
    return;
  }
  if (navigation.comparison === "same") return;
  state.urlChanged = true;
  const observed = navigation.frame.url;
  const facts = classifyCdpFrameUrl(observed, origins);
  if (facts.scope === "outside_policy" || facts.scope === "unsupported")
    state.leftScope = true;
  if (observed.kind !== "observed") state.invalidIdentity = true;
};
