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

/** Request paths exercising only the public API surface format rules. */
export const apiSurfaceHar = () => {
  const fixture = historicalHar();
  const entry = fixture.log.entries[0]!;
  const paths = [
    "/users/8812",
    "/users/9031",
    "/ids/550e8400-e29b-41d4-a716-446655440000",
    "/ids/abcdef0123456789abcdef0123456789",
    "/dates/2024-02-29",
    "/api/v1/users",
    "/api/v2/users",
    "/api/Report2",
    "/api/Report3",
    "/api/CreateDocument",
    "/api/ListDocuments",
    "/ids/abc123",
    "/dates/2023-02-29",
  ];
  fixture.log.entries = paths.map((path, index) => ({
    ...entry,
    request: {
      ...entry.request,
      url: `https://api.example.test${path}?not-in-view=value`,
    },
    response: {
      ...entry.response,
      status: index === 1 ? 404 : 200,
      content: {
        ...entry.response.content,
        mimeType:
          index === 1 ? "text/plain" : "application/json; charset=utf-8",
      },
    },
  }));
  return fixture;
};
