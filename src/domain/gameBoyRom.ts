import { err, ok, type Result } from "./result.js";

export const GAME_BOY_HEADER_SIZE = 0x150;
export const GAME_BOY_BANK_SIZE = 0x4000;
const LOGO = Buffer.from(
  "ceed6666cc0d000b03730083000c000d0008111f8889000edccc6ee6ddddd999bbbb67636e0eecccdddc999fbbb9333e",
  "hex",
);
const MAPPERS = new Map<number, string>([
  [0x00, "ROM"],
  [0x08, "ROM+RAM"],
  [0x09, "ROM+RAM+BATTERY"],
  [0x01, "MBC1"],
  [0x02, "MBC1+RAM"],
  [0x03, "MBC1+RAM+BATTERY"],
  [0x05, "MBC2"],
  [0x06, "MBC2+BATTERY"],
  [0x0f, "MBC3+TIMER+BATTERY"],
  [0x10, "MBC3+TIMER+RAM+BATTERY"],
  [0x11, "MBC3"],
  [0x12, "MBC3+RAM"],
  [0x13, "MBC3+RAM+BATTERY"],
  [0x19, "MBC5"],
  [0x1a, "MBC5+RAM"],
  [0x1b, "MBC5+RAM+BATTERY"],
  [0x1c, "MBC5+RUMBLE"],
  [0x1d, "MBC5+RUMBLE+RAM"],
  [0x1e, "MBC5+RUMBLE+RAM+BATTERY"],
]);

/** Header declarations, not observed mapper state or proof of bootability. */
export interface GameBoyHeader {
  readonly title: string;
  readonly titleAreaHex: string;
  readonly cgbFlag: number;
  readonly cartridgeType: number;
  readonly mapper: string;
  readonly romBanks: number;
  readonly ramSizeCode: number;
  readonly logoMatches: boolean;
  readonly headerChecksumMatches: boolean;
  readonly declaredGlobalChecksum: number;
  readonly limitations: readonly string[];
}

/** Parse the fixed cartridge header without trusting a filename or executing the ROM. */
export const parseGameBoyHeader = (
  bytes: Buffer,
  fileSize: number,
): Result<GameBoyHeader, string> => {
  if (bytes.length < GAME_BOY_HEADER_SIZE)
    return err(
      "Game Boy cartridge header is truncated (requires 0x150 bytes); boot ROMs are not cartridge images",
    );
  const sizeCode = bytes.readUInt8(0x148);
  const romBanks =
    sizeCode <= 8
      ? 2 << sizeCode
      : ({ 0x52: 72, 0x53: 80, 0x54: 96 } as Record<number, number>)[sizeCode];
  if (romBanks === undefined)
    return err(`Unknown Game Boy ROM size code 0x${sizeCode.toString(16)}`);
  if (
    !Number.isSafeInteger(fileSize) ||
    fileSize !== romBanks * GAME_BOY_BANK_SIZE
  )
    return err(
      `Game Boy header declares ${romBanks} banks (${romBanks * GAME_BOY_BANK_SIZE} bytes), but the file has ${fileSize} bytes; truncated, padded, and copier-header images require a separately selected corrected artifact`,
    );
  const cartridgeType = bytes.readUInt8(0x147);
  const mapper = MAPPERS.get(cartridgeType);
  if (mapper === undefined)
    return err(
      `Unsupported Game Boy mapper 0x${cartridgeType.toString(16)}; this lane supports ROM, MBC1, MBC2, MBC3, and MBC5 cartridges`,
    );
  if ([0, 8, 9].includes(cartridgeType) && romBanks !== 2)
    return err(
      "Unbanked Game Boy cartridges must declare exactly two ROM banks",
    );
  const cgbFlag = bytes.readUInt8(0x143);
  const titleEnd = (cgbFlag & 0x80) !== 0 ? 0x143 : 0x144;
  const title = bytes
    .subarray(0x134, titleEnd)
    .toString("latin1")
    .replace(/\0.*$/su, "");
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i++)
    checksum = (checksum - bytes.readUInt8(i) - 1) & 0xff;
  const logoMatches = bytes.subarray(0x104, 0x134).equals(LOGO);
  const headerChecksumMatches = checksum === bytes.readUInt8(0x14d);
  return ok({
    title,
    titleAreaHex: bytes.subarray(0x134, 0x144).toString("hex"),
    cgbFlag,
    cartridgeType,
    mapper,
    romBanks,
    ramSizeCode: bytes.readUInt8(0x149),
    logoMatches,
    headerChecksumMatches,
    declaredGlobalChecksum: bytes.readUInt16BE(0x14e),
    limitations: [
      ...(!logoMatches
        ? [
            "The Nintendo logo bytes differ from the standard cartridge logo; bootability is unknown.",
          ]
        : []),
      ...(!headerChecksumMatches
        ? [
            "The cartridge header checksum does not match; bootability is unknown.",
          ]
        : []),
      "The declared global checksum is retained but not verified by header inspection.",
      ...((cgbFlag & 0x80) !== 0
        ? [
            "The CGB title/manufacturer area overlaps; the full raw area is retained without inferring a manufacturer code.",
          ]
        : []),
    ],
  });
};

/** Physical file banks: 0 and 1 form the initial analysis window; later banks use named overlays. */
export const gameBoyRomBanks = (header: GameBoyHeader) =>
  Array.from({ length: header.romBanks }, (_, bank) => ({
    bank,
    block: `ROM_${bank.toString(16).padStart(3, "0")}`,
    fileOffset: bank * GAME_BOY_BANK_SIZE,
    address: bank === 0 ? 0 : 0x4000,
    size: GAME_BOY_BANK_SIZE,
    overlay: bank > 1,
  }));
