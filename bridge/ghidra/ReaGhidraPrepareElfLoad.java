import com.google.gson.JsonObject;
import ghidra.app.script.GhidraScript;
import ghidra.program.database.ProgramDB;
import ghidra.program.database.mem.FileBytes;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressIterator;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.mem.MemoryBlockSourceInfo;
import ghidra.program.model.symbol.Namespace;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolTable;
import ghidra.program.model.symbol.SymbolType;
import java.util.ArrayList;
import java.util.List;

/**
 * Give an executable section that a NOBITS reservation shares addresses with the default address
 * space before auto-analysis (docs/ghidra-riscv.md). Ghidra 12.1.4's ELF loader resolves the
 * overlap in favour of the later section, so ESP-IDF's .flash_rodata_dummy keeps the default space
 * and .flash.text lands in an overlay, which DWARF import, call-frame entries and default-space
 * references never reach. REA's TypeScript admission commits both sections; any other memory map
 * is refused, and bytes and file mappings stay as imported.
 */
public final class ReaGhidraPrepareElfLoad extends GhidraScript {
    static final String POLICY = "nobits-reservation-overlay-v1";
    static final String REPORT_KEY = "REA ELF load preparation";

    private record Label(String name, long offset, Namespace namespace, SourceType source, boolean entry) {}

    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 6 || !arguments[0].equals(POLICY)) {
            throw new IllegalArgumentException(
                "ELF load preparation requires policy " + POLICY + " and the committed code and reservation sections"
            );
        }
        long codeAddress = parseHex(arguments[1]);
        long codeSize = parseHex(arguments[2]);
        long codeOffset = parseHex(arguments[3]);
        long reservationAddress = parseHex(arguments[4]);
        long reservationSize = parseHex(arguments[5]);
        if (codeSize == 0 || reservationAddress != codeAddress ||
            Long.compareUnsigned(reservationSize, codeSize) < 0) {
            throw new IllegalArgumentException(
                "ELF load preparation requires a reservation that starts with the code and covers it"
            );
        }
        Memory memory = currentProgram.getMemory();
        AddressSpace space = currentProgram.getAddressFactory().getDefaultAddressSpace();
        List<FileBytes> files = memory.getAllFileBytes();
        if (files.size() != 1) {
            refuse("Ghidra holds " + files.size() + " imported file images instead of one");
            return;
        }
        FileBytes file = files.get(0);
        MemoryBlock code = null;
        MemoryBlock reservation = null;
        int codeCandidates = 0;
        for (MemoryBlock block : memory.getBlocks()) {
            AddressSpace blockSpace = block.getStart().getAddressSpace();
            if (block.getStart().getOffset() != codeAddress) continue;
            if (block.isInitialized() && block.isExecute() && block.getSize() == codeSize &&
                blockSpace.getPhysicalSpace() == space && mapsFile(block, file, codeOffset)) {
                code = block;
                codeCandidates++;
            }
            if (!block.isInitialized() && !block.isExecute() && blockSpace == space &&
                block.getSize() == reservationSize) {
                reservation = block;
            }
        }
        String committed = "executable section " + hex(codeAddress) + " (" + hex(codeSize) +
            " bytes at file offset " + hex(codeOffset) + ")";
        if (codeCandidates != 1) {
            refuse("Ghidra has " + codeCandidates + " initialized executable blocks for the committed " + committed);
            return;
        }
        if (!code.isOverlay() && reservation == null) {
            report("canonical", null);
            return;
        }
        if (!code.isOverlay() || reservation == null) {
            refuse("Ghidra placed the committed " + committed + (code.isOverlay()
                ? " in an overlay, but no uninitialized default-space reservation " + hex(reservationAddress) +
                    " (" + hex(reservationSize) + " bytes) displaced it"
                : " in the default space beside a reservation block"));
            return;
        }
        report("moved", swap(code, reservation, file, codeOffset));
    }

    /**
     * Ghidra 12.1.4 constraints: Memory.moveBlock keeps a block in its address space, and the
     * native decompiler stops registering programs once any overlay space is removed. The code
     * therefore moves by re-creating its block and moving program content, and its overlay space
     * becomes the reservation's.
     */
    private JsonObject swap(MemoryBlock code, MemoryBlock reservation, FileBytes file, long fileOffset)
            throws Exception {
        Memory memory = currentProgram.getMemory();
        SymbolTable symbols = currentProgram.getSymbolTable();
        AddressSpace space = currentProgram.getAddressFactory().getDefaultAddressSpace();
        long size = code.getSize();
        long reservationSize = reservation.getSize();
        String codeName = code.getName();
        String reservationName = reservation.getName();
        String overlayName = code.getStart().getAddressSpace().getName();
        // moveAddressRange moves symbols and functions; entry points are references into the range.
        List<Long> codeEntries = entryOffsets(code);
        List<Label> labels = new ArrayList<>();
        List<Long> pinnedEntries = new ArrayList<>();
        for (Symbol symbol : symbols.getSymbols(range(reservation), SymbolType.LABEL, true)) {
            // Ghidra pins absolute ELF symbols: they keep their default-space address.
            if (symbol.isPinned()) {
                if (symbol.isExternalEntryPoint()) pinnedEntries.add(symbol.getAddress().getOffset());
                continue;
            }
            labels.add(new Label(
                symbol.getName(),
                symbol.getAddress().getOffset(),
                symbol.getParentNamespace(),
                symbol.getSource(),
                symbol.isExternalEntryPoint()
            ));
        }
        boolean reservationRead = reservation.isRead();
        boolean reservationWrite = reservation.isWrite();
        String reservationComment = reservation.getComment();
        String reservationSource = reservation.getSourceName();
        memory.removeBlock(reservation, monitor);
        MemoryBlock canonical = memory.createInitializedBlock(
            codeName + ".rea", space.getAddress(code.getStart().getOffset()), file, fileOffset, size, false
        );
        canonical.setPermissions(code.isRead(), code.isWrite(), code.isExecute());
        canonical.setVolatile(code.isVolatile());
        canonical.setComment(code.getComment());
        canonical.setSourceName(code.getSourceName());
        ((ProgramDB) currentProgram).moveAddressRange(code.getStart(), canonical.getStart(), size, monitor);
        // The emptied overlay block becomes the reservation: no bytes and no file mapping.
        MemoryBlock displaced = memory.convertToUninitialized(code);
        if (reservationSize > size) {
            MemoryBlock rest = memory.createUninitializedBlock(
                reservationName + ".rea", displaced.getEnd().add(1), reservationSize - size, false
            );
            displaced = memory.join(displaced, rest);
        }
        displaced.setName(reservationName);
        displaced.setPermissions(reservationRead, reservationWrite, false);
        displaced.setComment(reservationComment);
        if (reservationSource != null) displaced.setSourceName(reservationSource);
        currentProgram.renameOverlaySpace(overlayName, reservationName);
        canonical.setName(codeName);
        for (long offset : codeEntries) symbols.addExternalEntryPoint(space.getAddress(offset));
        for (long offset : pinnedEntries) symbols.addExternalEntryPoint(space.getAddress(offset));
        AddressSpace overlay = displaced.getStart().getAddressSpace();
        for (Label label : labels) {
            Address at = overlay.getAddress(label.offset());
            symbols.createLabel(at, label.name(), label.namespace(), label.source());
            if (label.entry()) symbols.addExternalEntryPoint(at);
        }
        int functions = 0;
        for (Function ignored : currentProgram.getFunctionManager().getFunctions(range(canonical), true)) {
            functions++;
        }
        JsonObject outcome = new JsonObject();
        outcome.addProperty("functions", functions);
        outcome.addProperty("entry_points", codeEntries.size());
        outcome.addProperty("reservation_labels", labels.size());
        return outcome;
    }

    private void report(String outcome, JsonObject counts) {
        JsonObject result = new JsonObject();
        result.addProperty("policy", POLICY);
        result.addProperty("outcome", outcome);
        if (counts != null) {
            for (String key : counts.keySet()) result.add(key, counts.get(key));
        }
        currentProgram.getOptions(Program.PROGRAM_INFO).setString(REPORT_KEY, result.toString());
        println("REA ELF load preparation: " + result);
    }

    /** Written instead of an outcome: REA refuses the session with this reason. */
    private void refuse(String reason) {
        JsonObject result = new JsonObject();
        result.addProperty("policy", POLICY);
        result.addProperty("refused", reason);
        currentProgram.getOptions(Program.PROGRAM_INFO).setString(REPORT_KEY, result.toString());
        println("REA ELF load preparation refused: " + reason);
    }

    private static boolean mapsFile(MemoryBlock block, FileBytes file, long offset) {
        List<MemoryBlockSourceInfo> sources = block.getSourceInfos();
        if (sources.size() != 1) return false;
        MemoryBlockSourceInfo source = sources.get(0);
        return source.getFileBytes().map(file::equals).orElse(false) &&
            source.getFileBytesOffset() == offset && source.getLength() == block.getSize();
    }

    private List<Long> entryOffsets(MemoryBlock block) {
        List<Long> offsets = new ArrayList<>();
        AddressIterator entries = currentProgram.getSymbolTable().getExternalEntryPointIterator();
        while (entries.hasNext()) {
            Address entry = entries.next();
            // An overlay block also contains its base space's addresses at the same offsets.
            if (entry.getAddressSpace().equals(block.getStart().getAddressSpace()) && block.contains(entry)) {
                offsets.add(entry.getOffset());
            }
        }
        return offsets;
    }

    private static AddressSet range(MemoryBlock block) {
        return new AddressSet(block.getStart(), block.getEnd());
    }

    private static long parseHex(String value) {
        if (!value.matches("0x[0-9a-f]{1,16}")) {
            throw new IllegalArgumentException("ELF load preparation expects lowercase 0x-hex values: " + value);
        }
        return Long.parseUnsignedLong(value.substring(2), 16);
    }

    private static String hex(long value) {
        return "0x" + Long.toUnsignedString(value, 16);
    }
}
