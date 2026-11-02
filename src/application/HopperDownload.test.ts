import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadHopperPackage } from "./HopperDownload.js";

const redirect = (location: string): Response =>
  new Response(null, { status: 302, headers: { location } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadHopperPackage redirect origin", () => {
  it("returns the bytes for a direct response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("payload", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const result = await downloadHopperPackage(
      "https://www.hopperapp.com/download",
    );
    expect(result).toEqual({ ok: true, bytes: Buffer.from("payload") });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns the bytes when redirects stay on the requested origin", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(redirect("/releases/pkg.deb"))
      .mockResolvedValueOnce(
        redirect("https://www.hopperapp.com/final/pkg.deb"),
      )
      .mockResolvedValueOnce(new Response("payload", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const result = await downloadHopperPackage(
      "https://www.hopperapp.com/download",
    );
    expect(result).toEqual({ ok: true, bytes: Buffer.from("payload") });
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      "https://www.hopperapp.com/download",
      "https://www.hopperapp.com/releases/pkg.deb",
      "https://www.hopperapp.com/final/pkg.deb",
    ]);
  });

  it("refuses a redirect to another origin without requesting it", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(redirect("https://cdn.example.net/pkg.deb"))
      .mockResolvedValueOnce(new Response("payload", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const result = await downloadHopperPackage(
      "https://www.hopperapp.com/download",
    );
    expect(result.ok).toBe(false);
    expect(result.bytes).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a later hop that leaves the requested origin", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(redirect("/releases/pkg.deb"))
      .mockResolvedValueOnce(redirect("https://cdn.example.net/pkg.deb"))
      .mockResolvedValueOnce(new Response("payload", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const result = await downloadHopperPackage(
      "https://www.hopperapp.com/download",
    );
    expect(result.ok).toBe(false);
    expect(result.bytes).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
