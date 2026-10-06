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
  readonly httpRequests: readonly {
    readonly url: string;
    readonly authorization: string | undefined;
    readonly cookie: string | undefined;
    readonly referer: string | undefined;
  }[];
  close(): Promise<void>;
}

export interface FakeOptions {
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
  readonly webMcpFrameCount?: number;
  readonly webMcpSchemaPropertyCount?: number;
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
