import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { decodeSazCapture } from "./SazCapture.js";

it.each(["", "./", "././"])(
  "preserves SAZ source member names while classifying logical paths: %j",
  async (prefix) => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
    });
    await writer.add(
      `${prefix}raw/1_c.txt`,
      new TextReader("GET /path HTTP/1.1\r\n\r\nbody"),
    );
    for (const [name, text] of [
      ["s.txt", "HTTP/1.1 200 OK\r\n\r\nresponse-body"],
      ["m.xml", "<Session><SessionFlags /></Session>"],
      ["w.txt", "stored-websocket-bytes"],
      ["g.txt", "stored-grpc-bytes"],
    ] as const)
      await writer.add(`${prefix}raw/1_${name}`, new TextReader(text));
    await writer.add(`${prefix}notes.txt`, new TextReader("ordinary evidence"));
    const bytes = Buffer.from(await writer.close());
    const root = await createTestTempDirectory("rea-saz-member-names-");
    const path = join(root, "capture.saz");
    await writeFile(path, bytes);

    const capture = await decodeSazCapture(path, []);
    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]).toMatchObject({
      location: {
        kind: "archive-members",
        members: ["c.txt", "s.txt", "m.xml", "w.txt", "g.txt"].map(
          (name) => `${prefix}raw/1_${name}`,
        ),
      },
      reported: {
        request: { member: `${prefix}raw/1_c.txt`, url: "/path", body: "body" },
        response: { member: `${prefix}raw/1_s.txt`, body: "response-body" },
        metadata: { member: `${prefix}raw/1_m.xml` },
        websocket: {
          member: `${prefix}raw/1_w.txt`,
          messages: "stored-websocket-bytes",
        },
        grpc: { member: `${prefix}raw/1_g.txt`, messages: "stored-grpc-bytes" },
      },
    });
    expect(capture.container.reported).toMatchObject({
      members: [
        ...["c.txt", "s.txt", "m.xml", "w.txt", "g.txt"].map((name) => ({
          path: `${prefix}raw/1_${name}`,
        })),
        { path: `${prefix}notes.txt` },
      ],
    });
    if (prefix !== "") {
      expect(capture.records[0]?.limitations).toContainEqual(
        expect.stringContaining("leading current-directory prefix"),
      );
      expect(capture.container.reported).toMatchObject({
        members: [
          ...["c.txt", "s.txt", "m.xml", "w.txt", "g.txt"].map((name) => ({
            logical_path: `raw/1_${name}`,
            limitations: [
              expect.stringContaining("leading current-directory prefix"),
            ],
          })),
          {
            logical_path: "notes.txt",
            limitations: [
              expect.stringContaining("leading current-directory prefix"),
            ],
          },
        ],
      });
    } else {
      expect(capture.records[0]?.limitations).toEqual([]);
      expect(capture.container.reported).not.toHaveProperty(
        "members.0.logical_path",
      );
      expect(capture.container.reported).not.toHaveProperty(
        "members.0.limitations",
      );
    }
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

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
    reason: "format",
    message: "SAZ contains duplicate archive member names.",
  });
});
