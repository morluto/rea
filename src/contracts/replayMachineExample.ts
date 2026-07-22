import { jsonObjectSchema } from "../domain/jsonValue.js";

/** Minimal login callback accepted by the direct replay-machine contract. */
export const REPLAY_MACHINE_RUN_EXAMPLE = jsonObjectSchema.parse({
  machine: {
    initial_state: "waiting",
    states: [{ name: "waiting" }, { name: "complete", terminal: true }],
    transitions: [
      {
        id: "accept_callback",
        from: "waiting",
        to: "complete",
        trigger: { protocol: "http", method: "POST", path: "/callback" },
        captures: [
          {
            variable: "token",
            value: { source: "request_json", path: ["token"] },
            sensitive: true,
          },
        ],
        actions: [{ type: "http_response", status: 204, body: "" }],
        max_uses: 1,
      },
    ],
    max_transitions: 1,
  },
  events: [
    {
      protocol: "http",
      connection: "not_applicable",
      at_ms: 0,
      method: "POST",
      path: "/callback",
      headers: {},
      body: '{"token":"opaque"}',
    },
  ],
});
