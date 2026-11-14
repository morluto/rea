import { z } from "zod";

import {
  ACCESS_MODES,
  HARDENING_OPTIONS,
  SCOPE_MODES,
  TARGET_KINDS,
} from "./catalog.js";
import type { CookieDescriptor, JobSecrets, JobSpec } from "./types.js";

const ids = <T extends readonly { id: string }[]>(items: T) =>
  items.map((item) => item.id) as [T[number]["id"], ...T[number]["id"][]];

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Use an http(s) URL.")
  .refine((value) => {
    const url = new URL(value);
    return url.username === "" && url.password === "";
  }, "Do not put credentials in the URL; use the access step.");

export const jobSpecSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    language: z.enum(["es", "en"]).optional(),
    target: z.object({
      kind: z.enum(ids(TARGET_KINDS)),
      url: httpUrl.optional(),
      path: z.string().trim().min(1).optional(),
    }),
    access: z.object({
      mode: z.enum(ids(ACCESS_MODES)),
      loginUrl: httpUrl.optional(),
      cdpPort: z.number().int().min(1).max(65535).optional(),
      cookies: z
        .array(
          z.object({
            name: z.string().min(1),
            domain: z.string().min(1),
            path: z.string().optional(),
          }),
        )
        .optional(),
    }),
    scope: z.object({
      mode: z.enum(ids(SCOPE_MODES)),
      description: z.string().trim().max(4000),
    }),
    enhancement: z.object({
      port: z
        .object({
          language: z.string().trim().min(1).max(60),
          framework: z.string().trim().max(80).optional(),
        })
        .optional(),
      stack: z.string().trim().max(400).optional(),
      hardening: z.array(z.enum(ids(HARDENING_OPTIONS))).default([]),
      instructions: z.string().trim().max(4000).optional(),
    }),
    budget: z.object({
      maxStepsPerPhase: z.number().int().min(5).max(500).default(60),
      maxTotalTokens: z.number().int().min(10_000).optional(),
      maxCostUsd: z.number().positive().max(10000).optional(),
    }),
    approvals: z.object({
      destructiveTools: z.enum(["ask", "auto"]).default("ask"),
      commands: z.enum(["ask", "auto"]).default("ask"),
      specReview: z.boolean().default(true),
    }),
    authorizationAttested: z.literal(true, {
      message:
        "Confirm that you own the target or are authorized to analyze and reproduce it.",
    }),
  })
  .superRefine((spec, context) => {
    if (spec.target.kind === "web" && !spec.target.url) {
      context.addIssue({
        code: "custom",
        path: ["target", "url"],
        message: "A web target needs a URL.",
      });
    }
    if (spec.target.kind !== "web" && !spec.target.path) {
      context.addIssue({
        code: "custom",
        path: ["target", "path"],
        message: "Upload or choose the file to analyze.",
      });
    }
    if (spec.access.mode === "connect" && spec.access.cdpPort === undefined) {
      context.addIssue({
        code: "custom",
        path: ["access", "cdpPort"],
        message: "Give the Chrome remote debugging port.",
      });
    }
    if (spec.scope.mode === "feature" && spec.scope.description.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["scope", "description"],
        message: "Describe the feature to clone.",
      });
    }
  });

export const parseJobSpec = (input: unknown): JobSpec =>
  jobSpecSchema.parse(input) as JobSpec;

const exportedCookieSchema = z.array(
  z
    .object({
      name: z.string().min(1),
      value: z.string(),
      domain: z.string().min(1),
      path: z.string().optional(),
    })
    .passthrough(),
);

/**
 * Split a browser cookie export (an array of {name, value, domain, path})
 * into metadata the agent may see and values that stay encrypted.
 */
export const splitCookieExport = (
  json: string,
): { descriptors: CookieDescriptor[]; values: string[] } => {
  const cookies = exportedCookieSchema.parse(JSON.parse(json));
  return {
    descriptors: cookies.map(({ name, domain, path }) => ({
      name,
      domain,
      ...(path ? { path } : {}),
    })),
    values: cookies.map(({ value }) => value),
  };
};

export const secretValues = (secrets: JobSecrets): string[] =>
  [secrets.username, secrets.password, ...(secrets.cookieValues ?? [])].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
