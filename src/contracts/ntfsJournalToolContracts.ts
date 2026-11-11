import {
  NTFS_JOURNAL_OPERATION,
  ntfsJournalInputSchema,
  ntfsJournalResultSchema,
} from "../domain/windows/ntfsJournalQuery.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

export const NTFS_JOURNAL_TOOL_CONTRACTS = [
  {
    name: NTFS_JOURNAL_OPERATION,
    ...toolContractMetadata(NTFS_JOURNAL_OPERATION),
    kind: "application",
    description:
      "Inspect USN V2/V3/V4 records from a local acquired NTFS journal with a caller-paired MFT from the same volume. Reads at most 64 MiB per file. Returns source-order events, explicit coverage rows, both SHA-256 identities, and nextFileOffset for another page using the same inputs. V2 MFT references include sequence numbers; opaque V3/V4 IDs remain unresolved. MFT inventory counts are inline by default; select mft_record_limit for up to 32 detailed records, including identity-checked extension attributes and explicit link coverage. V4 returns at most 16 extent samples per event with explicit omissions. History completeness remains unknown. Other journal versions and unverifiable references remain explicit. Reads only the selected acquisition files.",
    inputSchema: ntfsJournalInputSchema,
    outputSchema: evidenceResultOf(ntfsJournalResultSchema),
    examples: [
      {
        title: "Read a page of a paired NTFS acquisition",
        input: {
          mft_path: "/artifacts/$MFT",
          journal_path: "/artifacts/UsnJrnl-J",
          max_rows: 50,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
