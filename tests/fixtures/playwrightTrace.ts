import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "./temporaryDirectory.js";

/** Assemble actual recorder text; opaque resource markers deliberately do not claim image validity. */
export const playwrightTraceFixture = async (
  options: {
    resources?: boolean;
    trace?: string;
    network?: string;
    level?: 0 | 6;
    extraMembers?: readonly { path: string; contents: string }[];
  } = {},
) => {
  const trace =
    options.trace ??
    (await readFile(
      new URL("./playwright-trace/trace.trace.txt", import.meta.url),
      "utf8",
    ));
  const network =
    options.network ??
    (await readFile(
      new URL("./playwright-trace/trace.network.txt", import.meta.url),
      "utf8",
    ));
  const root = await createTestTempDirectory("rea-playwright-trace-");
  const path = join(root, "trace.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  const compression =
    options.level === undefined ? {} : { level: options.level };
  await writer.add("trace.trace", new TextReader(trace), compression);
  await writer.add("trace.network", new TextReader(network), compression);
  if (options.resources) {
    const paths = new Set<string>();
    for (const line of trace.split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.type === "screencast-frame" && typeof row.file === "string")
        paths.add(row.file);
    }
    for (const line of network.split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      for (const field of [
        row.snapshot?.request?.postData,
        row.snapshot?.response?.content,
      ])
        if (typeof field?._file === "string") paths.add(field._file);
    }
    for (const name of paths)
      await writer.add(
        name,
        new TextReader(
          "Opaque fixture resource: bytes are not interpreted as an image or body.",
        ),
      );
  }
  for (const member of options.extraMembers ?? [])
    await writer.add(member.path, new TextReader(member.contents));
  await writeFile(path, await writer.close());
  return { root, path, trace, network };
};

/** Controlled v10 relationships with distinct source names sharing logical paths. */
export const playwrightTracePathFixture = () => {
  const trace = (resource: string) =>
    [
      { type: "context-options", version: 10 },
      { type: "screencast-frame", file: resource, timestamp: 1 },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n";
  const network = (resource: string, status: number) =>
    JSON.stringify({
      type: "resource-snapshot",
      snapshot: {
        request: { method: "GET", url: "http://captured.invalid/value" },
        response: { status, content: { _file: resource } },
      },
    }) + "\n";
  return playwrightTraceFixture({
    resources: true,
    trace: trace("resources/x"),
    network: network("resources/x", 200),
    extraMembers: [
      { path: "./trace.trace", contents: trace("./resources/x") },
      { path: "./trace.network", contents: network("./resources/x", 201) },
      { path: "./resources/x", contents: "Alternate unread resource bytes" },
    ],
  });
};
