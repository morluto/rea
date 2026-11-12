import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** An HTTP answer's status and body. */
export interface HttpReply {
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array> | null;
}

/** Send a request and wait for its answer until `signal` ends it, with none of fetch's 300 s limit on the wait for headers. */
export const awaitHttpReply = (
  url: URL,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
  signal: AbortSignal,
): Promise<HttpReply> =>
  new Promise((resolve, reject) => {
    const body = init.body ?? "";
    (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: init.method,
        headers: {
          ...init.headers,
          "content-length": String(Buffer.byteLength(body)),
        },
        signal,
      },
      (message) => resolve({ status: message.statusCode ?? 0, body: message }),
    )
      .on("error", reject)
      .end(body);
  });
