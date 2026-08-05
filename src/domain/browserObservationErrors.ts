/** Public browser, Electron, Inspector, and scenario operations. */
export type BrowserObservationOperation =
  | "list_browser_targets"
  | "inspect_web_page"
  | "analyze_web_bundle"
  | "observe_web_session"
  | "discover_webmcp_tools"
  | "compare_web_captures"
  | "capture_web_screenshot"
  | "compare_web_screenshots"
  | "list_electron_targets"
  | "inspect_electron_page"
  | "list_javascript_runtime_targets"
  | "observe_javascript_runtime"
  | "capture_browser_scenario"
  | "capture_electron_scenario";

/** Stable failure reasons shared by browser-family provider adapters. */
export type BrowserObservationFailureReason =
  | "endpoint_unreachable"
  | "invalid_endpoint_response"
  | "target_not_found"
  | "target_not_allowed"
  | "target_changed"
  | "protocol_error"
  | "disconnected"
  | "payload_limit"
  | "window_not_found"
  | "window_metadata_missing"
  | "cancelled"
  | "timeout"
  | "secret_unavailable";
