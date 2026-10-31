import { McapWriter, TempBuffer } from "@mcap/core";
import type { McapWriterOptions } from "@mcap/core";

export const timestamp = 9_007_199_254_740_993n;

export async function recording(
  options: Partial<Omit<McapWriterOptions, "writable">> = {},
  schemaData = Buffer.from('{"type":"object"}'),
  library = "rea-mcap-test",
): Promise<Buffer> {
  const buffer = new TempBuffer();
  const writer = new McapWriter({ writable: buffer, ...options });
  await writer.start({ profile: "", library });
  const schemaId = await writer.registerSchema({
    name: "Sample",
    encoding: "jsonschema",
    data: schemaData,
  });
  for (const messageEncoding of ["json", "custom"]) {
    const channelId = await writer.registerChannel({
      topic: "/sensor",
      messageEncoding,
      schemaId,
      metadata: new Map([["source", "fixture"]]),
    });
    await writer.addMessage({
      channelId,
      sequence: 0,
      logTime: timestamp,
      publishTime: timestamp + 1n,
      data: Buffer.from("{}"),
    });
  }
  await writer.end();
  return Buffer.from(buffer.get());
}
