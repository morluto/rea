import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { decodeSazCapture } from "./SazCapture.js";

it("preserves mixed source spellings and session ordering within one SAZ", async () => {
  const entries = [
    ["././raw/42_s.txt", "raw/42_s.txt", "HTTP/1.1 200 OK\r\n\r\nresponse"],
    ["raw/7_c.txt", "raw/7_c.txt", "GET /ordinary HTTP/1.1\r\n\r\n"],
    ["./raw/42_c.txt", "raw/42_c.txt", "GET /prefixed HTTP/1.1\r\n\r\nbody"],
    ["./raw/42_m.xml", "raw/42_m.xml", "<Session/>"],
    ["././raw/42_w.txt", "raw/42_w.txt", "stored websocket bytes"],
    ["raw/7_g.txt", "raw/7_g.txt", "stored grpc bytes"],
    ["./notes.txt", "notes.txt", "ordinary evidence"],
  ] as const;
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  for (const [source, , content] of entries)
    await writer.add(source, new TextReader(content));
  const bytes = Buffer.from(await writer.close());
  const root = await createTestTempDirectory("rea-saz-member-names-");
  const path = join(root, "capture.saz");
  await writeFile(path, bytes);

  const capture = await decodeSazCapture(path, []);
  expect(capture.records).toMatchObject([
    {
      ordinal: 0,
      location: {
        kind: "archive-members",
        members: [
          "././raw/42_s.txt",
          "./raw/42_c.txt",
          "./raw/42_m.xml",
          "././raw/42_w.txt",
        ],
      },
      reported: {
        session_id: "42",
        request: { member: "./raw/42_c.txt", url: "/prefixed", body: "body" },
        response: { member: "././raw/42_s.txt", body: "response" },
        metadata: { member: "./raw/42_m.xml" },
        websocket: {
          member: "././raw/42_w.txt",
          messages: "stored websocket bytes",
        },
      },
    },
    {
      ordinal: 1,
      location: {
        kind: "archive-members",
        members: ["raw/7_c.txt", "raw/7_g.txt"],
      },
      reported: {
        session_id: "7",
        request: { member: "raw/7_c.txt", url: "/ordinary" },
        grpc: { member: "raw/7_g.txt", messages: "stored grpc bytes" },
      },
      limitations: [],
    },
  ]);
  const prefixNote = expect.stringContaining(
    "leading current-directory prefix",
  );
  expect(capture.records[0]?.limitations).toContainEqual(prefixNote);
  expect(capture.container.reported).toHaveProperty(
    "members",
    entries.map(([path, logical_path, content]) => ({
      path,
      kind: "file",
      bytes: Buffer.byteLength(content),
      ...(path === logical_path
        ? {}
        : { logical_path, limitations: [prefixNote] }),
    })),
  );
  expect((await readFile(path)).equals(bytes)).toBe(true);
});

it("keeps rejecting distinct source names that collide on one logical session member", async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  for (const name of ["raw/1_c.txt", "./raw/1_c.txt"])
    await writer.add(name, new TextReader("GET / HTTP/1.1\r\n\r\n"));
  const root = await createTestTempDirectory("rea-saz-member-collision-");
  const path = join(root, "capture.saz");
  await writeFile(path, Buffer.from(await writer.close()));
  await expect(decodeSazCapture(path, [])).rejects.toMatchObject({
    failure: { kind: "malformed" },
    message: "SAZ contains duplicate archive member names.",
  });
});
