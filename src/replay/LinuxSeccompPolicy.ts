import { createHash } from "node:crypto";

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;
const SECCOMP_RET_KILL_PROCESS = 0x8000_0000;
const SECCOMP_RET_ERRNO = 0x0005_0000 | 1;
const SECCOMP_RET_ALLOW = 0x7fff_0000;
const AUDIT_ARCH_X86_64 = 0xc000_003e;
const IOCTL = 16;
const TIOCSTI = 0x5412;

const DENIED_X86_64_SYSCALLS = [
  101, 103, 155, 161, 163, 165, 166, 167, 168, 169, 172, 173, 175, 176, 179,
  212, 246, 248, 249, 250, 272, 298, 303, 304, 308, 310, 311, 312, 313, 320,
  321, 323, 425, 426, 427, 428, 429, 430, 431, 432, 433, 442,
] as const;

interface Instruction {
  readonly code: number;
  readonly jt: number;
  readonly jf: number;
  readonly k: number;
}

/** Build the architecture-checked deny filter committed by ADR-0002. */
export const buildLinuxX64ReplaySeccomp = (): Uint8Array => {
  const instructions: Instruction[] = [
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 4 },
    { code: BPF_JMP_JEQ_K, jt: 1, jf: 0, k: AUDIT_ARCH_X86_64 },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_KILL_PROCESS },
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 0 },
  ];
  for (const syscall of DENIED_X86_64_SYSCALLS) {
    instructions.push({ code: BPF_JMP_JEQ_K, jt: 0, jf: 1, k: syscall });
    instructions.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ERRNO });
  }
  instructions.push(
    { code: BPF_JMP_JEQ_K, jt: 0, jf: 3, k: IOCTL },
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 24 },
    { code: BPF_JMP_JEQ_K, jt: 0, jf: 1, k: TIOCSTI },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ERRNO },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW },
  );
  const encoded = new Uint8Array(instructions.length * 8);
  const view = new DataView(encoded.buffer);
  instructions.forEach((instruction, index) => {
    const offset = index * 8;
    view.setUint16(offset, instruction.code, true);
    view.setUint8(offset + 2, instruction.jt);
    view.setUint8(offset + 3, instruction.jf);
    view.setUint32(offset + 4, instruction.k, true);
  });
  return encoded;
};

export const linuxX64ReplaySeccompDigest = (): string =>
  createHash("sha256").update(buildLinuxX64ReplaySeccomp()).digest("hex");
