import { z } from "zod";
import { address, document } from "./toolContractHelpers.js";

/** Hopper memory and file-mapping contracts. */
export const HOPPER_MEMORY_TOOL_DEFINITIONS = [
  {
    name: "read_bytes",
    description:
      "Read analyzed bytes from one provider-normalized virtual address. The hexadecimal payload reports the exact returned length; incomplete reads remain explicit and unsupported provider APIs return typed capability unavailability.",
    inputSchema: z.object({
      address,
      length: z.number().int().min(1).default(256),
      document,
    }),
  },
  {
    name: "address_to_file_offset",
    description:
      "Map one provider-normalized virtual address to its original nonnegative file offset. Hopper verifies the original bytes against the selected executable digest and translates FAT image-relative offsets using the loaded header. Results preserve the provider coordinate, image base, and source path. Unmapped addresses fail explicitly; changed or unavailable sources return typed errors retaining native mapping facts as partial evidence.",
    inputSchema: z.object({ address, document }),
  },
] as const;
