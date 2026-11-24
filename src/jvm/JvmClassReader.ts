import { isJvmClassFile } from "../domain/apple/jvmClassFile.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import {
  malformedInput,
  truncatedInput,
  unsupportedInput,
} from "../domain/parseFailure.js";

/**
 * Pure TypeScript Java Class (.class) byte format analyzer.
 * Parses constant pool, access flags, interfaces, fields, methods, and attributes.
 */

export interface JvmMember {
  readonly name: string;
  readonly descriptor: string;
  readonly accessFlags: readonly string[];
  readonly codeLength?: number | undefined;
}

export interface JvmClassReport {
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly javaVersion: string;
  readonly thisClass: string;
  readonly superClass: string | null;
  readonly accessFlags: readonly string[];
  readonly interfaces: readonly string[];
  readonly fields: readonly JvmMember[];
  readonly methods: readonly JvmMember[];
  readonly sourceFile?: string | undefined;
}

const JAVA_VERSIONS: Readonly<Record<number, string>> = {
  45: "Java 1.1",
  46: "Java 1.2",
  47: "Java 1.3",
  48: "Java 1.4",
  49: "Java 5",
  50: "Java 6",
  51: "Java 7",
  52: "Java 8",
  53: "Java 9",
  54: "Java 10",
  55: "Java 11",
  56: "Java 12",
  57: "Java 13",
  58: "Java 14",
  59: "Java 15",
  60: "Java 16",
  61: "Java 17 (LTS)",
  62: "Java 18",
  63: "Java 19",
  64: "Java 20",
  65: "Java 21 (LTS)",
  66: "Java 22",
  67: "Java 23",
};

export const resolveJavaRelease = (majorVersion: number): string => {
  return JAVA_VERSIONS[majorVersion] ?? `Java (class format ${majorVersion})`;
};

export const decodeModifiedUtf8 = (bytes: Uint8Array): string => {
  let result = "";
  let i = 0;
  const len = bytes.length;
  while (i < len) {
    const b1 = bytes[i++]!;
    if ((b1 & 0x80) === 0) {
      result += String.fromCharCode(b1);
    } else if ((b1 & 0xe0) === 0xc0) {
      if (i >= len)
        throw truncatedInput("jvm-class", "Truncated modified UTF-8 sequence");
      const b2 = bytes[i++]!;
      const code = ((b1 & 0x1f) << 6) | (b2 & 0x3f);
      result += String.fromCharCode(code);
    } else if ((b1 & 0xf0) === 0xe0) {
      if (i + 1 >= len)
        throw truncatedInput("jvm-class", "Truncated modified UTF-8 sequence");
      const b2 = bytes[i++]!;
      const b3 = bytes[i++]!;
      const code = ((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      result += String.fromCharCode(code);
    } else if ((b1 & 0xf8) === 0xf0) {
      if (i + 2 >= len)
        throw truncatedInput("jvm-class", "Truncated UTF-8 sequence");
      const b2 = bytes[i++]!;
      const b3 = bytes[i++]!;
      const b4 = bytes[i++]!;
      const cp =
        ((b1 & 0x07) << 18) |
        ((b2 & 0x3f) << 12) |
        ((b3 & 0x3f) << 6) |
        (b4 & 0x3f);
      result += String.fromCodePoint(cp);
    } else {
      throw malformedInput(
        "jvm-class",
        `Invalid modified UTF-8 byte: 0x${b1.toString(16)}`,
      );
    }
  }
  return result;
};

export const decodeAccessFlags = (
  flags: number,
  kind: "class" | "field" | "method",
): string[] => {
  const result: string[] = [];
  if ((flags & 0x0001) !== 0) result.push("public");
  if ((flags & 0x0002) !== 0) result.push("private");
  if ((flags & 0x0004) !== 0) result.push("protected");
  if ((flags & 0x0008) !== 0) result.push("static");
  if ((flags & 0x0010) !== 0) result.push("final");
  if (kind === "class" && (flags & 0x0020) !== 0) result.push("super");
  if (kind === "method" && (flags & 0x0020) !== 0) result.push("synchronized");
  if (kind === "field" && (flags & 0x0040) !== 0) result.push("volatile");
  if (kind === "method" && (flags & 0x0040) !== 0) result.push("bridge");
  if (kind === "field" && (flags & 0x0080) !== 0) result.push("transient");
  if (kind === "method" && (flags & 0x0080) !== 0) result.push("varargs");
  if (kind === "method" && (flags & 0x0100) !== 0) result.push("native");
  if (kind === "class" && (flags & 0x0200) !== 0) result.push("interface");
  if ((flags & 0x0400) !== 0) result.push("abstract");
  if (kind === "method" && (flags & 0x0800) !== 0) result.push("strictfp");
  if ((flags & 0x1000) !== 0) result.push("synthetic");
  if (kind === "class" && (flags & 0x2000) !== 0) result.push("annotation");
  if ((flags & 0x4000) !== 0) result.push("enum");
  return result;
};

class ClassByteCursor {
  private offset = 0;
  private readonly reader: BinaryReader;

  constructor(private readonly bytes: Uint8Array) {
    const view = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.reader = new BinaryReader(view, false, "jvm-class");
  }

  get position(): number {
    return this.offset;
  }

  has(n: number): boolean {
    return n >= 0 && this.offset + n <= this.bytes.byteLength;
  }

  u1(): number {
    const val = this.reader.u8(this.offset);
    this.offset += 1;
    return val;
  }

  u2(): number {
    const val = this.reader.u16(this.offset);
    this.offset += 2;
    return val;
  }

  u4(): number {
    const val = this.reader.u32(this.offset);
    this.offset += 4;
    return val;
  }

  bytesSlice(len: number): Uint8Array {
    const slice = this.reader.range(this.offset, len, "JVM class bytes");
    this.offset += len;
    return slice;
  }

  skip(len: number): void {
    this.reader.range(this.offset, len, "JVM class structure");
    this.offset += len;
  }
}

interface ConstantPoolMap {
  hasUtf8(index: number): boolean;
  utf8(index: number): string;
  className(index: number): string;
}

const parseConstantPool = (
  cursor: ClassByteCursor,
  count: number,
): ConstantPoolMap => {
  const pool = new Map<number, unknown>();

  for (let i = 1; i < count; i += 1) {
    const tag = cursor.u1();
    if (tag === 1) {
      // UTF-8
      const len = cursor.u2();
      const raw = cursor.bytesSlice(len);
      pool.set(i, decodeModifiedUtf8(raw));
    } else if (tag === 3 || tag === 4) {
      // Integer, Float
      cursor.skip(4);
    } else if (tag === 5 || tag === 6) {
      // Long, Double
      cursor.skip(8);
      i += 1; // Long and double take two pool entries
    } else if (tag === 7) {
      // Class
      const nameIndex = cursor.u2();
      pool.set(i, { type: "class", nameIndex });
    } else if (tag === 8) {
      // String
      cursor.skip(2);
    } else if (tag === 9 || tag === 10 || tag === 11 || tag === 12) {
      // Fieldref, Methodref, InterfaceMethodref, NameAndType
      cursor.skip(4);
    } else if (tag === 15) {
      // MethodHandle
      cursor.skip(3);
    } else if (tag === 16 || tag === 19 || tag === 20) {
      // MethodType, Module, Package
      cursor.skip(2);
    } else if (tag === 17 || tag === 18) {
      // Dynamic, InvokeDynamic
      cursor.skip(4);
    } else {
      throw unsupportedInput(
        "jvm-class",
        `Unsupported constant-pool tag: ${tag}`,
      );
    }
  }

  return {
    hasUtf8: (idx: number) => typeof pool.get(idx) === "string",
    utf8: (idx: number) => {
      const val = pool.get(idx);
      return typeof val === "string" ? val : "";
    },
    className: (idx: number) => {
      const val = pool.get(idx);
      if (val && typeof val === "object" && "nameIndex" in val) {
        const nameIdx = Number((val as { nameIndex: number }).nameIndex);
        const name = pool.get(nameIdx);
        return typeof name === "string" ? name : "";
      }
      return "";
    },
  };
};

/** Validate a JVMS §4.7.3 Code_attribute layout before reporting code_length. */
const parseCodeAttributeLength = (
  cursor: ClassByteCursor,
  pool: ConstantPoolMap,
  attrLen: number,
): number => {
  // Minimum Code_attribute: max_stack(2) + max_locals(2) + code_length(4)
  // + exception_table_length(2) + attributes_count(2) = 12 bytes.
  if (attrLen < 12) {
    throw malformedInput(
      "jvm-class",
      "Code attribute is shorter than its fixed 12-byte header",
    );
  }
  const attrEnd = cursor.position + attrLen;
  cursor.skip(4); // max_stack (u2) + max_locals (u2)
  const codeLength = cursor.u4();
  // Require space for code bytes plus exception_table_length (u2) and attributes_count (u2).
  if (codeLength > attrEnd - cursor.position - 4) {
    throw malformedInput(
      "jvm-class",
      "Code attribute code_length exceeds attribute extent",
    );
  }
  cursor.skip(codeLength);
  const exceptionTableLength = cursor.u2();
  const exceptionTableBytes = exceptionTableLength * 8;
  if (exceptionTableBytes > attrEnd - cursor.position - 2) {
    throw malformedInput(
      "jvm-class",
      "Code attribute exception_table exceeds attribute extent",
    );
  }
  cursor.skip(exceptionTableBytes);
  const nestedAttrCount = cursor.u2();
  for (let i = 0; i < nestedAttrCount; i += 1) {
    if (cursor.position + 6 > attrEnd) {
      throw truncatedInput(
        "jvm-class",
        "Truncated nested attribute header inside Code attribute",
      );
    }
    const nestedNameIdx = cursor.u2();
    const nestedLen = cursor.u4();
    if (!pool.hasUtf8(nestedNameIdx) || nestedLen > attrEnd - cursor.position) {
      throw malformedInput(
        "jvm-class",
        "Malformed nested attribute inside Code attribute",
      );
    }
    cursor.skip(nestedLen);
  }
  if (cursor.position !== attrEnd) {
    throw malformedInput(
      "jvm-class",
      "Code attribute contains trailing bytes past its declared layout",
    );
  }
  return codeLength;
};

const parseMembers = (
  cursor: ClassByteCursor,
  pool: ConstantPoolMap,
  kind: "field" | "method",
): JvmMember[] => {
  const count = cursor.u2();
  const members: JvmMember[] = [];

  for (let i = 0; i < count; i += 1) {
    const accessFlags = decodeAccessFlags(cursor.u2(), kind);
    const name = pool.utf8(cursor.u2());
    const descriptor = pool.utf8(cursor.u2());
    const attrCount = cursor.u2();

    let codeLength: number | undefined;
    for (let a = 0; a < attrCount; a += 1) {
      const attrName = pool.utf8(cursor.u2());
      const attrLen = cursor.u4();
      if (kind === "method" && attrName === "Code") {
        codeLength = parseCodeAttributeLength(cursor, pool, attrLen);
      } else {
        cursor.skip(attrLen);
      }
    }

    members.push({ name, descriptor, accessFlags, codeLength });
  }

  return members;
};

/** Parse Java .class bytes into structured class metadata. */
export const parseJvmClass = (bytes: Uint8Array): JvmClassReport | null => {
  if (!isJvmClassFile(bytes)) return null;

  try {
    const cursor = new ClassByteCursor(bytes);
    const magic = cursor.u4();
    if (magic !== 0xcafebabe) return null;

    const minorVersion = cursor.u2();
    const majorVersion = cursor.u2();
    const cpCount = cursor.u2();

    const pool = parseConstantPool(cursor, cpCount);

    const accessFlags = decodeAccessFlags(cursor.u2(), "class");
    const thisClass = pool.className(cursor.u2());
    const superIdx = cursor.u2();
    const superClass = superIdx > 0 ? pool.className(superIdx) : null;

    const ifaceCount = cursor.u2();
    const interfaces: string[] = [];
    for (let i = 0; i < ifaceCount; i += 1) {
      interfaces.push(pool.className(cursor.u2()));
    }

    const fields = parseMembers(cursor, pool, "field");
    const methods = parseMembers(cursor, pool, "method");

    // Attributes
    const attrCount = cursor.u2();
    let sourceFile: string | undefined;
    for (let i = 0; i < attrCount; i += 1) {
      const attrName = pool.utf8(cursor.u2());
      const attrLen = cursor.u4();
      if (attrName === "SourceFile" && attrLen === 2) {
        sourceFile = pool.utf8(cursor.u2());
      } else {
        cursor.skip(attrLen);
      }
    }

    return {
      majorVersion,
      minorVersion,
      javaVersion: resolveJavaRelease(majorVersion),
      thisClass,
      superClass,
      accessFlags,
      interfaces,
      fields,
      methods,
      sourceFile,
    };
  } catch {
    return null;
  }
};
