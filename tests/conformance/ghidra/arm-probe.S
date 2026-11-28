/* Source-owned ARM- and Thumb-2-mode instructions with fixed, reviewable
 * encodings, including a genuine interworking call: the ARM probe branches
 * into the Thumb probe and back. No target execution.
 */
.syntax unified
.arch armv7a
.arm
.text
.p2align 2
.globl rea_arm_probe_arm
.type rea_arm_probe_arm, %function
rea_arm_probe_arm:
    mov r0, #42
    push {r4, lr}
    bl rea_arm_probe_thumb
    pop {r4, pc}

.thumb
.p2align 1
.globl rea_arm_probe_thumb
.type rea_arm_probe_thumb, %function
.thumb_func
rea_arm_probe_thumb:
    movw r0, #0x1234
    movt r0, #0x5678
    bx lr
.section .note.GNU-stack,"",%progbits
