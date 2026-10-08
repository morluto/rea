/** Synthetic HAR 1.2 fixture with producer-declared sizes independent of Unicode content. */
export const historicalHar = () => ({
  log: {
    version: "1.2",
    creator: { name: "rea-source-owned-fixture", version: "1" },
    entries: [
      {
        startedDateTime: "2026-10-07T13:00:00.123+08:00",
        time: 1.25,
        request: {
          method: "GET",
          url: "https://example.test/a?token=ordinary#fragment",
          httpVersion: "HTTP/2",
          cookies: [],
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: "OK",
          httpVersion: "HTTP/2",
          cookies: [],
          headers: [],
          content: { size: 99, mimeType: "text/plain", text: "雪😀\r\n" },
          redirectURL: "",
          headersSize: -1,
          bodySize: 99,
        },
        cache: {},
        timings: { send: 0, wait: 1.25, receive: 0 },
      },
    ],
  },
});
