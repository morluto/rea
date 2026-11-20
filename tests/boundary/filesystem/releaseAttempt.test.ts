import { expect, it } from "vitest";
import {
  inspectGithubRelease,
  recordReleaseAttempt,
  verifyFrozenReleaseBranch,
} from "../../../scripts/ci/release-attempt.mjs";

const source = "a".repeat(40);
const parent = "b".repeat(40);
const ref = `refs/tags/rea-release-attempt/${source}`;

function repository(initial?: string) {
  let target = initial;
  return {
    async api(path: string, body?: { ref: string; sha: string }) {
      if (body) {
        expect(path).toBe("git/refs");
        expect(body.ref).toBe(ref);
        if (target) return new Response(null, { status: 422 });
        target = body.sha;
        return new Response(null, { status: 201 });
      }
      expect(path).toBe(`git/ref/tags/rea-release-attempt/${source}`);
      return target
        ? Response.json({ ref, object: { type: "commit", sha: target } })
        : new Response(null, { status: 404 });
    },
    target: () => target,
  };
}

it.each(["abandon", "publish"] as const)(
  "allows one durable %s decision and refuses the competing decision",
  async (winner) => {
    const { api, target } = repository();
    const loser = winner === "abandon" ? "publish" : "abandon";
    const [allowed, refused] = await Promise.allSettled([
      recordReleaseAttempt(api, source, parent, winner),
      recordReleaseAttempt(api, source, parent, loser),
    ]);
    expect(allowed.status).toBe("fulfilled");
    expect(refused).toMatchObject({ status: "rejected" });
    expect(target()).toBe(winner === "publish" ? source : parent);
    await expect(
      recordReleaseAttempt(api, source, parent, winner),
    ).resolves.toBeUndefined();
    await expect(
      recordReleaseAttempt(api, source, parent, loser),
    ).rejects.toThrow(
      winner === "publish" ? /resume the original release/u : /abandoned/u,
    );
  },
);

it("fails closed when a read is denied or the ref has an unknown target", async () => {
  await expect(
    recordReleaseAttempt(
      async () => new Response(null, { status: 403 }),
      source,
      parent,
      "abandon",
    ),
  ).rejects.toThrow("HTTP 403");
  await expect(
    recordReleaseAttempt(
      repository("c".repeat(40)).api,
      source,
      parent,
      "publish",
    ),
  ).rejects.toThrow("unexpected commit");
});

const versionTag = "rea-agents-6.10.2";

it.each([
  {
    name: "new candidate",
    release: false,
    target: null,
    draft: false,
    expected: false,
  },
  {
    name: "tag-only retry",
    release: false,
    target: source,
    draft: false,
    expected: false,
  },
  {
    name: "completed retry",
    release: true,
    target: source,
    draft: false,
    expected: true,
  },
  {
    name: "wrong source",
    release: true,
    target: parent,
    draft: false,
    expected: /differs/u,
  },
  {
    name: "draft",
    release: true,
    target: source,
    draft: true,
    expected: /visibility/u,
  },
  {
    name: "missing tag",
    release: true,
    target: null,
    draft: false,
    expected: /HTTP 404/u,
  },
])(
  "checks the GitHub release boundary for $name",
  async ({ release, target, draft, expected }) => {
    const result = inspectGithubRelease(
      async (path) => {
        if (path === `releases/tags/${versionTag}`) {
          return release
            ? Response.json({ tag_name: versionTag, draft })
            : new Response(null, { status: 404 });
        }
        expect(path).toBe(`git/ref/tags/${versionTag}`);
        return target
          ? Response.json({
              ref: `refs/tags/${versionTag}`,
              object: { type: "commit", sha: target },
            })
          : new Response(null, { status: 404 });
      },
      versionTag,
      source,
    );
    if (typeof expected === "boolean")
      await expect(result).resolves.toBe(expected);
    else await expect(result).rejects.toThrow(expected);
  },
);

it("refuses a frozen branch that moved after the candidate was selected", async () => {
  const branch = "release/6.10.2";
  const api = (sha: string) => async (path: string) => {
    expect(path).toBe(`git/ref/heads/${branch}`);
    return Response.json({
      ref: `refs/heads/${branch}`,
      object: { type: "commit", sha },
    });
  };
  await expect(
    verifyFrozenReleaseBranch(api(source), branch, source),
  ).resolves.toBeUndefined();
  await expect(
    verifyFrozenReleaseBranch(api(parent), branch, source),
  ).rejects.toThrow("branch moved");
});
