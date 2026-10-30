import { z } from "zod";

import {
  browserAllowedOriginsSchema,
  browserWorkerTargetIdsSchema,
  sanitizeBrowserUrl,
} from "./browserObservation.js";
import { webPageInspectionSchema } from "./browserObservationSchemas.js";

/** Shared page and worker selection/origin boundary for retained browser Evidence. */
export const browserWorkerEvidenceScopeSchema = z
  .object({
    parameters: z.object({
      target_id: z.string().min(1),
      include_script_sources: z.boolean(),
      allowed_origins: browserAllowedOriginsSchema,
      worker_target_ids: browserWorkerTargetIdsSchema,
    }),
    normalized_result: webPageInspectionSchema.pick({
      target: true,
      scripts: true,
      workers: true,
    }),
  })
  .superRefine(({ parameters, normalized_result }, context) => {
    const allowed = new Set(parameters.allowed_origins);
    const { target, scripts } = normalized_result;
    if (target.target_id !== parameters.target_id)
      context.addIssue({
        code: "custom",
        path: ["parameters", "target_id"],
        message:
          "Browser Evidence target disagrees with its recorded selection",
      });
    const sanitizedTarget = sanitizeBrowserUrl(target.url);
    if (sanitizedTarget.url !== target.url)
      context.addIssue({
        code: "custom",
        path: ["normalized_result", "target", "url"],
        message: "Browser Evidence URL must be sanitized",
      });
    if (sanitizedTarget.origin !== target.origin)
      context.addIssue({
        code: "custom",
        path: ["normalized_result", "target"],
        message: "Browser Evidence target is outside its recorded origin scope",
      });
    else if (!allowed.has(target.origin))
      context.addIssue({
        code: "custom",
        path: ["parameters", "allowed_origins"],
        message: "Browser Evidence target is outside its recorded origin scope",
      });
    if (
      !parameters.include_script_sources &&
      scripts.items.some(({ source }) => source.included)
    )
      context.addIssue({
        code: "custom",
        path: ["parameters", "include_script_sources"],
        message:
          "Browser Evidence contains source without source-capture selection",
      });
    const retained = new Set(
      normalized_result.workers
        .filter((worker) => worker.observation !== undefined)
        .map((worker) => worker.target_id),
    );
    for (const id of parameters.worker_target_ids ?? [])
      if (!retained.has(id))
        context.addIssue({
          code: "custom",
          path: ["normalized_result", "workers"],
          message: "Worker Evidence selection has no retained observation",
        });
    for (const [index, worker] of normalized_result.workers.entries()) {
      const path = ["normalized_result", "workers", index];
      const sanitized = sanitizeBrowserUrl(worker.url);
      if (sanitized.url !== worker.url)
        context.addIssue({
          code: "custom",
          path: [...path, "url"],
          message: "Worker Evidence URL must be sanitized",
        });
      const origin = sanitized.origin;
      if (origin === null || origin !== worker.origin || !allowed.has(origin))
        context.addIssue({
          code: "custom",
          path,
          message:
            "Worker Evidence target is outside its recorded origin scope",
        });
      const observation = worker.observation;
      if (observation === undefined) continue;
      if (observation.ownership === "page_related" && worker.type !== "worker")
        context.addIssue({
          code: "custom",
          path: [...path, "observation", "ownership"],
          message: "Page-related ownership requires a dedicated worker target",
        });
      if (
        observation.ownership === "service_worker_client" &&
        worker.type !== "service_worker"
      )
        context.addIssue({
          code: "custom",
          path: [...path, "observation", "ownership"],
          message:
            "Service Worker client ownership requires a service_worker target",
        });
      if (
        !parameters.include_script_sources &&
        observation.scripts.some(({ source }) => source.included)
      )
        context.addIssue({
          code: "custom",
          path: [...path, "observation", "scripts"],
          message:
            "Worker Evidence contains source without source-capture selection",
        });
      if (
        observation.page_target_id !==
        (observation.ownership === "unknown" ? null : parameters.target_id)
      )
        context.addIssue({
          code: "custom",
          path: [...path, "observation", "page_target_id"],
          message:
            "Worker Evidence ownership disagrees with its recorded page target",
        });
      const selected =
        parameters.worker_target_ids?.includes(worker.target_id) ?? false;
      if (
        observation.selected_explicitly !== selected ||
        (observation.ownership === "unknown" &&
          !selected &&
          observation.scripts.some(({ source }) => source.included))
      )
        context.addIssue({
          code: "custom",
          path: [...path, "observation"],
          message:
            "Worker Evidence disagrees with its recorded target selection",
        });
      for (const [scriptIndex, script] of observation.scripts.entries()) {
        const sanitizedScript = sanitizeBrowserUrl(script.url);
        if (sanitizedScript.url !== script.url)
          context.addIssue({
            code: "custom",
            path: [...path, "observation", "scripts", scriptIndex, "url"],
            message: "Worker Evidence script URL must be sanitized",
          });
        const scriptOrigin = sanitizedScript.origin;
        if (scriptOrigin === null || !allowed.has(scriptOrigin))
          context.addIssue({
            code: "custom",
            path: [...path, "observation", "scripts", scriptIndex],
            message:
              "Worker Evidence script is outside its recorded origin scope",
          });
      }
    }
  });
