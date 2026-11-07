# Fixed LoongArch instructions the verifier checks by mnemonic and bytes.
# addi.d a0, zero, 5   ; 02c01404
# addi.d a0, a0, 3     ; 02c00c84
# jr     ra            ; 4c000020 (Ghidra prints "ret")
	.text
	.globl	rea_loongarch_probe
	.type	rea_loongarch_probe, @function
rea_loongarch_probe:
	addi.d	$a0, $zero, 5
	addi.d	$a0, $a0, 3
	jr	$ra
	.size	rea_loongarch_probe, .-rea_loongarch_probe
	.section	.note.GNU-stack,"",@progbits
