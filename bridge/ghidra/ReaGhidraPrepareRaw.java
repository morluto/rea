import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.DWordDataType;
import ghidra.program.model.lang.Register;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.mem.MemoryBlockSourceInfo;

import java.math.BigInteger;

/** Seed the caller-supplied raw-binary entry before default auto-analysis. */
public final class ReaGhidraPrepareRaw extends GhidraScript {
    private static final String CORTEX_LANGUAGE = "ARM:LE:32:Cortex";
    /** ARMv7-M / ARMv8-M supports 16 system exceptions plus up to 240 external IRQs. */
    private static final int MAX_CORTEX_VECTOR_SLOTS = 256;

    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 2) {
            throw new IllegalArgumentException(
                "Raw binary preparation requires the committed language and entry address"
            );
        }
        String expectedLanguage = arguments[0];
        String entryHex = arguments[1];
        if (!currentProgram.getLanguageID().getIdAsString().equals(expectedLanguage) ||
            !currentProgram.getExecutableFormat().equals("Raw Binary")) {
            throw new IllegalArgumentException(
                "Raw binary preparation requires the committed language and BinaryLoader import"
            );
        }
        Address entry = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(entryHex);
        MemoryBlock block = entry == null ? null : currentProgram.getMemory().getBlock(entry);
        boolean fileStart = false;
        if (block != null) {
            // Processor-defined zero page/stack blocks can precede the imported file.
            for (MemoryBlockSourceInfo source : block.getSourceInfos()) {
                if (source.getFileBytes().isPresent() && source.getFileBytesOffset() == 0 &&
                    entry.equals(source.getMinAddress())) {
                    fileStart = true;
                    break;
                }
            }
        }
        if (!fileStart) {
            throw new IllegalArgumentException(
                "Raw binary import must map file offset 0 at the caller-supplied entry"
            );
        }
        if (CORTEX_LANGUAGE.equals(expectedLanguage)) prepareCortexVectorTable(entry);
        else {
            addEntryPoint(entry);
            if (!disassemble(entry) || createFunction(entry, "entry") == null) {
                throw new IllegalStateException("Raw binary entry cannot be decoded as a function");
            }
        }
        currentProgram.getOptions(Program.PROGRAM_INFO).setBoolean("REA raw binary prepared", true);
    }

    /**
     * Cortex-M images start with a little-endian vector table. The image base
     * is data. Handler words have bit 0 set for Thumb execution. External IRQ
     * slots (indices >= 16) are scanned up to the earliest observed handler
     * address or the first non-zero non-Thumb-pointer word.
     */
    private void prepareCortexVectorTable(Address base) throws Exception {
        Memory memory = currentProgram.getMemory();
        Address end = currentProgram.getMaxAddress();
        long size = memory.getSize();
        if (size < 8) {
            throw new IllegalStateException(
                "Cortex-M image is shorter than the initial stack pointer and reset vector"
            );
        }
        Register thumb = currentProgram.getRegister("TMode");
        if (thumb != null) {
            currentProgram.getProgramContext().setValue(thumb, base, end, BigInteger.ONE);
        }
        Address minCodeAddress = base.add(8L);
        int maxSlots = (int) Math.min((long) MAX_CORTEX_VECTOR_SLOTS, size / 4L);
        int resetRaw = readLittleEndianInt(memory, base.add(4L));
        if ((resetRaw & 1) == 0) {
            throw new IllegalStateException(
                "Cortex-M reset vector does not have the Thumb bit set"
            );
        }
        Address reset = base.getAddressSpace().getAddress((resetRaw & 0xffffffffL) & ~1L);
        if (reset == null || reset.compareTo(minCodeAddress) < 0 || reset.compareTo(end) > 0) {
            throw new IllegalStateException(
                "Cortex-M reset vector falls outside the mapped image"
            );
        }

        Address tableLimit = reset;
        int lastTableSlot = 1;
        for (int index = 2; index < maxSlots; index++) {
            Address slot = base.add(index * 4L);
            if (slot.compareTo(tableLimit) >= 0) break;
            int raw = readLittleEndianInt(memory, slot);
            if (raw == 0) {
                if (index < 16) lastTableSlot = index;
                continue;
            }
            if ((raw & 1) == 0) {
                if (index >= 16) break;
                continue;
            }
            Address handler = slot.getAddressSpace().getAddress((raw & 0xffffffffL) & ~1L);
            if (handler == null || handler.compareTo(minCodeAddress) < 0 || handler.compareTo(end) > 0) {
                if (index >= 16) break;
                continue;
            }
            if (handler.compareTo(tableLimit) < 0 && handler.compareTo(slot) > 0) {
                tableLimit = handler;
            }
            lastTableSlot = index;
        }

        for (int index = 0; index <= lastTableSlot; index++) {
            Address slot = base.add(index * 4L);
            if (index > 1 && slot.compareTo(tableLimit) >= 0) break;
            int raw = readLittleEndianInt(memory, slot);
            createData(slot, new DWordDataType());
            if (index == 0 || (raw & 1) == 0) continue;
            Address handler = slot.getAddressSpace().getAddress((raw & 0xffffffffL) & ~1L);
            if (handler == null || handler.compareTo(minCodeAddress) < 0 || handler.compareTo(end) > 0) {
                continue;
            }
            addEntryPoint(handler);
            boolean decoded = disassemble(handler);
            Function existing = getFunctionAt(handler);
            if (existing == null && decoded) {
                String fnName = index == 1
                    ? "reset_handler"
                    : index < 16
                        ? "vector_" + index
                        : "irq_" + (index - 16) + "_handler";
                createFunction(handler, fnName);
            }
        }
        if (getFunctionAt(reset) == null) {
            throw new IllegalStateException(
                "Cortex-M reset handler cannot be decoded as a Thumb function"
            );
        }
        addEntryPoint(base);
        currentProgram.getOptions(Program.PROGRAM_INFO).setString(
            "REA cortex-m reset",
            reset.toString()
        );
    }

    private static int readLittleEndianInt(Memory memory, Address address) throws Exception {
        byte[] word = new byte[4];
        memory.getBytes(address, word);
        return (word[0] & 0xff)
            | ((word[1] & 0xff) << 8)
            | ((word[2] & 0xff) << 16)
            | ((word[3] & 0xff) << 24);
    }
}
