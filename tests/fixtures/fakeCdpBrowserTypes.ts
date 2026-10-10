import type { JsonValue } from "../../src/domain/jsonValue.js";
export interface FakeCdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

export interface FakeCdpBrowser {
  readonly endpoint: string;
  readonly browserWebSocketUrl: string;
  readonly allowedOrigin: string;
  readonly commands: readonly FakeCdpCommand[];
  /** Deliver actual malformed wire data without bypassing the production transport parser. */
  emitRawMessage(message: string): void;
  emitEvent(event: {
    readonly method: string;
    readonly params: unknown;
    readonly sessionId?: string;
  }): void;
  readonly httpRequests: readonly {
    readonly url: string;
    readonly authorization: string | undefined;
    readonly cookie: string | undefined;
    readonly referer: string | undefined;
  }[];
  close(): Promise<void>;
}

export interface FakeOptions {
  /** Send these commands' producer events before acknowledging completion, as a wire barrier. */
  readonly eventsBeforeReply?: readonly string[];
  /** Return a native-shaped command rejection through the actual wire parser. */
  readonly commandError?: (
    command: FakeCdpCommand,
  ) => { readonly code: number; readonly message: string } | undefined;
  /** Producer reply seam preserves the real HTTP/WebSocket transport and command parser. */
  readonly commandResult?: (
    command: FakeCdpCommand,
    origin: string,
    frameReads: number,
  ) => Readonly<Record<string, unknown>> | undefined;
  /** Return undefined to use the stock producer events; an empty array suppresses them. */
  readonly commandEvents?: (
    command: FakeCdpCommand,
    origin: string,
  ) =>
    | readonly {
        readonly method: string;
        readonly params: unknown;
        readonly sessionId?: string;
      }[]
    | undefined;
  readonly malformedDiscovery?: boolean;
  readonly oversizedDiscovery?: boolean;
  readonly invalidBrowserWebSocket?: boolean;
  readonly pageScopedVersionWebSocket?: boolean;
  readonly omitTargetWebSocket?: boolean;
  readonly additionalPageWithWebSocket?: boolean;
  readonly additionalPageWithoutWebSocket?: boolean;
  readonly additionalPageCount?: number;
  readonly additionalElectronPageCount?: number;
  readonly invalidAttachedSession?: boolean;
  readonly malformedMessageOnMethod?: string;
  readonly malformedEventOnMethod?: string;
  readonly malformedEventShapeOnMethod?: string;
  readonly closeOnMethod?: string;
  readonly hangOnMethod?: string;
  readonly unsupportedMethods?: readonly string[];
  readonly transitionalFrameReads?: number;
  readonly attachedFrameUrl?: string;
  readonly frameUrlAfterFirstRead?: string;
  readonly navigateDuringObservationUrl?: string;
  readonly navigateDuringCaptureUrl?: string;
  readonly navigateDuringScreenshotUrl?: string;
  readonly screenshotDocumentLoader?: string;
  readonly extraCollections?: boolean;
  readonly indexedDbDateKeys?: boolean;
  readonly foreignSessionEvents?: boolean;
  readonly redirectToDisallowedOrigin?: boolean;
  readonly redirectFromDisallowedOrigin?: boolean;
  readonly redirectWithinOrigin?: boolean;
  readonly malformedRedirectResponse?: boolean;
  readonly omitRedirectResponse?: boolean;
  readonly redirectResponseUrl?: string;
  readonly redirectResponseEnvelope?: unknown;
  readonly responseAfterMalformedUrl?: string;
  readonly unrelatedWorker?: boolean;
  readonly binaryWebSocketEvent?: boolean;
  readonly invalidBinaryWebSocketEvent?: boolean;
  readonly sourceMapBody?: string;
  readonly sessionTimeline?:
    | "same_origin"
    | "outside_policy"
    | "target_detached";
  readonly sessionTimelineEventCount?: number;
  readonly sessionRedirectResourceType?: "Document" | "Fetch" | "Script";
  readonly closeAfterMethod?: string;
  readonly sensitiveShapes?: boolean;
  readonly cachedResponseBody?: string;
  readonly invalidResponseBodyBase64?: boolean;
  readonly webMcpTools?: boolean;
  readonly webMcpSameUrlRegistrations?: "retain" | "remove-second";
  readonly webMcpFrameCount?: number;
  readonly webMcpSchemaPropertyCount?: number;
  readonly webMcpInputSchema?: JsonValue;
  readonly webMcpChildLeavesScope?: boolean;
  readonly webMcpChildTransientBlank?: boolean;
  readonly webMcpChildRecoversAfterTransient?: boolean;
  readonly webMcpChildNavigatesAllowed?: boolean;
  readonly electronFileUrl?: string;
  readonly duplicateElectronInventory?: boolean;
  readonly electronInventoryCount?: number;
  readonly urlShapedAllowedTitle?:
    | boolean
    | "host-path"
    | "root-relative"
    | "prefixed";
}
