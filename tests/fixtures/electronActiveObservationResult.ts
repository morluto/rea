import { electronActiveObservationResultSchema } from "../../src/domain/electronActiveObservation.js";

/** Create a bounded active-capture result for MCP contract tests. */
export const createElectronActiveObservationFixtureResult = (
  applicationPath: string,
) =>
  electronActiveObservationResultSchema.parse({
    schema_version: 1,
    application: {
      executable_path: process.execPath,
      application_path: applicationPath,
      electron_version: "test-electron",
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
    },
    actions: [
      {
        step_id: "submit",
        kind: "click",
        window_index: 0,
        target: "window:1",
        status: "completed",
        elapsed_ms: 3,
        error: null,
      },
    ],
    windows: [
      {
        window_id: "window:1",
        web_contents_id: "webContents:1",
        url: "file:///tmp/app.html",
        title: "Fixture",
        visible: true,
        destroyed: false,
      },
    ],
    windows_truncated: false,
    processes: {
      items: [{ pid: 1234, type: "Browser", name: null, service_name: null }],
      truncated: false,
    },
    ipc: {
      events: [
        {
          sequence: 1,
          kind: "main-handler-invocation",
          channel: "readiness:echo",
          argument_shapes: ["string"],
          result_shape: "object",
          process_type: "main",
          error: false,
        },
      ],
      observed: 1,
      retained: 1,
      truncated: false,
    },
    limitations: [
      "IPC payloads are represented only by bounded value shapes; values are never retained.",
    ],
  });
