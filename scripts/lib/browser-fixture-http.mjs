import { createServer } from "node:http";

/** Interpret request targets once, before a fixture routes or forwards them. */
export const createBrowserFixtureHttpServer = (handleRequest) =>
  createServer((request, response) => {
    let target;
    try {
      // A leading // is an origin-form path, not a replacement authority.
      const requested = new URL(
        request.url?.startsWith("/")
          ? `http://fixture.invalid${request.url}`
          : request.url,
      );
      if (requested.protocol !== "http:" && requested.protocol !== "https:")
        throw new TypeError("Unsupported fixture request protocol");
      target = { pathname: requested.pathname, search: requested.search };
    } catch {
      response.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.end("Invalid HTTP request target");
      return;
    }
    handleRequest(request, response, target);
  });
