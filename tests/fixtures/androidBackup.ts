import { deflateSync } from "node:zlib";

export interface BackupFixtureMember {
  readonly path: string;
  readonly data?: string | Buffer;
  readonly type?: string;
  readonly prefix?: string;
  readonly mode?: number;
}

export const tarChecksum = (header: Buffer): void => {
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
};

export const backupTar = (members: readonly BackupFixtureMember[]): Buffer => {
  const chunks: Buffer[] = [];
  for (const member of members) {
    const header = Buffer.alloc(512);
    const data = Buffer.from(member.data ?? "");
    header.write(member.path, 0, 100, "utf8");
    header.write(
      `${(member.mode ?? 0o600).toString(8).padStart(7, "0")}\0`,
      100,
      "ascii",
    );
    header.write(
      `${data.length.toString(8).padStart(11, "0")}\0`,
      124,
      "ascii",
    );
    header.write(member.type ?? "0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    if (member.prefix !== undefined)
      header.write(member.prefix, 345, 155, "utf8");
    tarChecksum(header);
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
};

export const backupImage = (
  tar: Buffer,
  options: {
    readonly compressed?: boolean;
    readonly version?: number;
    readonly encryption?: string;
  } = {},
): Buffer =>
  Buffer.concat([
    Buffer.from(
      `ANDROID BACKUP\n${String(options.version ?? 5)}\n${options.compressed ? "1" : "0"}\n${options.encryption ?? "none"}\n`,
    ),
    options.compressed ? deflateSync(tar) : tar,
  ]);

export const paxRecord = (key: string, value: string): string => {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length)
    length = String(length).length + Buffer.byteLength(body);
  return `${String(length)}${body}`;
};

/** Authored AES envelope fields and opaque bytes, without performing encryption. */
export const encryptedBackupImage = (): Buffer =>
  backupImage(
    Buffer.concat([
      Buffer.from(
        [
          "01".repeat(64),
          "02".repeat(64),
          "10000",
          "03".repeat(16),
          "04".repeat(96),
          "",
        ].join("\n"),
      ),
      Buffer.alloc(16, 0x75),
    ]),
    { encryption: "AES-256" },
  );
