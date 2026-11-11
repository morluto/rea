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
      "Correlate USN V2 records from a local acquired NTFS journal with a caller-paired MFT from the same volume. Reads at most 64 MiB per file. Returns source-order events, explicit coverage rows, both SHA-256 identities, and nextFileOffset for another page using the same inputs. Full file references include sequence numbers. Other journal versions and unverifiable references remain explicit. Reads only the selected acquisition files.",
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
