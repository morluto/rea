import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import {
  binaryNinjaPageSchema,
  type BinaryNinjaDocument,
  type BinaryNinjaPage,
} from "./BinaryNinjaProtocolValues.js";

/** Drain producer pages with the same progress and consistency checks at every call site. */
export const drainBinaryNinjaPages = async (
  tool: string,
  read: (offset: number, limit: number) => Promise<BinaryNinjaDocument>,
  consume: (document: BinaryNinjaDocument, page: BinaryNinjaPage) => void,
): Promise<void> => {
  let offset = 0;
  let total: number | undefined;
  for (;;) {
    const document = await read(offset, 1000);
    const page = binaryNinjaPageSchema.parse(document.metadata);
    if (page.offset !== offset)
      throw new AnalysisProtocolError(
        `Binary Ninja ${tool} answered offset ${String(page.offset)} for a request at ${String(offset)}.`,
      );
    if (total !== undefined && page.total !== total)
      throw new AnalysisProtocolError(
        `Binary Ninja ${tool} changed its total while paging; retry after analysis settles.`,
      );
    total = page.total;
    if (page.nextOffset !== null && page.nextOffset <= offset)
      throw new AnalysisProtocolError(
        `Binary Ninja ${tool} pagination did not advance.`,
      );
    consume(document, page);
    if (page.nextOffset === null) return;
    offset = page.nextOffset;
  }
};
