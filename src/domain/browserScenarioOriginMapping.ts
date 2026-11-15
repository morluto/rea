import type { SanitizedBrowserUrl } from "./browserObservation.js";
import type { RetainedBrowserScenarioCapture } from "./browserScenarioCapture.js";
import type { BrowserStepArtifacts } from "./browserScenarioCaptureValues.js";
import type { BrowserScenarioOriginMapping } from "./browserScenarioDiffValues.js";

/** Project only typed URL fields through a caller-selected origin correspondence. */
export const mapBrowserScenarioOrigin = (
  capture: RetainedBrowserScenarioCapture,
  mapping: BrowserScenarioOriginMapping,
): RetainedBrowserScenarioCapture => {
  const url = (value: SanitizedBrowserUrl): SanitizedBrowserUrl =>
    mapBrowserScenarioUrl(value, mapping);
  return {
    ...capture,
    scenario: { ...capture.scenario, start_origin: mapping.before_origin },
    steps: capture.steps.map((step) => ({
      ...step,
      before_url: url(step.before_url),
      after_url: url(step.after_url),
      artifacts: mapArtifacts(step.artifacts, url),
    })),
    events: {
      ...capture.events,
      items: capture.events.items.map((event) =>
        "url" in event && event.url !== null
          ? { ...event, url: url(event.url) }
          : event,
      ),
    },
  };
};

const mapArtifacts = (
  artifacts: BrowserStepArtifacts,
  url: (value: SanitizedBrowserUrl) => SanitizedBrowserUrl,
): BrowserStepArtifacts => ({
  ...artifacts,
  url:
    artifacts.url.state === "captured"
      ? { ...artifacts.url, value: url(artifacts.url.value) }
      : artifacts.url,
  history:
    artifacts.history.state === "captured"
      ? {
          ...artifacts.history,
          value: {
            ...artifacts.history.value,
            current_url: url(artifacts.history.value.current_url),
            navigation_entries: artifacts.history.value.navigation_entries.map(
              (entry) => ({
                ...entry,
                name: url(entry.name),
              }),
            ),
          },
        }
      : artifacts.history,
});

/** Map a typed URL's exact canonical authority, preserving every suffix byte. */
export const mapBrowserScenarioUrl = (
  value: SanitizedBrowserUrl,
  mapping: BrowserScenarioOriginMapping,
): SanitizedBrowserUrl => {
  if (value.origin !== mapping.after_origin) return value;
  let parsed: URL;
  try {
    parsed = new URL(value.url);
  } catch {
    return value;
  }
  if (
    parsed.origin !== mapping.after_origin ||
    !value.url.startsWith(mapping.after_origin)
  )
    return value;
  const suffix = value.url.slice(mapping.after_origin.length);
  if (
    suffix !== "" &&
    !suffix.startsWith("/") &&
    !suffix.startsWith("?") &&
    !suffix.startsWith("#")
  )
    return value;
  // Preserve source spelling of path, query and fragment. URL parsing above establishes
  // the authority, so a prefix-like foreign host is never mapped.
  return {
    ...value,
    url: mapping.before_origin + suffix,
    origin: mapping.before_origin,
  };
};
