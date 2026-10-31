import { expect } from "vitest";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains main-to-renderer sends with allocation ownership through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-main-ipc-");
    await writeFixtureFiles(root, {
      "main.cjs": `const { BrowserWindow, ipcMain } = require("electron");
        const first = new BrowserWindow();
        first.loadFile("index.html");
        first.webContents.send("shared", 1);
        first.webContents.postMessage("shared", { second: true });
        const second = new BrowserWindow();
        second.webContents.loadURL("https://example.test");
        second.webContents.send("shared", 2);
        const third = new BrowserWindow();
        const contents = third.webContents;
        contents.postMessage("result", { ok: true });
        const fourth = new BrowserWindow();
        fourth.webContents.mainFrame.send("frame-progress", 3);
        const fifth = new BrowserWindow();
        const frame = fifth.webContents.mainFrame;
        frame.postMessage("frame-result", { ok: true });
        ipcMain.handle("read", () => "value");`,
      "preload.cjs": `const { ipcRenderer } = require("electron");
        ipcRenderer.on("shared", (_event, value) => consume(value));
        ipcRenderer.on("result", (_event, value) => consume(value));
        ipcRenderer.on("frame-progress", (_event, value) => consume(value));
        ipcRenderer.on("frame-result", (_event, value) => consume(value));
        ipcRenderer.invoke("read");`,
    });

    const application = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(application.statistics.parse_failures).toBe(0);
    expect(application.summary.ipc).toMatchObject({
      operations: 12,
      literal_channels: 5,
      dynamic_channel_operations: 0,
      main_transmissions: 6,
      renderer_transmissions: 1,
      renderer_listeners: 4,
      main_handlers: 1,
      paired_renderer_transmissions: 1,
      ambiguous_renderer_transmissions: 0,
    });
    // Older retained Evidence did not inspect this direction. Reading it must
    // not turn an unmeasured count into a reported zero.
    const { main_transmissions: _main, ...historicalIpc } =
      application.summary.ipc;
    expect(
      javascriptApplicationAnalysisResultSchema.shape.summary.shape.ipc.parse(
        historicalIpc,
      ),
    ).not.toHaveProperty("main_transmissions");
    const channels = application.graph.nodes.filter(
      ({ kind }) => kind === "ipc-channel",
    );
    const shared = channels.filter(({ observations }) =>
      observations.some(({ properties }) => properties.channel === "shared"),
    );
    expect(shared).toHaveLength(3);
    const scoped = shared.filter(({ observations }) =>
      observations.some(({ properties }) => properties.side === "main"),
    );
    expect(scoped).toHaveLength(2);
    expect(new Set(scoped.map(({ node_id }) => node_id)).size).toBe(2);
    const owners = scoped.map(
      ({ observations }) => observations[0]?.properties.receiver,
    );
    expect(owners).toEqual([
      expect.objectContaining({ kind: "web-contents" }),
      expect.objectContaining({ kind: "web-contents" }),
    ]);
    expect(new Set(owners.map((owner) => JSON.stringify(owner))).size).toBe(2);
    const sends = application.graph.edges.filter(
      ({ relation, properties }) =>
        relation === "sends" && properties.side === "main",
    );
    expect(sends).toHaveLength(6);
    expect(
      sends.every(({ properties }) => properties.receiver !== undefined),
    ).toBe(true);
    expect(sends.map(({ properties }) => properties)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "result",
          operation: "post-message",
          receiver: expect.objectContaining({ kind: "web-contents" }),
        }),
        expect.objectContaining({
          channel: "frame-progress",
          operation: "send",
          receiver: expect.objectContaining({ kind: "main-frame" }),
        }),
        expect.objectContaining({
          channel: "frame-result",
          operation: "post-message",
          receiver: expect.objectContaining({ kind: "main-frame" }),
        }),
      ]),
    );
    const channelIds = new Set(channels.map(({ node_id }) => node_id));
    expect(
      sends.every(({ target_node_id }) => channelIds.has(target_node_id)),
    ).toBe(true);
    expect(
      application.graph.edges
        .filter(
          ({ evidence }) =>
            evidence.extractor.operation === "pair-ipc-literal-channel",
        )
        .map(({ properties }) => properties.channel),
    ).toEqual(["read"]);
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "does not promote lookalike or mutated main send receivers through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-main-ipc-receivers-");
    await writeFixtureFiles(root, {
      "control.cjs": `const { BrowserWindow } = require("electron");
        const window = new BrowserWindow();
        window.webContents.send("control", 1);`,
      "fake.cjs": `const fake = { webContents: { send() {}, postMessage() {} } };
        fake.webContents.send("fake", 1);
        fake.webContents.postMessage("fake-post", {});`,
      "shadowed.cjs": `const { BrowserWindow } = require("electron");
        function local(BrowserWindow) {
        const window = new BrowserWindow();
        window.webContents.send("shadowed", 1);
      }`,
      "replaced.cjs": `const { BrowserWindow } = require("electron");
        const window = new BrowserWindow();
        window.webContents = replacement;
        window.webContents.send("replaced", 1);`,
      "method.cjs": `const { BrowserWindow } = require("electron");
        const window = new BrowserWindow();
        window.webContents.postMessage = replacement;
        window.webContents.postMessage("method", {});`,
      "alias.cjs": `const { BrowserWindow } = require("electron");
        const window = new BrowserWindow();
        const alias = window.webContents;
        alias.send = replacement;
        window.webContents.send("alias", 1);`,
      "frame.cjs": `const { BrowserWindow } = require("electron");
        const window = new BrowserWindow();
        const frame = window.webContents.mainFrame;
        frame.postMessage = replacement;
        window.webContents.mainFrame.postMessage("frame", {});`,
      "prototype.cjs": `const { BrowserWindow } = require("electron");
        BrowserWindow.prototype.webContents = replacement;
        const window = new BrowserWindow();
        window.webContents.send("prototype", 1);`,
      "unsupported.cjs": `const { BrowserWindow } = require("electron");
        const window = new BrowserWindow();
        window.webContents.sendToFrame(1, "deferred-frame", {});
        const other = new BrowserWindow();
        other.send("window-lookalike", 1);
        const scoped = new BrowserWindow();
        scoped.webContents.ipc.send("ipc-lookalike", 1);`,
      "preload.cjs": `const { ipcRenderer } = require("electron");
        ipcRenderer.on("control", (_event, value) => consume(value));`,
    });

    const application = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(application.statistics.parse_failures).toBe(0);
    expect(application.summary.ipc).toMatchObject({
      operations: 2,
      main_transmissions: 1,
      renderer_listeners: 1,
      paired_renderer_transmissions: 0,
    });
    const channelObservations = application.graph.nodes.flatMap(
      ({ kind, observations }) => (kind === "ipc-channel" ? observations : []),
    );
    expect(
      channelObservations.map(({ properties }) => properties.channel),
    ).toEqual(["control", "control"]);
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains unresolved main send channels without listener pairing through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-main-ipc-dynamic-");
    await writeFixtureFiles(root, {
      "main.cjs": `const { BrowserWindow } = require("electron");
        const first = new BrowserWindow();
        first.webContents.send(runtimeChannel, 1);
        const second = new BrowserWindow();
        second.webContents.mainFrame.postMessage(otherChannel, {});`,
      "preload.cjs": `const { ipcRenderer } = require("electron");
        ipcRenderer.on("possible", (_event, value) => consume(value));`,
    });

    const application = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(application.statistics.parse_failures).toBe(0);
    expect(application.summary.ipc).toMatchObject({
      operations: 3,
      main_transmissions: 2,
      dynamic_channel_operations: 2,
      literal_channels: 1,
      renderer_listeners: 1,
      paired_renderer_transmissions: 0,
    });
    const sends = application.graph.edges.filter(
      ({ relation, properties }) =>
        relation === "sends" && properties.side === "main",
    );
    expect(sends).toHaveLength(2);
    expect(sends.map(({ properties }) => properties)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: null,
          channel_expression: "runtimeChannel",
          resolution: "dynamic",
          receiver: expect.objectContaining({ kind: "web-contents" }),
        }),
        expect.objectContaining({
          channel: null,
          channel_expression: "otherChannel",
          resolution: "dynamic",
          receiver: expect.objectContaining({ kind: "main-frame" }),
        }),
      ]),
    );
    expect(
      application.graph.edges.filter(
        ({ evidence }) =>
          evidence.extractor.operation === "pair-ipc-literal-channel",
      ),
    ).toEqual([]);
  },
);
