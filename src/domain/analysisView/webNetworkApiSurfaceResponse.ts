import { z } from "zod";
import { readRecordedResponseDeclaration } from "./recordedResponseBody.js";

const responseSchema = z.object({
  response: z.object({
    status: z.unknown().optional(),
    headers: z.unknown().optional(),
  }),
});
const headerSchema = z.object({
  name: z.string(),
  value: z.unknown(),
  value_unfolded: z.unknown().optional(),
});
/** A duplicate or unreadable header cannot establish a single Content-Type. */
const sazContentType = (
  headers: unknown,
): { readonly value: string; readonly sourceLength: number } | undefined => {
  if (!Array.isArray(headers)) return undefined;
  let found = false;
  let value:
    | { readonly value: string; readonly sourceLength: number }
    | undefined;
  for (const header of headers) {
    const parsed = headerSchema.safeParse(header);
    if (!parsed.success) return undefined;
    // Bound case folding to the one field name this projection consumes.
    if (
      parsed.data.name.length !== 12 ||
      parsed.data.name.toLowerCase() !== "content-type"
    )
      continue;
    if (found) return undefined;
    found = true;
    const raw = parsed.data.value;
    if (typeof raw !== "string") return undefined;
    const unfolded = parsed.data.value_unfolded;
    if (unfolded !== undefined && typeof unfolded !== "string")
      return undefined;
    const contentType = unfolded ?? raw;
    // Only SAZ's HTTP parser establishes valid continuations. A remaining
    // line break makes this header unknown, including in ignored parameters.
    if (/[\r\n]/u.test(contentType)) return undefined;
    value = { value: contentType, sourceLength: raw.length };
  }
  return value;
};

/** Interpret retained format facts; never reparse HTTP bytes or inspect bodies. */
export const apiSurfaceResponse = (
  reported: unknown,
  format: "har" | "saz",
): {
  readonly status: number | null;
  readonly mime: string;
  readonly mimeSourceLength: number;
} => {
  if (format === "har") {
    const response = readRecordedResponseDeclaration(reported);
    const status = response?.status;
    const mime = response?.content?.mimeType;
    return {
      status: typeof status === "number" && status !== 0 ? status : null,
      mime: typeof mime === "string" ? mime : "",
      mimeSourceLength: 0,
    };
  }
  const parsed = responseSchema.safeParse(reported);
  if (!parsed.success) return { status: null, mime: "", mimeSourceLength: 0 };
  const response = parsed.data.response;
  const status =
    typeof response.status === "string" && /^[0-9]{3}$/u.test(response.status)
      ? Number(response.status)
      : null;
  const contentType = sazContentType(response.headers);
  return {
    status: status === 0 ? null : status,
    mime: contentType?.value ?? "",
    mimeSourceLength: contentType?.sourceLength ?? 0,
  };
};
