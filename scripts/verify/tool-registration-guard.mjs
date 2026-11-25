// Each catalog tool is bound once, in the shared binding table
// (serviceToolBindings.ts / contractToolBindings.ts), so its admission,
// logging, progress and delivery come from one loop. A bespoke
// `server.registerTool` call, typed or not, re-implements that wiring for one
// family.
const toolRegistration = /\.registerTool\b(?:\s*<[^;{}()]*>)?\s*\(/gu;

/**
 * Files that own registration rather than bypass it. Each entry gives the
 * reason.
 * @type {ReadonlyMap<string, string>}
 */
export const TOOL_REGISTRATION_OWNERS = new Map([
  ["src/server/contractToolBindings.ts", "The shared binding loop."],
  [
    "src/server/EvidenceMcpServerCore.ts",
    "Wraps the SDK registration every bound tool goes through.",
  ],
  [
    "src/server/RequestTrackingMcpServer.ts",
    "Forwards SDK registration to track in-flight requests.",
  ],
  [
    "src/server/environment/serveEnvironment.ts",
    "The agent environment server serves its own catalog, not REA's.",
  ],
]);

/** @param {string} content */
export const toolRegistrationCount = (content) =>
  content.match(toolRegistration)?.length ?? 0;
