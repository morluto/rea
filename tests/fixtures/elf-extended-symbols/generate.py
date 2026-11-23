"""Write inert assembler sources; the recipe assembles but never runs them."""

import sys
from pathlib import Path

destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=True)
for name, bits, marker in (("32", 32, "@"), ("64", 64, "@"), ("aarch64be", 64, "%")):
    with (destination / f"extended-{name}.s").open("w", encoding="ascii") as source:
        source.write(f'.section .text.local_ctor,"ax",{marker}progbits\n')
        source.write(f'.globl local_ctor\n.type local_ctor,{marker}function\n')
        source.write('local_ctor: ret\n.size local_ctor,.-local_ctor\n')
        for index in range(65516):
            source.write(f'.section .pad{index},"a",{marker}progbits\n.byte 0\n')
        source.write(f'.section .text.high_ctor,"ax",{marker}progbits\n')
        source.write(f'.globl high_ctor\n.type high_ctor,{marker}function\n')
        source.write('high_ctor: ret\n.size high_ctor,.-high_ctor\n')
        source.write(f'.section .init_array,"aw",{marker}init_array\n')
        directive = ".quad" if bits == 64 else ".long"
        source.write(f'{directive} high_ctor\n{directive} local_ctor\n')
