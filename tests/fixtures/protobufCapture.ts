import { create, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

/**
 * protoc 31.1 --include_imports golden, with two distinct imported filenames:
 * dep.proto: syntax="proto3"; package plain; message Item { uint32 number=1; }
 * \uFEFFdep.proto: syntax="proto3"; package marked; message Item { string text=1; }
 * root.proto imports both and defines capture.Root with plain.Item plain=1
 * and marked.Item marked=2. U+FEFF is filename data, not a document BOM.
 */
export const protobufBomDescriptor = (): Buffer =>
  Buffer.from(
    "0a3a0a096465702e70726f746f1205706c61696e221e0a044974656d12160a066e756d6265721801200128" +
      "0d52066e756d626572620670726f746f330a3a0a0cefbbbf6465702e70726f746f12066d61726b6564221a" +
      "0a044974656d12120a0474657874180120012809520474657874620670726f746f330a87010a0a726f6f74" +
      "2e70726f746f1207636170747572651a096465702e70726f746f1a0cefbbbf6465702e70726f746f224f0a" +
      "04526f6f7412210a05706c61696e18012001280b320b2e706c61696e2e4974656d5205706c61696e12240a" +
      "066d61726b656418022001280b320c2e6d61726b65642e4974656d52066d61726b6564620670726f746f33",
    "hex",
  );

export const protobufFrame = (body: Buffer, flag = 0): Buffer => {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
};

export const protobufCaptureBody = () =>
  Buffer.concat([
    protobufFrame(Buffer.from("0a0568656c6c6f12020102", "hex")),
    protobufFrame(Buffer.from("grpc-status: 0\r\n"), 128),
  ]);

/** Original fixture schema; independent expected field values come from the literal wire bytes. */
export const protobufCaptureDescriptor = () =>
  toBinary(
    FileDescriptorSetSchema,
    create(FileDescriptorSetSchema, {
      file: [
        {
          name: "capture.proto",
          package: "capture",
          syntax: "proto3",
          messageType: [
            {
              name: "Message",
              field: [
                { name: "sentence", number: 1, type: 9, label: 1 },
                { name: "values", number: 2, type: 13, label: 3 },
              ],
            },
          ],
        },
      ],
    }),
  );

export const protobufHar = (
  body: Buffer = protobufCaptureBody(),
  mimeType = "application/grpc-web+proto",
  additionalBodies: readonly Buffer[] = [],
  responseHeaders: readonly {
    readonly name: string;
    readonly value: string;
  }[] = [],
) =>
  JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "REA original fixture", version: "1" },
      entries: [body, ...additionalBodies].map((body) => ({
        startedDateTime: "2026-10-20T00:00:00Z",
        time: 1,
        request: {
          method: "POST",
          url: "https://example.invalid/api",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: "OK",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: responseHeaders,
          redirectURL: "",
          headersSize: -1,
          bodySize: body.length,
          content: {
            size: body.length,
            mimeType,
            text: body.toString("base64"),
            encoding: "base64",
          },
        },
        cache: {},
        timings: { send: 0, wait: 1, receive: 0 },
      })),
    },
  });
