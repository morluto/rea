import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  githubApi,
  inspectGithubRelease,
  recordReleaseAttempt,
  requireCurrentMainCheckpoint,
  retireAbandonedRelease,
  verifyFrozenReleaseBranch,
} from "../../../scripts/ci/release-attempt.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { workflowGit } from "../../support/workflowGit.js";

const source = "a".repeat(40);
const parent = "b".repeat(40);
const ref = `refs/tags/rea-release-attempt/${source}`;

it.each([
  { status: 200, stillPending: false },
  { status: 404, stillPending: false },
  { status: 200, stillPending: true },
  { status: 403, stillPending: true },
])(
  "verifies withdrawal of a pending release label after HTTP $status (still pending: $stillPending)",
  async ({ status, stillPending }) => {
    const pending = { name: "autorelease: pending" };
    const pr = {
      number: 1,
      body: null,
      merged_at: "2026-11-20T04:57:56Z",
      merge_commit_sha: source,
      base: { ref: "main" },
      head: {
        ref: "release-please--branches--main--components--rea-agents",
        repo: { full_name: "fixture/rea" },
      },
      labels: [pending],
    };
    const reread = vi.fn(async () =>
      JSON.stringify({ ...pr, labels: stillPending ? [pending] : [] }),
    );
    const result = retireAbandonedRelease(
      reread,
      async (path, _body, method) => {
        expect(path).toBe("issues/1/labels/autorelease%3A%20pending");
        expect(method).toBe("DELETE");
        return status === 200
          ? Response.json([], { status })
          : new Response(null, { status });
      },
      "fixture/rea",
      source,
      pr,
    );
    if (status === 403) {
      await expect(result).rejects.toThrow("HTTP 403");
      expect(reread).not.toHaveBeenCalled();
    } else if (stillPending) {
      await expect(result).rejects.toThrow(
        "still has pending publication authority",
      );
    } else {
      await expect(result).resolves.toBeUndefined();
      expect(reread).toHaveBeenCalledWith("gh", [
        "api",
        "repos/fixture/rea/pulls/1",
      ]);
    }
  },
);

it("sends authenticated release requests only to the fixed GitHub API endpoint", async () => {
  const request = vi.fn(async (url: URL, options: RequestInit) => {
    expect(url.href).toBe(
      "https://api.github.com/repos/fixture/rea/issues/1/labels/autorelease%3A%20pending",
    );
    expect(options).toMatchObject({ redirect: "error", method: "DELETE" });
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", request);
  try {
    const api = githubApi("fixture/rea", "fixture-token");
    expect(() => api("../../outside")).toThrow("Invalid GitHub API path");
    expect(() => githubApi("../rea", "fixture-token")("git/refs")).toThrow(
      "Invalid GitHub API path",
    );
    expect(request).not.toHaveBeenCalled();
    await expect(
      api("issues/1/labels/autorelease%3A%20pending", undefined, "DELETE"),
    ).resolves.toMatchObject({ status: 204 });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("proves the live main checkpoint while keeping the qualified checkout pinned", async () => {
  const remote = await createTestTempDirectory("rea-release-main-");
  const checkout = await createTestTempDirectory("rea-release-checkout-");
  const manifest = ".release-please-manifest.json";
  const git = (args: string[]) => workflowGit(remote, args);
  const localGit = (args: string[]) => workflowGit(checkout, args);
  await git(["init", "--initial-branch=main"]);
  await writeFile(join(remote, manifest), '{".":"6.10.2"}\n');
  await git(["add", manifest]);
  await git(["commit", "-m", "Release candidate"]);
  const candidate = await git(["rev-parse", "HEAD"]);
  await localGit(["clone", "--no-local", remote, "."]);
  await localGit(["checkout", "--detach", candidate]);

  await git(["commit", "--allow-empty", "-m", "Later main commit"]);
  const advance = await git(["rev-parse", "HEAD"]);
  await expect(localGit(["cat-file", "-e", advance])).rejects.toThrow();
  const prove = (tip: string) =>
    requireCurrentMainCheckpoint(
      (program, args) => {
        expect(program).toBe("git");
        return localGit(args);
      },
      async (path) => {
        expect(path).toBe("git/ref/heads/main");
        return Response.json({
          ref: "refs/heads/main",
          object: { type: "commit", sha: tip },
        });
      },
      candidate,
    );
  await expect(prove(advance)).resolves.toBeUndefined();

  await writeFile(join(remote, manifest), '{".":"6.10.3"}\n');
  await git(["commit", "-am", "Change the release checkpoint"]);
  await expect(prove(await git(["rev-parse", "HEAD"]))).rejects.toThrow(
    "not the current main release metadata checkpoint",
  );
  expect(await localGit(["rev-parse", "HEAD"])).toBe(candidate);
});

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
