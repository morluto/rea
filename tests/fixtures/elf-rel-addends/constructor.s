.section .text
.byte 0x90
.globl marker
.type marker, @function
marker:
.byte 0xc3, 0x90
.size marker, .-marker
.section .init_array,"aw",@init_array
.long marker-1
.long marker+1
.long marker
.section .note.GNU-stack,"",@progbits
