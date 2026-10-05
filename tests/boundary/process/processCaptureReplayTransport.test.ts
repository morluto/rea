import { expect, it, vi } from "vitest";
import WebSocket from "ws";

import { startLoopbackReplay } from "../../../src/application/LoopbackReplay.js";
import { parseProcessScenario } from "../../../src/domain/processCapture.js";

it("serves bounded HTTP and WebSocket replay on loopback", async () => {
  const scenario = parseProcessScenario({
    executable: "/bin/sh",
    working_directory: "/tmp",
    replay: {
      http: [{ method: "GET", path: "/ready", status: 201, body: "ready" }],
      websocket_messages: ["welcome"],
    },
  });
  const replay = await startLoopbackReplay(scenario);
  try {
    const response = await fetch(`${replay.httpUrl}/ready`);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ready");
    const websocketMessage = await new Promise<string>(
      (resolveMessage, rejectMessage) => {
        const socket = new WebSocket(replay.websocketUrl);
        socket.once("message", (value) => {
          resolveMessage(value.toString());
          socket.close();
        });
        socket.once("error", rejectMessage);
      },
    );
    expect(websocketMessage).toBe("welcome");
    expect(replay.events.map((event) => event.protocol)).toContain("websocket");
  } finally {
    await replay.close();
  }
});

it("matches and records the full HTTP request target including its query", async () => {
  const scenario = parseProcessScenario({
    executable: "/bin/sh",
    working_directory: "/tmp",
    replay: {
      http: [
        { method: "GET", path: "/item?id=1", status: 200, body: "matched" },
      ],
    },
  });
  const replay = await startLoopbackReplay(scenario);
  try {
    const matched = await fetch(`${replay.httpUrl}/item?id=1`);
    expect(matched.status).toBe(200);
    expect(await matched.text()).toBe("matched");
    const differentQuery = await fetch(`${replay.httpUrl}/item?id=2`);
    expect(differentQuery.status).toBe(404);
    expect(
      replay.events
        .filter(({ direction }) => direction === "request")
        .map(({ path }) => path),
    ).toEqual(["/item?id=1", "/item?id=2"]);
  } finally {
    await replay.close();
  }
});

it("matches bounded HTTP scripts without persisting request secrets", async () => {
  const scenario = parseProcessScenario({
    executable: "/bin/sh",
    working_directory: "/tmp",
    replay: {
      http: [
        {
          method: "POST",
          path: "/callback",
          request_headers: { authorization: "Bearer fixture-secret" },
          request_body: "credential-body",
          status: 302,
          response_headers: { location: "/done" },
          body: "redirecting",
          max_calls: 1,
        },
        {
          method: "GET",
          path: "/disconnect",
          status: 200,
          body: "",
          disconnect: true,
        },
      ],
    },
  });
  const replay = await startLoopbackReplay(scenario);
  try {
    const request = () =>
      fetch(`${replay.httpUrl}/callback`, {
        method: "POST",
        headers: { authorization: "Bearer fixture-secret" },
        body: "credential-body",
        redirect: "manual",
      });
    const matched = await request();
    expect(matched.status).toBe(302);
    expect(matched.headers.get("location")).toBe("/done");
    expect((await request()).status).toBe(409);
    expect((await fetch(`${replay.httpUrl}/missing`)).status).toBe(404);
    await expect(fetch(`${replay.httpUrl}/disconnect`)).rejects.toThrow();
    expect(replay.events.map(({ outcome }) => outcome)).toEqual(
      expect.arrayContaining([
        "matched",
        "script_exhausted",
        "unmatched",
        "disconnected",
      ]),
    );
    expect(JSON.stringify(replay.events)).not.toContain("fixture-secret");
    expect(JSON.stringify(replay.events)).not.toContain("credential-body");
  } finally {
    await replay.close();
  }
});

it("keeps long replay delays pending and cancels them when replay closes", async () => {
  const scenario = parseProcessScenario({
    executable: "/bin/sh",
    working_directory: "/tmp",
    replay: {
      http: [
        {
          method: "GET",
          path: "/later",
          status: 200,
          body: "ready",
          delay_ms: 2_147_483_648,
        },
      ],
    },
  });
  const replay = await startLoopbackReplay(scenario);
  const response = fetch(`${replay.httpUrl}/later`);
  try {
    await vi.waitFor(() => {
      expect(
        replay.events.some(({ direction }) => direction === "request"),
      ).toBe(true);
    });
    await replay.close();
    await expect(response).resolves.toMatchObject({ status: 200 });
  } finally {
    await replay.close();
  }
});

it("consumes ordered WebSocket reconnect scripts and reports exhaustion", async () => {
  const scenario = parseProcessScenario({
    executable: "/bin/sh",
    working_directory: "/tmp",
    replay: {
      websocket_connections: [
        {
          messages: [{ data: "first", delay_ms: 1 }],
          disconnect_after: true,
        },
        {
          messages: [{ data: "second" }],
          disconnect_after: true,
        },
      ],
    },
  });
  const replay = await startLoopbackReplay(scenario);
  const receive = () =>
    new Promise<string>((resolveMessage, rejectMessage) => {
      const socket = new WebSocket(replay.websocketUrl);
      socket.once("message", (value) => resolveMessage(value.toString()));
      socket.once("error", rejectMessage);
    });
  try {
    await expect(receive()).resolves.toBe("first");
    await expect(receive()).resolves.toBe("second");
    await new Promise<void>((resolveClose, rejectClose) => {
      const socket = new WebSocket(replay.websocketUrl);
      socket.once("close", () => resolveClose());
      socket.once("error", rejectClose);
    });
    expect(replay.events.at(-1)?.outcome).toBe("script_exhausted");
  } finally {
    await replay.close();
  }
});

it("serializes WebSocket transition actions across rapid messages", async () => {
  const scenario = parseProcessScenario({
    executable: "/bin/sh",
    working_directory: "/tmp",
    replay: {
      machine: {
        initial_state: "connecting",
        states: [
          { name: "connecting" },
          { name: "first" },
          { name: "second" },
          { name: "complete", terminal: true },
        ],
        transitions: [
          {
            id: "connect",
            from: "connecting",
            to: "first",
            trigger: { protocol: "websocket_connect", path: "/ws" },
            actions: [{ type: "websocket_send", data: "ready" }],
            max_uses: 1,
          },
          {
            id: "first",
            from: "first",
            to: "second",
            trigger: {
              protocol: "websocket_message",
              path: "/ws",
              body: "first",
            },
            actions: [
              { type: "delay", duration_ms: 30 },
              { type: "websocket_send", data: "first-done" },
            ],
            max_uses: 1,
          },
          {
            id: "second",
            from: "second",
            to: "complete",
            trigger: {
              protocol: "websocket_message",
              path: "/ws",
              body: "second",
            },
            actions: [{ type: "websocket_send", data: "second-done" }],
            max_uses: 1,
          },
        ],
        max_transitions: 3,
      },
    },
  });
  const replay = await startLoopbackReplay(scenario);
  try {
    const messages = await new Promise<string[]>((resolve, reject) => {
      const received: string[] = [];
      const socket = new WebSocket(replay.websocketUrl);
      socket.on("message", (value) => {
        received.push(value.toString());
        if (received.length === 1) {
          socket.send("first");
          socket.send("second");
        }
        if (received.length === 3) {
          socket.close();
          resolve(received);
        }
      });
      socket.once("error", reject);
    });
    expect(messages).toEqual(["ready", "first-done", "second-done"]);
  } finally {
    await replay.close();
  }
});

it("drains queued machine work before exposing finalized snapshots", async () => {
  const scenario = parseProcessScenario({
    executable: "/bin/sh",
    working_directory: "/tmp",
    replay: {
      machine: {
        initial_state: "connecting",
        states: [
          { name: "connecting" },
          { name: "first" },
          { name: "second" },
          { name: "complete", terminal: true },
        ],
        transitions: [
          {
            id: "connect",
            from: "connecting",
            to: "first",
            trigger: { protocol: "websocket_connect", path: "/ws" },
            actions: [{ type: "websocket_send", data: "ready" }],
            max_uses: 1,
          },
          {
            id: "first",
            from: "first",
            to: "second",
            trigger: {
              protocol: "websocket_message",
              path: "/ws",
              body: "first",
            },
            actions: [
              { type: "delay", duration_ms: 30 },
              { type: "disconnect" },
            ],
            max_uses: 1,
          },
          {
            id: "second",
            from: "second",
            to: "complete",
            trigger: {
              protocol: "websocket_message",
              path: "/ws",
              body: "second",
            },
            actions: [{ type: "websocket_send", data: "done" }],
            max_uses: 1,
          },
        ],
        max_transitions: 3,
      },
    },
  });
  const replay = await startLoopbackReplay(scenario);
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(replay.websocketUrl);
    socket.once("message", () => {
      socket.send("first");
      socket.send("second");
      setTimeout(resolve, 5);
    });
    socket.once("error", reject);
  });

  await replay.close();
  const finalized = replay.transitions;
  expect(finalized.map(({ transition_id }) => transition_id)).toEqual([
    "connect",
    "first",
    "second",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(replay.transitions).toEqual(finalized);
});

it("enforces replay duration before normalizing recorded timestamps", async () => {
  const scenario = parseProcessScenario({
    executable: "/bin/sh",
    working_directory: "/tmp",
    normalization: { time_bucket_ms: 60_000 },
    replay: {
      machine: {
        initial_state: "waiting",
        states: [{ name: "waiting" }, { name: "complete", terminal: true }],
        transitions: [
          {
            id: "late",
            from: "waiting",
            to: "complete",
            trigger: { protocol: "http", method: "GET", path: "/late" },
            actions: [{ type: "http_response", status: 200, body: "late" }],
            max_uses: 1,
          },
        ],
        max_transitions: 1,
        limits: { duration_ms: 5 },
      },
    },
  });
  const replay = await startLoopbackReplay(scenario);
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await fetch(`${replay.httpUrl}/late`);
    expect(response.status).toBe(409);
    expect(replay.events.at(-1)).toMatchObject({
      at_ms: 0,
      outcome: "limit_exhausted",
    });
  } finally {
    await replay.close();
  }
});
