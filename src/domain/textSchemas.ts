import { z } from "zod";

/**
 * A string with at least one UTF-16 code unit. It bounds nothing else: apply a
 * real length limit where a format, protocol or resource requires one.
 */
export const nonEmptyTextSchema = z.string().min(1);
