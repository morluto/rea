// Negotiate prebuilt Markdown while keeping the static asset service's routing.
function prefersMarkdown(accept) {
  const ranges = (accept ?? "")
    .toLowerCase()
    .split(",")
    .map((range) => {
      const [type, ...parameters] = range.trim().split(";");
      const quality = parameters
        .map((value) => value.trim())
        .find((value) => value.startsWith("q="));
      const q = quality === undefined ? 1 : Number(quality.slice(2));
      return {
        type: type.trim(),
        q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0,
      };
    });
  const quality = (type) => {
    for (const match of [type, "text/*", "*/*"]) {
      const matches = ranges.filter((range) => range.type === match);
      if (matches.length) return Math.max(...matches.map((range) => range.q));
    }
    return 0;
  };
  // Wildcards alone never opt a browser into Markdown; HTML wins ties.
  return (
    ranges.some((range) => range.type === "text/markdown") &&
    quality("text/markdown") > 0 &&
    quality("text/markdown") > quality("text/html")
  );
}

function advertiseMarkdown(response, path) {
  const vary = new Set(
    (response.headers.get("Vary") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (![...vary].some((s) => s.toLowerCase() === "accept" || s === "*"))
    vary.add("Accept");
  response.headers.set("Vary", [...vary].join(", "));
  response.headers.append(
    "Link",
    `<${path}>; rel="alternate"; type="text/markdown"`,
  );
  return response;
}

export default {
  async fetch(request, env) {
    const useMarkdown = prefersMarkdown(request.headers.get("Accept"));
    // HTML validators describe a different representation. Probe the route first,
    // then let the asset service evaluate validators/ranges against the Markdown.
    const probe = new Request(request);
    if (useMarkdown) {
      for (const name of [
        "If-None-Match",
        "If-Modified-Since",
        "If-Match",
        "If-Unmodified-Since",
        "If-Range",
        "Range",
      ])
        probe.headers.delete(name);
    }
    const original = await env.ASSETS.fetch(probe);
    if (
      ![200, 206, 304].includes(original.status) ||
      !["GET", "HEAD"].includes(request.method) ||
      !original.headers.get("Content-Type")?.startsWith("text/html")
    )
      return original;

    const url = new URL(request.url);
    if (!url.pathname.endsWith("/") && !url.pathname.endsWith(".html"))
      return original;
    const markdown = new URL(url);
    markdown.pathname = url.pathname.endsWith("/")
      ? `${url.pathname}index.md`
      : url.pathname.slice(0, -5) + ".md";
    const candidate = await env.ASSETS.fetch(
      useMarkdown
        ? new Request(markdown, request)
        : new Request(markdown, { method: "HEAD" }),
    );
    if (!candidate.ok && ![304, 412, 416].includes(candidate.status)) {
      await candidate.body?.cancel();
      return original;
    }
    const response = new Response(
      useMarkdown ? candidate.body : original.body,
      useMarkdown ? candidate : original,
    );
    if (useMarkdown) {
      await original.body?.cancel();
      if (candidate.status < 400)
        response.headers.set("Content-Type", "text/markdown; charset=utf-8");
    } else {
      await candidate.body?.cancel();
    }
    return advertiseMarkdown(response, markdown.pathname);
  },
};
