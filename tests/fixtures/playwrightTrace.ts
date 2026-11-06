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
  await writeFile(path, await writer.close());
  return { root, path, trace, network };
};
