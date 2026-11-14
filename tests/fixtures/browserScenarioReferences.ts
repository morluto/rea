import { resolve } from "node:path";

/** Inert inputs for reference validation; no browser or secret value is used. */
export const browserScenarioReferences = (
  placement: "query" | "storage" | "session-storage" | "cookie",
  count: number,
) => {
  const entries = Array.from({ length: count }, (_, index) => ({
    name: `entry_${String(index)}`,
    value: { source: "secret", secret_id: "token" },
  }));
  return {
    browser: { mode: "launch", executable_path: resolve("unused-chromium") },
    start_url: {
      url: "http://127.0.0.1:1/",
      query: placement === "query" ? entries : [],
    },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
    secrets: [
      { secret_id: "token", environment_variable: "REA_REFERENCE_FIXTURE" },
    ],
    storage: {
      cookies:
        placement === "cookie"
          ? [
              {
                name: "fixture",
                value: { source: "literal", value: "fixture" },
                destination: { url: "http://127.0.0.1:1/", query: entries },
                http_only: false,
                secure: false,
                same_site: "Lax",
              },
            ]
          : [],
      local_storage:
        placement === "storage"
          ? [{ origin: "http://127.0.0.1:1", entries }]
          : [],
      session_storage:
        placement === "session-storage"
          ? [{ origin: "http://127.0.0.1:1", entries }]
          : [],
    },
  };
};
