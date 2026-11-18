#if defined(__APPLE__)
.section __TEXT,__text,regular,pure_instructions
.globl _rea_masked_byte_switch
_rea_masked_byte_switch:
#else
.text
.globl rea_masked_byte_switch
.type rea_masked_byte_switch,%function
rea_masked_byte_switch:
#endif
  and x8, x0, #0xff
#if defined(__APPLE__)
  adrp x9, Lmasked_table@PAGE
  add x9, x9, Lmasked_table@PAGEOFF
#else
  adrp x9, Lmasked_table
  add x9, x9, :lo12:Lmasked_table
#endif
  adr x10, Lmasked_case0
  ldrb w11, [x9, x8]
  add x10, x10, x11, lsl #2
  br x10
Lmasked_case0:
  mov w0, #200
  ret
Lmasked_case1:
  mov w0, #201
  ret
Lmasked_case2:
  mov w0, #202
  ret
Lmasked_case3:
  mov w0, #203
  ret
Lmasked_case4:
  mov w0, #204
  ret
Lmasked_case5:
  mov w0, #205
  ret
Lmasked_case6:
  mov w0, #206
  ret
Lmasked_case7:
  mov w0, #207
  ret
#if defined(__APPLE__)
.section __TEXT,__const
#else
.section .rodata
#endif
.p2align 1
Lmasked_table:
  .byte 0, 2, 4, 6, 8, 10, 12, 14
