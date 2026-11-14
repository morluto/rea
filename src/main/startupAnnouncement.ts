import type { CapabilityAvailabilityFacts } from "../application/CapabilityAvailability.js";
import type {
  OptionalObservationProviders,
  OptionalProviderLoadFailures,
} from "../application/OptionalObservationProviders.js";
import { PRODUCT_IDENTITY } from "../identity.js";

/**
 * Tag every REA line written to the terminal rather than to the protocol leads
 * with, as `[jcalculator]` and `[dependancythang]` do in the same stderr stream:
 * a client host that inherits a child's stderr shows those banners beside its
 * own output and the other servers' ones, and the tag is what tells them apart.
 * It names the project, not the binary.
 *
 * A banner states that this server started and what it detected, so it is
 * written at every `REA_LOG_LEVEL`, `silent` included: the level governs the
 * structured log, and neither sibling server consults it for its own start-up
 * line. Suppressing the banner would leave the one channel a client host shows
 * empty and the process indistinguishable from a misconfigured one.
 */
const BANNER_TAG = "[rea]";

/** Separates the announcement from its facts, matching the sibling banners. */
const BANNER_SEPARATOR = " — ";

/** Transport that composed the runtime; the HTTP listener reports its URL separately. */
export type StartupTransport = "stdio" | "streamable-http";

/** What a stdio entry advertises: the whole catalog, or hot tools plus discovery. */
export type AdvertisedCatalog =
  | { readonly profile: "full"; readonly toolCount: number }
  | { readonly profile: "hot-cold" };

/** Inputs for the line written once each composed analysis runtime is ready. */
export interface AnalysisRuntimeAnnouncement {
  readonly transport: StartupTransport;
  /** Facts the composition observed; absent when the transport had none to report. */
  readonly availability: CapabilityAvailabilityFacts | undefined;
  readonly providers: OptionalObservationProviders;
  readonly providerLoadFailures: OptionalProviderLoadFailures | undefined;
}

/** Render a fact list for human reading, naming an empty one rather than trailing off. */
const facts = (items: readonly string[]): string =>
  items.length === 0 ? "none" : items.join(", ");

/** Enabled optional-feature flags, in the order the composition declared them. */
const enabledFeatures = (
  availability: CapabilityAvailabilityFacts | undefined,
): string[] =>
  Object.entries(availability?.optionalFeatures ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([feature]) => feature);

/** Provider ids whose adapter constructed, and those whose module failed to load. */
const providerIds = (
  providers: OptionalObservationProviders,
  failures: OptionalProviderLoadFailures | undefined,
): { readonly loaded: string[]; readonly failed: string[] } => ({
  loaded: Object.entries(providers)
    .filter(([, provider]) => provider !== undefined)
    .map(([providerId]) => providerId),
  failed: Object.entries(failures ?? {})
    .filter(([, failure]) => failure !== undefined)
    .map(([providerId]) => providerId),
});

/** How many tools a stdio entry serves: all of them, or hot ones plus discovery. */
const catalogSummary = (catalog: AdvertisedCatalog): string =>
  catalog.profile === "full"
    ? `${String(catalog.toolCount)} tools`
    : "hot tools plus discovery";

/** The start-up line of the deferred stdio entry, without its terminator. */
export const deferredStdioBanner = (catalog: AdvertisedCatalog): string =>
  `${BANNER_TAG} MCP server ready${BANNER_SEPARATOR}${PRODUCT_IDENTITY.displayName} ${PRODUCT_IDENTITY.packageVersion}, ${catalogSummary(catalog)}, stdio (analysis runtime deferred)`;

/**
 * The composition line, without its terminator. Detection names the same
 * `optionalFeatures` and provider facts `binary_session` reports as capability
 * availability, not a second interpretation of them; an enabled feature asserts
 * that its tool is configured, not that running it would succeed.
 */
export const analysisRuntimeBanner = (
  announcement: AnalysisRuntimeAnnouncement,
): string => {
  const providers = providerIds(
    announcement.providers,
    announcement.providerLoadFailures,
  );
  return `${BANNER_TAG} MCP analysis runtime ready${BANNER_SEPARATOR}${announcement.transport}, optional tools: ${facts(enabledFeatures(announcement.availability))}; providers: ${facts(providers.loaded)}; failed: ${facts(providers.failed)}`;
};

/** Announce the deferred stdio server, which serves discovery before any runtime. */
export const announceDeferredStdioStartup = (
  writeStderr: (text: string) => void,
  catalog: AdvertisedCatalog,
): void => {
  writeStderr(`${deferredStdioBanner(catalog)}\n`);
};

/** Announce the optional tools and providers one composed analysis runtime detected. */
export const announceAnalysisRuntimeReady = (
  writeStderr: (text: string) => void,
  announcement: AnalysisRuntimeAnnouncement,
): void => {
  writeStderr(`${analysisRuntimeBanner(announcement)}\n`);
};
