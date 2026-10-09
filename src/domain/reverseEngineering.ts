import { z } from "zod";

/** Caller-selected static objdump facet. */
export const objdumpInputSchema = z
  .object({
    path: z.string().min(1),
    operation: z.enum([
      "file_headers",
      "section_headers",
      "symbols",
      "relocations",
      "dwarf",
      "disassemble",
      "disassemble_all",
      "architectures",
    ]),
    follow_debug_links: z.boolean().default(true),
  })
  .strict();

/** Caller-selected Rizin command against one local artifact. */
export const rizinInputSchema = z
  .object({
    path: z.string().min(1),
    command: z
      .string()
      .min(1)
      .refine(
        (value) => !/[\r\n]/u.test(value),
        "A single command line is required",
      ),
  })
  .strict();

export type ObjdumpInput = z.input<typeof objdumpInputSchema>;
export type RizinInput = z.input<typeof rizinInputSchema>;
