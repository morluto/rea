import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.DWordDataType;
import ghidra.program.model.lang.Register;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;

import java.math.BigInteger;

/** Seed the caller-supplied raw-binary entry before default auto-analysis. */
public final class ReaGhidraPrepareRaw extends GhidraScript {
    private static final String CORTEX_LANGUAGE = "ARM:LE:32:Cortex";

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
        Address start = currentProgram.getMinAddress();
        if (entry == null || !entry.equals(start)) {
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
     * is data. The reset vector's low bit marks Thumb and is not part of the
     * code address.
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
        int slots = (int) Math.min(16L, size / 4L);
        Address reset = null;
        for (int index = 0; index < slots; index++) {
            Address slot = base.add(index * 4L);
            int raw = readLittleEndianInt(memory, slot);
            createData(slot, new DWordDataType());
            if (index == 0 || (raw & 1) == 0) continue;
            Address handler = slot.getAddressSpace().getAddress((raw & 0xffffffffL) & ~1L);
            if (handler == null || handler.compareTo(base) < 0 || handler.compareTo(end) > 0) {
                if (index == 1) {
                    throw new IllegalStateException(
                        "Cortex-M reset vector falls outside the mapped image"
                    );
                }
                continue;
            }
            addEntryPoint(handler);
            boolean decoded = disassemble(handler);
            Function existing = getFunctionAt(handler);
            if (existing == null && decoded) {
                createFunction(handler, index == 1 ? "reset_handler" : "vector_" + index);
            }
            if (index == 1) {
                reset = handler;
                if (getFunctionAt(handler) == null) {
                    throw new IllegalStateException(
                        "Cortex-M reset handler cannot be decoded as a Thumb function"
                    );
                }
            }
        }
        if (reset == null) {
            throw new IllegalStateException(
                "Cortex-M reset vector does not have the Thumb bit set"
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
