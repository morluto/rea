import { gzipSync } from "node:zlib";

const concat = (...parts: readonly Buffer[]): Buffer => Buffer.concat(parts);

/** Banner with a nested compiler parenthesis, terminated by the caller. */
export const SAMPLE_KERNEL_BANNER =
  "Linux version 6.6.0 (build@host) (gcc (Debian 12.2.0-14) 12.2.0, GNU ld (GNU Binutils for Debian) 2.40) #1 SMP";

/** Config text accepted by the strict IKCFG grammar. */
export const SAMPLE_KERNEL_CONFIG = [
  "#",
  "# Linux/arm64 6.6.0 Kernel Configuration",
  "#",
  "CONFIG_SECURITY_SELINUX=y",
  "CONFIG_STACKPROTECTOR=y",
  "CONFIG_MODULE_SIG=m",
  'CONFIG_LOCALVERSION=""',
  'CONFIG_DEFAULT_HOSTNAME="(none)"',
  'CONFIG_CMDLINE="console=ttyS0 \\"debug\\""',
  "CONFIG_HZ=250",
  "CONFIG_PAGE_OFFSET=0xC0000000",
  "# CONFIG_MODULE_SIG_FORCE is not set",
  "",
].join("\n");

/** `IKCFG_ST` + gzip member + `IKCFG_ED` for the sample config. */
export const embeddedKernelConfig = (
  text: string = SAMPLE_KERNEL_CONFIG,
): Buffer =>
  concat(
    Buffer.from("IKCFG_ST"),
    gzipSync(Buffer.from(text, "latin1")),
    Buffer.from("IKCFG_ED"),
  );

const elfPrefix = (): Buffer => {
  const header = Buffer.alloc(64);
  header[0] = 0x7f;
  header[1] = 0x45;
  header[2] = 0x4c;
  header[3] = 0x46;
  header[4] = 2;
  header[5] = 1;
  return header;
};

/**
 * Synthetic ELF whose file bytes contain a decoy `IKCFG_ST` string, the sample
 * banner, and a real gzip config. The decoy is the #5715 false-positive shape.
 */
export const kernelBuildConfigFixture = (): Buffer =>
  concat(
    elfPrefix(),
    Buffer.from(`${SAMPLE_KERNEL_BANNER}\0`, "latin1"),
    Buffer.from("IKCFG_ST not a gzip member\0", "latin1"),
    embeddedKernelConfig(),
  );

/** ELF with a banner and an `IKCFG_ST` string that is not a gzip member. */
export const plainIkcfgStringFixture = (): Buffer =>
  concat(
    elfPrefix(),
    Buffer.from(`${SAMPLE_KERNEL_BANNER}\0`, "latin1"),
    Buffer.from("ordinary IKCFG_ST string without gzip\0", "latin1"),
  );

/** ELF whose `IKCFG_ST` is followed by a gzip header that ends early. */
export const truncatedKernelConfigFixture = (): Buffer => {
  const member = gzipSync(Buffer.from(SAMPLE_KERNEL_CONFIG, "latin1"));
  return concat(
    elfPrefix(),
    Buffer.from(`${SAMPLE_KERNEL_BANNER}\0`, "latin1"),
    Buffer.from("IKCFG_ST"),
    member.subarray(0, 12),
  );
};

/** ELF whose IKCFG member has trailing bytes before IKCFG_ED. */
export const trailingBytesKernelConfigFixture = (): Buffer =>
  concat(
    elfPrefix(),
    Buffer.from("IKCFG_ST"),
    gzipSync(Buffer.from(SAMPLE_KERNEL_CONFIG, "latin1")),
    Buffer.from("junk"),
    Buffer.from("IKCFG_ED"),
  );

/** ELF whose IKCFG member inflates to text that is not a `.config`. */
export const nonConfigGzipFixture = (): Buffer =>
  concat(
    elfPrefix(),
    Buffer.from("IKCFG_ST"),
    gzipSync(Buffer.from("hello world\n", "latin1")),
    Buffer.from("IKCFG_ED"),
  );

/** ELF whose framed IKCFG member inflates but carries a wrong CRC-32. */
export const badCrcKernelConfigFixture = (): Buffer => {
  const member = gzipSync(Buffer.from(SAMPLE_KERNEL_CONFIG, "latin1"));
  const crc = member.length - 8;
  member.writeUInt32LE((member.readUInt32LE(crc) ^ 0xffffffff) >>> 0, crc);
  return concat(
    elfPrefix(),
    Buffer.from("IKCFG_ST"),
    member,
    Buffer.from("IKCFG_ED"),
  );
};

export interface BzImageFixtureOptions {
  readonly version?: number;
  readonly payloadOffset?: number;
  readonly decoyBanner?: string;
}

/** x86 setup header (`HdrS`) with `payload_offset` / `payload_length`. */
export const bzImageFixture = (
  payload: Buffer,
  options: BzImageFixtureOptions = {},
): Buffer => {
  const setupSects = 4;
  const setupSize = (setupSects + 1) * 512;
  const payloadOffset = options.payloadOffset ?? 16;
  const fileOffset = setupSize + payloadOffset;
  const image = Buffer.alloc(fileOffset + payload.length);
  image[0x1f1] = setupSects;
  image.write("HdrS", 0x202, "latin1");
  image.writeUInt16LE(options.version ?? 0x0208, 0x206);
  image.writeUInt32LE(payloadOffset, 0x248);
  image.writeUInt32LE(payload.length, 0x24c);
  if (options.decoyBanner !== undefined)
    image.write(options.decoyBanner, 0x300, "latin1");
  payload.copy(image, fileOffset);
  return image;
};

const searchedPayload = (): Buffer =>
  concat(
    Buffer.from(`${SAMPLE_KERNEL_BANNER}\0`, "latin1"),
    embeddedKernelConfig(),
  );

/**
 * A gzip member followed by unrelated bytes inside the payload. Kbuild relies
 * on gzip's own ISIZE trailer and appends no size field for gzip, but bytes
 * after the member must still be tolerated.
 */
const withTrailingBytes = (plain: Buffer): Buffer =>
  concat(gzipSync(plain), Buffer.from([0xde, 0xad, 0xbe, 0xef]));

/** bzImage whose gzip payload carries the sample banner and config. */
export const bzImageGzipFixture = (): Buffer =>
  bzImageFixture(withTrailingBytes(searchedPayload()), {
    decoyBanner: "Linux version 1.0.0 (decoy@setup) (gcc) #0\n",
  });

/** bzImage whose gzip payload is cut short inside the deflate stream. */
export const bzImageTruncatedGzipFixture = (): Buffer =>
  bzImageFixture(gzipSync(searchedPayload()).subarray(0, 24));

/** bzImage whose payload starts with the xz magic and is not inflated. */
export const bzImageXzFixture = (): Buffer =>
  bzImageFixture(
    concat(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), Buffer.alloc(8)),
  );
