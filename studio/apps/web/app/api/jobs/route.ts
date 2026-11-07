import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import {
  parseJobSpec,
  splitCookieExport,
  studioHome,
  type JobSecrets,
} from "@rea-studio/core";

import { badRequest, errorText, getStore, guard, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  return json({ jobs: getStore().listJobs() });
}

interface JobPayload {
  spec?: Record<string, unknown>;
  secrets?: { username?: string; password?: string; cookiesJson?: string };
  analysisModelId?: string;
  buildModelId?: string;
  projectId?: string;
}

const safeName = (name: string): string =>
  basename(name)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 120) || "artifact";

/** Create a job from multipart form data: a `job` JSON field and an optional `artifact` file. */
export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest("Send the job as multipart form data.");
  }
  let payload: JobPayload;
  try {
    payload = JSON.parse(String(form.get("job") ?? "{}")) as JobPayload;
  } catch {
    return badRequest("The job field is not valid JSON.");
  }
  const store = getStore();
  const project = payload.projectId
    ? store.getProject(payload.projectId)
    : undefined;
  if (payload.projectId && !project) return badRequest("Project not found.");
  const analysisModelId = payload.analysisModelId || project?.modelId || "";
  const buildModelId = payload.buildModelId || analysisModelId;
  if (!store.getModel(analysisModelId) || !store.getModel(buildModelId)) {
    return badRequest("Choose a saved model for the job.");
  }

  const rawSpec = { ...(payload.spec ?? {}) } as Record<string, unknown>;
  const target = { ...((rawSpec.target as Record<string, unknown>) ?? {}) };
  const access = { ...((rawSpec.access as Record<string, unknown>) ?? {}) };

  const artifact = form.get("artifact");
  if (artifact instanceof File && artifact.size > 0) {
    const dir = join(studioHome(), "uploads", randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, safeName(artifact.name));
    await pipeline(
      Readable.fromWeb(
        artifact.stream() as unknown as WebReadableStream<Uint8Array>,
      ),
      createWriteStream(path, { mode: 0o600 }),
    );
    target.path = path;
  } else if (typeof target.path === "string" && target.path.trim()) {
    const local = target.path.trim();
    if (!isAbsolute(local) || !existsSync(local)) {
      return badRequest(
        "The local path must be absolute and exist on this machine.",
      );
    }
    target.path = local;
  }

  const secrets: { -readonly [K in keyof JobSecrets]: JobSecrets[K] } = {};
  const given = payload.secrets ?? {};
  if (access.mode === "password") {
    if (!given.password)
      return badRequest("Enter the password for the target login.");
    if (given.username) secrets.username = given.username;
    secrets.password = given.password;
  }
  if (access.mode === "storage") {
    try {
      const cookies = splitCookieExport(given.cookiesJson ?? "");
      if (cookies.values.length === 0)
        return badRequest("The cookie export is empty.");
      access.cookies = cookies.descriptors;
      secrets.cookieValues = cookies.values;
    } catch {
      return badRequest(
        "Paste cookies as a JSON array of {name, value, domain, path}.",
      );
    }
  }

  try {
    const spec = parseJobSpec({ ...rawSpec, target, access });
    if (
      spec.budget.maxCostUsd !== undefined &&
      (!store.getModel(analysisModelId)?.pricing ||
        !store.getModel(buildModelId)?.pricing)
    )
      return badRequest(
        "A cost budget requires prices for both selected models.",
      );
    const job = store.createJob({
      spec,
      secrets,
      analysisModelId,
      buildModelId,
      ...(project ? { projectId: project.id } : {}),
    });
    return json({ job }, 201);
  } catch (cause) {
    return badRequest(errorText(cause));
  }
}
