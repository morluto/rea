/**
 * Microsoft PE Rich Header parser.
 * Extracts compiler, linker, and build tool telemetry encrypted between DOS stub and PE header.
 */

import { BinaryReader } from "../../domain/binaryContainer.js";

export interface PeRichRecord {
  readonly prodId: number;
  readonly buildNumber: number;
  readonly count: number;
  readonly toolName?: string | undefined;
  readonly vsVersion?: string | undefined;
}

export interface PeRichHeader {
  readonly xorKey: number;
  readonly offset: number;
  readonly length: number;
  readonly records: readonly PeRichRecord[];
}

const RICH_MAGIC = 0x68636952; // "Rich" in LE
const DANS_MAGIC = 0x536e6144; // "DanS" in LE

/** Known Microsoft Product IDs mapped to Visual Studio releases and tool names. */
const PROD_ID_TOOLS: Readonly<Record<number, { name: string; vs: string }>> = {
  0x0001: { name: "Import0", vs: "Unknown" },
  0x0002: { name: "Linker", vs: "VS 97" },
  0x0003: { name: "Cvtres", vs: "VS 97" },
  0x0004: { name: "Utc_C", vs: "VS 97" },
  0x0005: { name: "Utc_CPP", vs: "VS 97" },
  0x0006: { name: "Masmin", vs: "VS 97" },

  // VS 6.0
  0x0014: { name: "Utc1200_C", vs: "VS 6.0" },
  0x0015: { name: "Utc1200_CPP", vs: "VS 6.0" },
  0x0019: { name: "Linker1200", vs: "VS 6.0" },

  // VS 2005 (14.00)
  0x004d: { name: "Utc1400_C", vs: "VS 2005" },
  0x004e: { name: "Utc1400_CPP", vs: "VS 2005" },
  0x0050: { name: "Linker1400", vs: "VS 2005" },

  // VS 2008 (15.00)
  0x005c: { name: "Utc1500_C", vs: "VS 2008" },
  0x005d: { name: "Utc1500_CPP", vs: "VS 2008" },
  0x005f: { name: "Linker1500", vs: "VS 2008" },

  // VS 2010 (16.00)
  0x006d: { name: "Utc1600_C", vs: "VS 2010" },
  0x006e: { name: "Utc1600_CPP", vs: "VS 2010" },
  0x0070: { name: "Linker1600", vs: "VS 2010" },

  // VS 2012 (17.00)
  0x007b: { name: "Utc1700_C", vs: "VS 2012" },
  0x007c: { name: "Utc1700_CPP", vs: "VS 2012" },
  0x007e: { name: "Linker1700", vs: "VS 2012" },

  // VS 2013 (18.00)
  0x0089: { name: "Utc1800_C", vs: "VS 2013" },
  0x008a: { name: "Utc1800_CPP", vs: "VS 2013" },
  0x008c: { name: "Linker1800", vs: "VS 2013" },

  // VS 2015 (19.00)
  0x0093: { name: "Utc1900_C", vs: "VS 2015" },
  0x0094: { name: "Utc1900_CPP", vs: "VS 2015" },
  0x0096: { name: "Linker1900", vs: "VS 2015" },

  // VS 2017 (19.10 - 19.16)
  0x00aa: { name: "Utc1910_C", vs: "VS 2017" },
  0x00ab: { name: "Utc1910_CPP", vs: "VS 2017" },
  0x00ad: { name: "Linker1910", vs: "VS 2017" },

  // VS 2019 (19.20 - 19.29)
  0x0103: { name: "Utc1920_C", vs: "VS 2019" },
  0x0104: { name: "Utc1920_CPP", vs: "VS 2019" },
  0x0106: { name: "Linker1920", vs: "VS 2019" },

  // VS 2022 (19.30 - 19.40+)
  0x010a: { name: "Utc1930_C", vs: "VS 2022" },
  0x010b: { name: "Utc1930_CPP", vs: "VS 2022" },
  0x010d: { name: "Linker1930", vs: "VS 2022" },
};

/** Scan buffer for Microsoft DanS/Rich header structure. */
export const parsePeRichHeader = (buffer: Buffer): PeRichHeader | null => {
  if (buffer.length < 128) return null;
  const reader = new BinaryReader(buffer, true, "pe");

  // e_lfanew offset is at 0x3c
  const peOffset = reader.u32(0x3c);
  if (peOffset < 64 || peOffset > buffer.length) return null;

  // Search for "Rich" marker before peOffset
  let richOffset = -1;
  for (let offset = 0x40; offset <= peOffset - 8; offset += 4) {
    if (reader.u32(offset) === RICH_MAGIC) {
      richOffset = offset;
      break;
    }
  }

  if (richOffset === -1 || richOffset + 8 > buffer.length) return null;

  const xorKey = reader.u32(richOffset + 4);

  // Search backwards for decrypted "DanS" marker
  let dansOffset = -1;
  for (let offset = richOffset - 4; offset >= 0x40; offset -= 4) {
    const decrypted = (reader.u32(offset) ^ xorKey) >>> 0;
    if (decrypted === DANS_MAGIC) {
      dansOffset = offset;
      break;
    }
  }

  if (dansOffset === -1 || dansOffset + 16 > richOffset) return null;
  const recordsByteLength = richOffset - (dansOffset + 16);
  if (recordsByteLength % 8 !== 0) return null;

  // Decrypt and parse 8-byte tool records (skipping 16 bytes: DanS + 3 padding DWORDs)
  const records: PeRichRecord[] = [];
  for (let offset = dansOffset + 16; offset < richOffset; offset += 8) {
    const dword1 = (reader.u32(offset) ^ xorKey) >>> 0;
    const count = (reader.u32(offset + 4) ^ xorKey) >>> 0;

    const prodId = (dword1 >>> 16) & 0xffff;
    const buildNumber = dword1 & 0xffff;

    const knownTool = PROD_ID_TOOLS[prodId];
    records.push({
      prodId,
      buildNumber,
      count,
      toolName: knownTool?.name,
      vsVersion: knownTool?.vs,
    });
  }

  return {
    xorKey,
    offset: dansOffset,
    length: richOffset + 8 - dansOffset,
    records,
  };
};
