import com.google.gson.JsonObject;
import ghidra.app.script.GhidraScript;
import ghidra.program.database.ProgramDB;
import ghidra.program.database.mem.FileBytes;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressIterator;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.mem.MemoryBlockSourceInfo;
import ghidra.program.model.symbol.Namespace;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;
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
 * references never reach. REA's TypeScript admission commits both sections, and the script refuses
 * any other memory map. The file bytes and their offsets do not change.
 */
public final class ReaGhidraPrepareElfLoad extends GhidraScript {
    static final String POLICY = "nobits-reservation-overlay-v1";
    static final String REPORT_KEY = "REA ELF load preparation";
    /** The handshake bounds a refusal; this leaves room for the context around a failure. */
    private static final int FAILURE_DETAIL_MAX = 512;

    private record Label(String name, long offset, Namespace namespace, SourceType source) {}

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
            JsonObject result = new JsonObject();
            result.add("code", echoCode(code, code.getStart().getAddressSpace().getName()));
            report("canonical", result);
            return;
        }
        if (!code.isOverlay() || reservation == null) {
            refuse("Ghidra placed the committed " + committed + (code.isOverlay()
                ? " in an overlay, but no uninitialized default-space reservation " + hex(reservationAddress) +
                    " (" + hex(reservationSize) + " bytes) displaced it"
                : " in the default space beside a reservation block"));
            return;
        }
        // The code's whole overlay space moves with it and then becomes the reservation's.
        for (MemoryBlock block : memory.getBlocks()) {
            if (block != code && block.getStart().getAddressSpace().equals(code.getStart().getAddressSpace())) {
                refuse("Ghidra placed block " + block.getName() + " in the overlay space of the committed " + committed);
                return;
            }
        }
        JsonObject moved;
        try {
            moved = swap(code, reservation, file, codeOffset, committed);
        }
        catch (Exception failure) {
            // A failed swap can leave the program half moved: REA must not analyze it.
            refuse("Ghidra failed while moving the committed " + committed + ": " + detail(failure));
            throw failure;
        }
        if (moved != null) report("moved", moved);
    }

    /**
     * Ghidra 12.1.4 constraints: Memory.moveBlock keeps a block in its address space, and the
     * native decompiler stops registering programs once any overlay space is removed. The code
     * therefore moves by re-creating its block and moving program content, and its overlay space
     * becomes the reservation's. Returns null after a refusal.
     */
    private JsonObject swap(MemoryBlock code, MemoryBlock reservation, FileBytes file, long fileOffset,
            String committed) throws Exception {
        Memory memory = currentProgram.getMemory();
        SymbolTable symbols = currentProgram.getSymbolTable();
        AddressSpace space = currentProgram.getAddressFactory().getDefaultAddressSpace();
        long size = code.getSize();
        long reservationSize = reservation.getSize();
        String codeName = code.getName();
        String reservationName = reservation.getName();
        AddressSpace overlaySpace = code.getStart().getAddressSpace();
        String overlayName = overlaySpace.getName();
        // Everything in the code's overlay space belongs to the code, including labels past its
        // end, such as ESP-IDF's section-relative _etext.
        AddressSet old = new AddressSet(overlaySpace.getMinAddress(), overlaySpace.getMaxAddress());
        List<Label> labels = new ArrayList<>();
        for (Symbol symbol : symbols.getSymbols(range(reservation), SymbolType.LABEL, true)) {
            // Ghidra pins absolute ELF symbols: they keep their default-space address.
            if (symbol.isPinned()) continue;
            labels.add(new Label(
                symbol.getName(),
                symbol.getAddress().getOffset(),
                symbol.getParentNamespace(),
                symbol.getSource()
            ));
        }
        boolean reservationRead = reservation.isRead();
        boolean reservationWrite = reservation.isWrite();
        String reservationComment = reservation.getComment();
        String reservationSource = reservation.getSourceName();
        // Removing a block keeps the references into its range, entry points included.
        memory.removeBlock(reservation, monitor);
        MemoryBlock canonical = memory.createInitializedBlock(
            codeName + ".rea", space.getAddress(code.getStart().getOffset()), file, fileOffset, size, false
        );
        canonical.setPermissions(code.isRead(), code.isWrite(), code.isExecute());
        canonical.setVolatile(code.isVolatile());
        canonical.setComment(code.getComment());
        canonical.setSourceName(code.getSourceName());
        ((ProgramDB) currentProgram).moveAddressRange(code.getStart(), canonical.getStart(), size, monitor);
        // The move takes symbols, functions and the references from the range, not the references
        // into it, such as entry points and the loader's section-header reference: retarget them.
        ReferenceManager references = currentProgram.getReferenceManager();
        List<Reference> into = new ArrayList<>();
        for (Address target : references.getReferenceDestinationIterator(old, true)) {
            for (Reference reference : references.getReferencesTo(target)) into.add(reference);
        }
        for (Reference reference : into) {
            Address target = space.getAddress(reference.getToAddress().getOffset());
            if (reference.isEntryPointReference()) {
                symbols.removeExternalEntryPoint(reference.getToAddress());
                symbols.addExternalEntryPoint(target);
            }
            else if (reference.isMemoryReference() && !reference.isOffsetReference() &&
                !reference.isShiftedReference()) {
                references.delete(reference);
                references.setPrimary(references.addMemoryReference(reference.getFromAddress(), target,
                    reference.getReferenceType(), reference.getSource(), reference.getOperandIndex()),
                    reference.isPrimary());
            }
        }
        // The move covers the block; labels outside it are created again at the same offsets.
        List<Symbol> outside = new ArrayList<>();
        for (Symbol symbol : symbols.getSymbols(old, SymbolType.LABEL, true)) outside.add(symbol);
        for (Symbol symbol : outside) {
            symbols.createLabel(space.getAddress(symbol.getAddress().getOffset()), symbol.getName(),
                symbol.getParentNamespace(), symbol.getSource());
            symbol.delete();
        }
        // Any other kind of reference stays behind, as would a symbol the move missed: refuse both.
        boolean symbolsLeft = symbols.getPrimarySymbolIterator(old, true).hasNext();
        if (symbolsLeft || references.getReferenceDestinationIterator(old, true).hasNext()) {
            refuse("Ghidra left " + (symbolsLeft ? "symbols" : "references") + " in overlay space " + overlayName +
                " after moving the committed " + committed);
            return null;
        }
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
        AddressSpace overlay = displaced.getStart().getAddressSpace();
        // The reservation holds no code, so its labels mark no entry points.
        for (Label label : labels) {
            symbols.createLabel(overlay.getAddress(label.offset()), label.name(), label.namespace(), label.source());
        }
        JsonObject outcome = new JsonObject();
        outcome.add("code", echoCode(canonical, overlayName));
        outcome.add("reservation", echo(displaced, space.getName()));
        outcome.addProperty("functions", count(currentProgram.getFunctionManager().getFunctions(range(canonical), true)));
        outcome.addProperty("entry_points", entryPoints(canonical).size());
        outcome.addProperty("reservation_labels", count(symbols.getSymbols(range(displaced), SymbolType.LABEL, true)));
        return outcome;
    }

    /** A block as the script left it, for the client to compare with the committed section. */
    private static JsonObject echo(MemoryBlock block, String spaceBefore) {
        JsonObject result = new JsonObject();
        result.addProperty("name", block.getName());
        result.addProperty("address", hex(block.getStart().getOffset()));
        result.addProperty("size", hex(block.getSize()));
        result.addProperty("space_before", spaceBefore);
        result.addProperty("space_after", block.getStart().getAddressSpace().getName());
        return result;
    }

    private static JsonObject echoCode(MemoryBlock block, String spaceBefore) {
        JsonObject result = echo(block, spaceBefore);
        result.addProperty("file_offset", hex(block.getSourceInfos().get(0).getFileBytesOffset()));
        return result;
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

    private List<Address> entryPoints(MemoryBlock block) {
        List<Address> found = new ArrayList<>();
        AddressIterator entries = currentProgram.getSymbolTable().getExternalEntryPointIterator();
        while (entries.hasNext()) {
            Address entry = entries.next();
            // An overlay block also contains its base space's addresses at the same offsets.
            if (entry.getAddressSpace().equals(block.getStart().getAddressSpace()) && block.contains(entry)) {
                found.add(entry);
            }
        }
        return found;
    }

    private static int count(Iterable<?> values) {
        int count = 0;
        for (Object ignored : values) count++;
        return count;
    }

    private static String detail(Exception failure) {
        String text = failure.getClass().getSimpleName() +
            (failure.getMessage() == null ? "" : ": " + failure.getMessage());
        return text.length() <= FAILURE_DETAIL_MAX ? text : text.substring(0, FAILURE_DETAIL_MAX);
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
