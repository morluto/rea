/**
 * Source-owned ARM M-profile raw images; no third-party firmware and no
 * target execution. The Cortex-M0 image comes from #4927 by Jean Granié.
 *
 * Each image starts with an M-profile vector table: the initial stack pointer
 * in word 0 and the Reset handler, with bit 0 set for Thumb state, in word 1.
 * Only the vector words and absolute data pointers vary with the load base.
 * `source` is the code from offset `codeOffset`, which the verifier assembles
 * with LLVM for `triple` and compares with these bytes.
 */

const CORTEX_M0_CODE =
  "10b5072000f007f80a2802d10349086810bd002010bd03307047c046";

/**
 * Image offsets:
 *   00 initial stack pointer, 04 odd reset vector, 08..3f reserved vectors
 *   40 push {r4,lr}; movs r0,#7; bl add_three; cmp r0,#10; bne mismatch
 *   4c ldr r1,literal; ldr r0,[r1]; pop {r4,pc}
 *   52 mismatch: movs r0,#0; pop {r4,pc}
 *   56 add_three: adds r0,#3; bx lr
 *   5a fill 0x46c0 (the mov r8,r8 encoding), declared as data because no flow
 *      reaches it; 5c absolute pointer, 60 payload 42
 */
export const cortexM0Fixture = (base, prefix = 0) => {
  const bytes = Buffer.alloc(prefix + 100);
  bytes.writeUInt32LE(0x20001000, prefix);
  bytes.writeUInt32LE(base + prefix + 0x41, prefix + 4);
  Buffer.from(CORTEX_M0_CODE, "hex").copy(bytes, prefix + 0x40);
  bytes.writeUInt32LE(base + prefix + 0x60, prefix + 0x5c);
  bytes.writeUInt32LE(42, prefix + 0x60);
  return bytes;
};

export const CORTEX_M0_SOURCE = {
  triple: "thumbv6m-none-eabi",
  codeOffset: 0x40,
  code: CORTEX_M0_CODE,
  source: `
  .syntax unified
  .thumb
  .text
  push {r4, lr}
  movs r0, #7
  bl add_three
  cmp r0, #10
  bne mismatch
  ldr r1, literal
  ldr r0, [r1]
  pop {r4, pc}
mismatch:
  movs r0, #0
  pop {r4, pc}
add_three:
  adds r0, #3
  bx lr
  .short 0x46c0
literal:
`,
};

/** A vector table with its stack pointer and Reset at 0x41, then code at 0x40. */
const codeImage = (base, stackPointer, code, size) => {
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(stackPointer, 0);
  bytes.writeUInt32LE(base + 0x41, 4);
  Buffer.from(code, "hex").copy(bytes, 0x40);
  return bytes;
};

const V8M_MSPLIM_CODE = "41f20000c2f2000080f30a887047";

/**
 * Image offsets:
 *   00 initial stack pointer, 04 odd reset vector, 08..3f reserved vectors
 *   40 movw r0,#0x1000; 44 movt r0,#0x2000; 48 msr MSPLIM,r0; 4c bx lr
 * MSPLIM exists only from ARMv8-M, so the v7-M decoder cannot name it.
 */
export const v8mMsplimFixture = (base) =>
  codeImage(base, 0x20002000, V8M_MSPLIM_CODE, 0x50);

export const V8M_MSPLIM_SOURCE = {
  triple: "thumbv8m.main-none-eabi",
  codeOffset: 0x40,
  code: V8M_MSPLIM_CODE,
  source: `
  .syntax unified
  .thumb
  .text
  movw r0, #0x1000
  movt r0, #0x2000
  msr MSPLIM, r0
  bx lr
`,
};

const THUMB2_CODE = "45f27860c1f23420d0f80011002908bf012102b1891808467047";

/**
 * Image offsets:
 *   00 initial stack pointer, 04 odd reset vector, 08..3f reserved vectors
 *   40 movw r0,#0x5678; 44 movt r0,#0x1234; 48 ldr.w r1,[r0,#0x100]
 *   4c cmp r1,#0; 4e it eq; 50 moveq r1,#1; 52 cbz r2,skip; 54 adds r1,r1,r2
 *   56 skip: mov r0,r1; 58 bx lr
 * The 32-bit encodings, IT and CBZ are Thumb-2, which ARMv6-M lacks; the same
 * bytes are ARMv7-M and ARMv7E-M code.
 */
export const thumb2Fixture = (base) =>
  codeImage(base, 0x20003000, THUMB2_CODE, 0x60);

export const THUMB2_SOURCE = {
  triple: "thumbv7m-none-eabi",
  codeOffset: 0x40,
  code: THUMB2_CODE,
  source: `
  .syntax unified
  .thumb
  .text
  movw r0, #0x5678
  movt r0, #0x1234
  ldr.w r1, [r0, #0x100]
  cmp r1, #0
  it eq
  moveq r1, #1
  cbz r2, skip
  adds r1, r1, r2
skip:
  mov r0, r1
  bx lr
`,
};

const V8M_BASELINE_CODE = "41f20000c2f2000009b1b0fbf1f07047";

/**
 * Image offsets:
 *   00 initial stack pointer, 04 odd reset vector, 08..3f reserved vectors
 *   40 movw r0,#0x1000; 44 movt r0,#0x2000; 48 cbz r1,done
 *   4a udiv r0,r0,r1; 4e done: bx lr
 * ARMv8-M Baseline adds these encodings to ARMv6-M; it has no IT or LDR.W.
 */
export const v8mBaselineFixture = (base) =>
  codeImage(base, 0x20004000, V8M_BASELINE_CODE, 0x50);

export const V8M_BASELINE_SOURCE = {
  triple: "thumbv8m.base-none-eabi",
  codeOffset: 0x40,
  code: V8M_BASELINE_CODE,
  source: `
  .syntax unified
  .thumb
  .text
  movw r0, #0x1000
  movt r0, #0x2000
  cbz r1, done
  udiv r0, r0, r1
done:
  bx lr
`,
};

const CORTEX_M55_CODE =
  "10b50020042141f009c892ed001f21f001e883ed001f01300ff009c810bd";

/**
 * Image offsets:
 *   00 initial stack pointer, 04 odd reset vector, 08..3f reserved vectors
 *   40 push {r4,lr}; 42 movs r0,#0; 44 movs r1,#4; 46 wls lr,r1,done
 *   4a loop: vldrw.u32 q0,[r2]; 4e vctp.32 r1; 52 vstrw.32 q0,[r3]
 *   56 adds r0,#1; 58 le lr,loop; 5c done: pop {r4,pc}
 * The WLS/LE low-overhead loop exists only from ARMv8.1-M, and the MVE load,
 * store and VCTP only with its M-profile Vector Extension, as on Cortex-M55.
 * MVE builds use the hard-float ABI; clang 19 refuses MVE without it.
 */
export const cortexM55Fixture = (base) =>
  codeImage(base, 0x20005000, CORTEX_M55_CODE, 0x60);

export const CORTEX_M55_SOURCE = {
  triple: "thumbv8.1m.main-none-eabi",
  cpu: "cortex-m55",
  floatAbi: "hard",
  codeOffset: 0x40,
  code: CORTEX_M55_CODE,
  source: `
  .syntax unified
  .thumb
  .text
  push {r4, lr}
  movs r0, #0
  movs r1, #4
  wls lr, r1, done
loop:
  vldrw.u32 q0, [r2]
  vctp.32 r1
  vstrw.32 q0, [r3]
  adds r0, #1
  le lr, loop
done:
  pop {r4, pc}
`,
};
