// REA's packaged, read-only Ghidra headless bridge.
// @category REA

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.Channels;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import ghidra.app.util.headless.HeadlessScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.app.decompiler.ClangCaseToken;
import ghidra.app.decompiler.ClangNode;
import ghidra.framework.Application;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.address.AddressRange;
import ghidra.program.model.address.AddressRangeIterator;
import ghidra.program.model.block.BasicBlockModel;
import ghidra.program.model.block.CodeBlock;
import ghidra.program.model.block.CodeBlockIterator;
import ghidra.program.model.block.CodeBlockReference;
import ghidra.program.model.block.CodeBlockReferenceIterator;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.data.DataType;
import ghidra.program.model.lang.Register;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.listing.CommentType;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Variable;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.mem.MemoryBlockSourceInfo;
import ghidra.program.database.mem.FileBytes;
import ghidra.program.model.address.SegmentedAddress;
import ghidra.program.model.reloc.Relocation;
import java.io.ByteArrayOutputStream;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.pcode.FunctionPrototype;
import ghidra.program.model.pcode.HighFunction;
import ghidra.program.model.pcode.HighParam;
import ghidra.program.model.pcode.HighSymbol;
import ghidra.program.model.pcode.JumpTable;
import ghidra.program.model.pcode.PcodeOp;
import ghidra.program.model.pcode.PcodeOpAST;
import ghidra.program.model.pcode.PcodeBlock;
import ghidra.program.model.pcode.PcodeBlockBasic;
import ghidra.program.model.pcode.Varnode;
import ghidra.program.model.pcode.VarnodeAST;

public final class ReaGhidraBridge extends HeadlessScript {
    private static final int MAX_HIGH_PCODE_OPS = 3000;
    private static final int MAX_HIGH_PCODE_INPUTS_PER_OP = 64;
    private static final int MAX_HIGH_PCODE_DEF_USE_EDGES = 12000;
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final Set<String> DESCRIPTOR_KEYS = Set.of(
        "transport",
        "endpoint_path",
        "token",
        "run_id",
        "target_sha256",
        "provider_version",
        "profile_digest"
    );
    private static final Set<String> REQUEST_KEYS = Set.of(
        "id",
        "token",
        "method",
        "params"
    );
    private static final String[] CAPABILITIES = {
        "inspect_native_load_image",
        "read_bytes",
        "address_to_file_offset",
        "ping",
        "shutdown",
        "address_name",
        "list_documents",
        "list_names",
        "list_procedures",
        "list_segments",
        "list_strings",
        "procedure_address",
        "resolve_containing_procedure",
        "search_procedures",
        "search_strings",
        "analyze_function",
        "procedure_assembly",
        "procedure_callees",
        "procedure_callers",
        "procedure_info",
        "procedure_pseudo_code",
        "read_function_instructions",
        "inspect_native_instruction",
        "inspect_native_data_type",
        "resolve_native_call_targets",
        "procedure_references",
        "xrefs"
    };

    private List<InventoryItem> nameInventory;
    private List<FunctionEntry> procedureInventory;
    private List<InventoryItem> stringInventory;
    private DecompInterface decompiler;
    private static AddressSpace sessionDefaultAddressSpace;

    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 1) {
            throw new IllegalArgumentException("REA bridge requires one session descriptor");
        }
        Path descriptorPath = Path.of(arguments[0]);
        SessionDescriptor descriptor = readDescriptor(descriptorPath);
        Files.deleteIfExists(descriptorPath);
        if (currentProgram == null) {
            throw new IllegalStateException("REA bridge requires an imported program");
        }
        sessionDefaultAddressSpace =
            currentProgram.getAddressFactory().getDefaultAddressSpace();
        if (!Application.getApplicationVersion().equals(descriptor.providerVersion)) {
            throw new IllegalStateException("Ghidra provider version does not match the session");
        }
        String importedSha256 = currentProgram.getExecutableSHA256();
        if (importedSha256 == null ||
            !constantTimeEquals(
                importedSha256.toLowerCase(Locale.ROOT),
                descriptor.targetSha256
            )) {
            throw new IllegalStateException(
                "Ghidra imported-byte digest does not match the admitted target"
            );
        }
        try {
            initializeDecompiler();
            serve(descriptor);
        }
        finally {
            if (decompiler != null) {
                decompiler.dispose();
                decompiler = null;
            }
        }
    }

    private void serve(SessionDescriptor descriptor) throws Exception {
        if (descriptor.transport.equals("unix-socket")) {
            serveUnixSocket(descriptor);
            return;
        }
        if (descriptor.transport.equals("authenticated-loopback-tcp")) {
            serveLoopbackTcp(descriptor);
            return;
        }
        throw new IllegalArgumentException("REA bridge transport is invalid");
    }

    private void serveUnixSocket(SessionDescriptor descriptor) throws Exception {
        Path socketPath = Path.of(descriptor.endpointPath);
        Files.deleteIfExists(socketPath);
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            Files.setPosixFilePermissions(socketPath, PosixFilePermissions.fromString("rw-------"));
            acceptClient(server, descriptor);
        }
        finally {
            Files.deleteIfExists(socketPath);
        }
    }

    private void serveLoopbackTcp(SessionDescriptor descriptor) throws Exception {
        Path endpointPath = Path.of(descriptor.endpointPath);
        Path pendingPath = endpointPath.resolveSibling(endpointPath.getFileName() + ".pending");
        Files.deleteIfExists(endpointPath);
        Files.deleteIfExists(pendingPath);
        try (ServerSocketChannel server = ServerSocketChannel.open()) {
            server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
            InetSocketAddress address = (InetSocketAddress) server.getLocalAddress();
            JsonObject endpoint = new JsonObject();
            endpoint.addProperty("host", "127.0.0.1");
            endpoint.addProperty("port", address.getPort());
            Files.writeString(
                pendingPath,
                GSON.toJson(endpoint) + "\n",
                StandardCharsets.UTF_8,
                StandardOpenOption.CREATE_NEW,
                StandardOpenOption.WRITE
            );
            try {
                Files.move(pendingPath, endpointPath, StandardCopyOption.ATOMIC_MOVE);
            }
            catch (AtomicMoveNotSupportedException exception) {
                Files.move(pendingPath, endpointPath);
            }
            acceptClient(server, descriptor);
        }
        finally {
            Files.deleteIfExists(pendingPath);
            Files.deleteIfExists(endpointPath);
        }
    }

    private void acceptClient(
            ServerSocketChannel server,
            SessionDescriptor descriptor) throws Exception {
        try (SocketChannel client = server.accept();
             BufferedReader reader = new BufferedReader(
                 Channels.newReader(client, StandardCharsets.UTF_8)
             );
             BufferedWriter writer = new BufferedWriter(
                 Channels.newWriter(client, StandardCharsets.UTF_8)
             )) {
            serveClient(descriptor, reader, writer);
        }
    }

    private void serveClient(
            SessionDescriptor descriptor,
            BufferedReader reader,
            BufferedWriter writer) throws Exception {
        while (true) {
            String line = reader.readLine();
            if (line == null) {
                return;
            }
            Request request;
            try {
                request = parseRequest(line, descriptor.token);
            }
            catch (RuntimeException exception) {
                writeFailure(writer, 1, "invalid_request", "Bridge request is invalid");
                return;
            }
            try {
                if (request.method.equals("shutdown")) {
                    requireKeys(request.params, Set.of());
                    JsonObject result = new JsonObject();
                    result.addProperty("shutdown", true);
                    result.addProperty("project_ephemeral", true);
                    writeSuccess(writer, request.id, result);
                    return;
                }
                writeSuccess(writer, request.id, handleRequest(request, descriptor));
            }
            catch (RequestFailure failure) {
                writeFailure(writer, request.id, failure.code, failure.getMessage());
            }
            catch (Exception exception) {
                writeFailure(
                    writer,
                    request.id,
                    "bridge_exception",
                    exception.getClass().getSimpleName() + ": " + safeMessage(exception)
                );
            }
        }
    }

    private JsonElement handleRequest(Request request, SessionDescriptor descriptor)
            throws Exception {
        if (request.method.equals("ping")) {
            requireKeys(request.params, Set.of());
            return sessionInfo(descriptor);
        }
        if (analysisTimeoutOccurred()) {
            throw new RequestFailure(
                "analysis_incomplete",
                "Ghidra auto-analysis did not complete for this Program"
            );
        }
        return switch (request.method) {
            case "inspect_native_load_image" -> inspectNativeLoadImage(request.params);
            case "read_bytes" -> readMemoryBytes(request.params);
            case "address_to_file_offset" -> addressToFileOffset(request.params);
            case "address_name" -> addressName(request.params);
            case "list_documents" -> listDocuments(request.params);
            case "list_names" -> listNames(request.params);
            case "list_procedures" -> listProcedures(request.params);
            case "list_segments" -> listSegments(request.params);
            case "list_strings" -> listStrings(request.params);
            case "procedure_address" -> procedureAddress(request.params);
            case "procedure_assembly" -> procedureAssembly(request.params);
            case "procedure_callees" -> procedureCalls(request.params, false);
            case "procedure_callers" -> procedureCalls(request.params, true);
            case "procedure_info" -> procedureInfo(request.params);
            case "procedure_pseudo_code" -> procedurePseudocode(request.params);
            case "read_function_instructions" -> readFunctionInstructions(request.params);
            case "procedure_references" -> procedureReferences(request.params);
            case "resolve_containing_procedure" -> containingProcedure(request.params);
            case "search_procedures" -> search(request.params, true);
            case "search_strings" -> search(request.params, false);
            case "inspect_native_data_type" -> inspectNativeDataType(request.params);
            case "inspect_native_instruction" -> inspectNativeInstruction(request.params);
            case "resolve_native_call_targets" -> resolveNativeCallTargets(request.params);
            case "xrefs" -> xrefs(request.params);
            case "analyze_function" -> analyzeFunction(request.params);
            default -> throw new RequestFailure(
                "method_unavailable",
                "Bridge method is unavailable"
            );
        };
    }

    private JsonObject sessionInfo(SessionDescriptor descriptor) throws Exception {
        boolean timedOut = analysisTimeoutOccurred();
        JsonObject provider = new JsonObject();
        provider.addProperty("id", "ghidra");
        provider.addProperty("version", Application.getApplicationVersion());

        JsonObject target = new JsonObject();
        target.addProperty("name", currentProgram.getName());
        target.addProperty("language_id", currentProgram.getLanguageID().getIdAsString());
        target.addProperty(
            "compiler_spec_id",
            currentProgram.getCompilerSpec().getCompilerSpecID().getIdAsString()
        );
        target.addProperty("image_base", canonicalAddress(currentProgram.getImageBase()));
        target.addProperty(
            "default_address_space",
            currentProgram.getAddressFactory().getDefaultAddressSpace().getName()
        );
        target.addProperty("sha256", descriptor.targetSha256);

        JsonObject result = new JsonObject();
        result.addProperty("name", "REA Ghidra bridge");
        result.addProperty("run_id", descriptor.runId);
        result.addProperty("profile_digest", descriptor.profileDigest);
        result.add("provider", provider);
        result.addProperty("read_only", true);
        result.addProperty("analysis_complete", !timedOut);
        result.addProperty("analysis_timed_out", timedOut);
        result.add("capabilities", GSON.toJsonTree(CAPABILITIES));
        result.add("target", target);
        return result;
    }

    private static String bytesHex(byte[] bytes) {
        return java.util.HexFormat.of().formatHex(bytes);
    }

    private String hashFileBytes(FileBytes source, boolean modified) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] chunk = new byte[65536];
        for (long offset = 0; offset < source.getSize();) {
            monitor.checkCancelled();
            int length = (int) Math.min(chunk.length, source.getSize() - offset);
            int read = modified
                ? source.getModifiedBytes(offset, chunk, 0, length)
                : source.getOriginalBytes(offset, chunk, 0, length);
            if (read != length) throw new IOException("Incomplete FileBytes read at " + offset);
            digest.update(chunk, 0, read);
            offset += read;
        }
        return bytesHex(digest.digest());
    }

    private String hashMemory(Address start, long length) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] chunk = new byte[65536];
        for (long offset = 0; offset < length;) {
            monitor.checkCancelled();
            int count = (int) Math.min(chunk.length, length - offset);
            int read = currentProgram.getMemory().getBytes(start.add(offset), chunk, 0, count);
            if (read != count) throw new IOException("Incomplete memory read at " + start.add(offset));
            digest.update(chunk, 0, read);
            offset += read;
        }
        return bytesHex(digest.digest());
    }

    private JsonObject inspectNativeLoadImage(JsonObject params) throws Exception {
        requireKeys(params, Set.of());
        JsonObject result = new JsonObject();
        result.addProperty("executable_format", currentProgram.getExecutableFormat());
        result.addProperty("language_id", currentProgram.getLanguageID().getIdAsString());
        result.addProperty("compiler_spec_id", currentProgram.getCompilerSpec().getCompilerSpecID().getIdAsString());
        result.addProperty("image_base", canonicalAddress(currentProgram.getImageBase()));
        result.addProperty("default_address_space", sessionDefaultAddressSpace.getName());
        List<FileBytes> files = currentProgram.getMemory().getAllFileBytes();
        JsonArray sources = new JsonArray();
        for (FileBytes file : files) {
            JsonObject source = new JsonObject();
            source.addProperty("name", file.getFilename());
            source.addProperty("size", file.getSize());
            source.addProperty("original_sha256", hashFileBytes(file, false));
            source.addProperty("modified_sha256", hashFileBytes(file, true));
            sources.add(source);
        }
        result.add("source_files", sources);
        JsonArray mappings = new JsonArray();
        for (MemoryBlock block : currentProgram.getMemory().getBlocks()) {
            for (MemoryBlockSourceInfo source : block.getSourceInfos()) {
                monitor.checkCancelled();
                JsonObject mapping = new JsonObject();
                mapping.addProperty("block", block.getName());
                mapping.addProperty("start", canonicalAddress(source.getMinAddress()));
                mapping.addProperty("end", canonicalAddress(source.getMaxAddress()));
                mapping.addProperty("address_space", source.getMinAddress().getAddressSpace().getName());
                mapping.addProperty("initialized", block.isInitialized());
                mapping.addProperty("loaded", block.isLoaded());
                mapping.addProperty("overlay", block.isOverlay());
                mapping.addProperty("length", source.getLength());
                FileBytes backing = source.getFileBytes().orElse(null);
                int sourceIndex = backing == null ? -1 : files.indexOf(backing);
                if (sourceIndex < 0) mapping.add("source_file_index", JsonNull.INSTANCE);
                else mapping.addProperty("source_file_index", sourceIndex);
                long offset = source.getFileBytesOffset();
                if (offset < 0) mapping.add("file_offset", JsonNull.INSTANCE);
                else mapping.addProperty("file_offset", offset);
                if (block.isInitialized()) mapping.addProperty("sha256", hashMemory(source.getMinAddress(), source.getLength()));
                else mapping.add("sha256", JsonNull.INSTANCE);
                mappings.add(mapping);
            }
        }
        result.add("mappings", mappings);
        JsonArray relocations = new JsonArray();
        Iterator<Relocation> iterator = currentProgram.getRelocationTable().getRelocations();
        while (iterator.hasNext()) {
            monitor.checkCancelled();
            Relocation relocation = iterator.next();
            Address location = relocation.getAddress();
            JsonObject row = new JsonObject();
            row.addProperty("address", canonicalAddress(location));
            if (location instanceof SegmentedAddress segmented) {
                row.addProperty("segment", segmented.getSegment());
                row.addProperty("offset", segmented.getSegmentOffset());
            } else {
                row.add("segment", JsonNull.INSTANCE);
                row.add("offset", JsonNull.INSTANCE);
            }
            row.addProperty("status", relocation.getStatus().toString());
            row.addProperty("type", relocation.getType());
            row.add("values", GSON.toJsonTree(relocation.getValues() == null ? new long[0] : relocation.getValues()));
            byte[] original = relocation.getBytes();
            row.add("original_bytes_hex", original == null ? JsonNull.INSTANCE : GSON.toJsonTree(bytesHex(original)));
            if (original != null && original.length > 0) {
                byte[] memory = new byte[original.length];
                int read = currentProgram.getMemory().getBytes(location, memory);
                row.add("memory_bytes_hex", read == memory.length ? GSON.toJsonTree(bytesHex(memory)) : JsonNull.INSTANCE);
            } else row.add("memory_bytes_hex", JsonNull.INSTANCE);
            relocations.add(row);
        }
        result.add("relocations", relocations);
        List<Address> entries = new ArrayList<>();
        var entryIterator = currentProgram.getSymbolTable().getExternalEntryPointIterator();
        while (entryIterator.hasNext()) entries.add(entryIterator.next());
        entries.sort(Address::compareTo);
        JsonArray entryPoints = new JsonArray();
        for (Address entry : entries) entryPoints.add(canonicalAddress(entry));
        result.add("entry_points", entryPoints);
        return result;
    }

    private JsonObject readMemoryBytes(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "address", "length"));
        requireDocument(params);
        Address start = requireAddress(params, "address");
        JsonElement requested = params.get("length");
        long length;
        try {
            if (requested == null || !requested.isJsonPrimitive() || !requested.getAsJsonPrimitive().isNumber())
                throw new IllegalArgumentException();
            length = requested.getAsBigDecimal().longValueExact();
            if (length < 1 || length > 9007199254740991L) throw new IllegalArgumentException();
        } catch (RuntimeException failure) {
            throw new RequestFailure("invalid_request", "Byte length must be a positive safe integer");
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] chunk = new byte[65536];
        for (long offset = 0; offset < length;) {
            monitor.checkCancelled();
            Address at;
            try { at = start.addNoWrap(offset); }
            catch (Exception endOfSpace) { break; }
            MemoryBlock block = currentProgram.getMemory().getBlock(at);
            if (block == null || !block.isInitialized()) break;
            int count = (int) Math.min(chunk.length, Math.min(length - offset, block.getEnd().subtract(at) + 1));
            int read = currentProgram.getMemory().getBytes(at, chunk, 0, count);
            bytes.write(chunk, 0, read);
            if (read != count) break;
            offset += read;
        }
        JsonObject result = new JsonObject();
        result.addProperty("address", canonicalAddress(start));
        result.addProperty("requested_bytes", length);
        result.addProperty("returned_bytes", bytes.size());
        result.addProperty("bytes_hex", bytesHex(bytes.toByteArray()));
        result.addProperty("complete", bytes.size() == length);
        return result;
    }

    private JsonObject addressToFileOffset(JsonObject params) {
        requireKeys(params, Set.of("document", "address"));
        requireDocument(params);
        Address address = requireAddress(params, "address");
        MemoryBlock block = currentProgram.getMemory().getBlock(address);
        if (block == null || !block.isInitialized())
            throw new RequestFailure("invalid_request", "Address has no initialized file-backed memory: " + canonicalAddress(address));
        Long fileOffset = null;
        int mappings = 0;
        for (MemoryBlockSourceInfo source : block.getSourceInfos()) {
            if (!source.contains(address) || source.getFileBytes().isEmpty()) continue;
            long offset = source.getFileBytesOffset(address);
            if (offset < 0) continue;
            fileOffset = offset;
            mappings++;
        }
        if (mappings != 1)
            throw new RequestFailure("invalid_request", "Address has " + mappings + " authoritative source mappings: " + canonicalAddress(address));
        JsonObject result = new JsonObject();
        result.addProperty("address", canonicalAddress(address));
        result.addProperty("file_offset", fileOffset);
        return result;
    }

    private void initializeDecompiler() {
        DecompileOptions options = new DecompileOptions();
        options.setMaxInstructions(Integer.MAX_VALUE);
        decompiler = new DecompInterface();
        decompiler.setOptions(options);
        decompiler.toggleCCode(true);
        decompiler.toggleSyntaxTree(true);
        decompiler.toggleJumpLoads(true);
        if (!decompiler.openProgram(currentProgram)) {
            throw new IllegalStateException("Ghidra decompiler could not open the imported Program");
        }
    }

    private JsonElement procedurePseudocode(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "procedure"));
        requireDocument(params);
        String value = decompiledText(
            decompile(resolveProcedure(requireString(params, "procedure")))
        );
        return value == null ? JsonNull.INSTANCE : GSON.toJsonTree(value);
    }

    private JsonElement procedureAssembly(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "procedure"));
        requireDocument(params);
        Function function = resolveProcedure(requireString(params, "procedure"));
        InstructionScan scan = scanInstructions(function, Integer.MAX_VALUE);
        return GSON.toJsonTree(renderAssembly(scan.instructions));
    }

    private JsonObject readFunctionInstructions(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "procedure"));
        requireDocument(params);
        Function function = resolveProcedure(requireString(params, "procedure"));
        InstructionScan scan = scanInstructions(function, Integer.MAX_VALUE);
        JsonArray items = new JsonArray();
        for (String line : renderAssemblyLines(scan.instructions)) {
            items.add(line);
        }

        JsonArray limitations = new JsonArray();
        limitations.add("Instruction text and ordering are Ghidra-specific representations.");
        limitations.add(
            "The fast path does not invoke the decompiler or scan whole-program names and strings."
        );
        JsonObject result = new JsonObject();
        result.add("procedure", procedureIdentity(function));
        result.add("instructions", items);
        result.add("limitations", limitations);
        return result;
    }

    private JsonArray procedureCalls(JsonObject params, boolean callers) throws Exception {
        requireKeys(params, Set.of("document", "procedure"));
        requireDocument(params);
        Function function = resolveProcedure(requireString(params, "procedure"));
        Set<Function> observed = callers
            ? function.getCallingFunctions(monitor)
            : function.getCalledFunctions(monitor);
        List<Function> ordered = new ArrayList<>(observed);
        ordered.sort(Comparator.comparing(Function::getEntryPoint));
        JsonArray result = new JsonArray();
        for (Function item : ordered) {
            result.add(canonicalAddress(item.getEntryPoint()));
        }
        return result;
    }

    private JsonObject procedureInfo(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "procedure"));
        requireDocument(params);
        Function function = resolveProcedure(requireString(params, "procedure"));
        JsonObject result = new JsonObject();
        result.addProperty("name", procedureName(function));
        result.addProperty("entrypoint", canonicalAddress(function.getEntryPoint()));
        result.addProperty("basicblock_count", basicBlocks(function).size());
        JsonObject body = functionBody(function);
        result.addProperty("length", body.get("total_bytes").getAsLong());
        result.add("body", body);
        result.addProperty("signature", function.getPrototypeString(false, true));
        result.add("locals", functionLocals(function));
        result.add("classification", functionClassification(function));
        return result;
    }

    private JsonObject procedureReferences(JsonObject params) throws Exception {
        requireKeys(
            params,
            Set.of(
                "document",
                "procedure",
                "direction"
            )
        );
        requireDocument(params);
        Function function = resolveProcedure(requireString(params, "procedure"));
        String direction = requireString(params, "direction");
        if (!direction.equals("incoming") && !direction.equals("outgoing")) {
            throw new RequestFailure("invalid_request", "direction must be incoming or outgoing");
        }
        InstructionScan scan = scanInstructions(function, Integer.MAX_VALUE);
        List<Reference> references = collectReferences(scan.instructions, direction);
        JsonArray edges = new JsonArray();
        for (Reference reference : references) {
            edges.add(referenceEdge(reference));
        }
        JsonObject result = new JsonObject();
        result.add("procedure", procedureIdentity(function));
        result.addProperty("direction", direction);
        result.add("references", edges);
        result.addProperty("reference_kinds_available", true);
        JsonArray unresolvedCalls = new JsonArray();
        if (direction.equals("outgoing")) for (Instruction instruction : scan.instructions) {
            if (!instruction.getFlowType().isCall()) continue;
            boolean resolved = false;
            for (Reference reference : instruction.getReferencesFrom()) if (reference.getReferenceType().isCall()) resolved = true;
            if (!resolved) {
                JsonObject site = new JsonObject();
                site.addProperty("address", canonicalAddress(instruction.getAddress()));
                site.addProperty("reason", "Instruction decoder identifies a call but ReferenceManager supplies no call destination");
                unresolvedCalls.add(site);
            }
        }
        result.add("unresolved_calls", unresolvedCalls);
        return result;
    }

    private JsonObject inspectNativeDataType(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "type", "address"));
        requireDocument(params);
        boolean byType = params.has("type") && !params.get("type").isJsonNull();
        boolean byAddress = params.has("address") && !params.get("address").isJsonNull();
        if (byType == byAddress) throw new RequestFailure("invalid_request", "Supply exactly one of type or address");
        DataType type;
        Address address = null;
        if (byType) type = currentProgram.getDataTypeManager().getDataType(requireString(params, "type"));
        else {
            address = requireAddress(params, "address");
            Data data = currentProgram.getListing().getDefinedDataAt(address);
            type = data == null ? null : data.getDataType();
        }
        JsonObject result = new JsonObject();
        result.addProperty("status", type == null ? "unavailable" : "available");
        result.add("reason", type == null ? GSON.toJsonTree("No exact database type or defined typed data exists at the selected identity") : JsonNull.INSTANCE);
        for (String key : List.of("id", "name", "source_archive", "size_bytes", "alignment_bytes", "packing_enabled", "referenced_type", "array_count", "array_stride_bytes")) result.add(key, JsonNull.INSTANCE);
        result.add("address", address == null ? JsonNull.INSTANCE : GSON.toJsonTree(canonicalAddress(address)));
        result.addProperty("source", "analysis-database");
        result.addProperty("kind", "unavailable");
        JsonArray fields = new JsonArray();
        JsonArray members = new JsonArray();
        int totalFields = 0;
        if (type != null) {
            result.addProperty("id", type.getPathName());
            result.addProperty("name", type.getName());
            if (type.getSourceArchive() != null) result.addProperty("source_archive", type.getSourceArchive().getName());
            if (type.getLength() >= 0) result.addProperty("size_bytes", type.getLength());
            if (type.getAlignment() > 0) result.addProperty("alignment_bytes", type.getAlignment());
            String kind = type instanceof ghidra.program.model.data.Structure ? "struct" : type instanceof ghidra.program.model.data.Union ? "union" : type instanceof ghidra.program.model.data.Enum ? "enum" : type instanceof ghidra.program.model.data.Pointer ? "pointer" : type instanceof ghidra.program.model.data.Array ? "array" : type instanceof ghidra.program.model.data.TypeDef ? "typedef" : type instanceof ghidra.program.model.data.BuiltInDataType ? "scalar" : "unsupported";
            result.addProperty("kind", kind);
            if (type instanceof ghidra.program.model.data.Composite composite) {
                result.addProperty("packing_enabled", composite.isPackingEnabled());
                ghidra.program.model.data.DataTypeComponent[] components = composite.getComponents();
                totalFields = components.length;
                for (int index = 0; index < Math.min(components.length, 20_000); index++) {
                    monitor.checkCancelled();
                    ghidra.program.model.data.DataTypeComponent component = components[index];
                    JsonObject field = new JsonObject();
                    field.addProperty("ordinal", component.getOrdinal());
                    field.add("name", component.getFieldName() == null ? JsonNull.INSTANCE : GSON.toJsonTree(component.getFieldName()));
                    field.addProperty("offset_bytes", component.getOffset());
                    field.add("size_bytes", component.getLength() < 0 ? JsonNull.INSTANCE : GSON.toJsonTree(component.getLength()));
                    field.addProperty("type_id", component.getDataType().getPathName());
                    field.add("bit_size", JsonNull.INSTANCE);
                    field.add("bit_offset", JsonNull.INSTANCE);
                    if (component.getDataType() instanceof ghidra.program.model.data.BitFieldDataType bitfield) {
                        field.addProperty("bit_size", bitfield.getBitSize());
                        field.addProperty("bit_offset", bitfield.getBitOffset());
                    }
                    field.addProperty("status", "observed");
                    field.addProperty("flexible_tail", "unknown");
                    fields.add(field);
                }
            } else if (type instanceof ghidra.program.model.data.Enum enumeration) {
                String[] names = enumeration.getNames();
                totalFields = names.length;
                java.util.Arrays.sort(names);
                for (int index = 0; index < Math.min(names.length, 20_000); index++) {
                    monitor.checkCancelled();
                    JsonObject member = new JsonObject();
                    member.addProperty("name", names[index]);
                    member.addProperty("value", Long.toString(enumeration.getValue(names[index])));
                    members.add(member);
                }
            } else if (type instanceof ghidra.program.model.data.Pointer pointer) {
                if (pointer.getDataType() != null) result.addProperty("referenced_type", pointer.getDataType().getPathName());
            } else if (type instanceof ghidra.program.model.data.Array array) {
                result.addProperty("referenced_type", array.getDataType().getPathName());
                result.addProperty("array_count", array.getNumElements());
                result.addProperty("array_stride_bytes", array.getElementLength());
            } else if (type instanceof ghidra.program.model.data.TypeDef alias) {
                result.addProperty("referenced_type", alias.getDataType().getPathName());
            }
        }
        result.add("fields", fields);
        result.add("members", members);
        result.addProperty("total_fields", totalFields);
        result.addProperty("truncated", totalFields > 20_000);
        result.add("limitations", GSON.toJsonTree(List.of("Layouts are Ghidra data-type database observations; original debug/source authority and flexible-tail semantics are not inferred. Nested and recursive types retain category-path identities for separate inspection.", "At most 20000 fields or enum members are serialized per type to bound provider output. total_fields and truncated report omissions. Enum values preserve Ghidra's signed long representation.")));
        return result;
    }

    private JsonObject instructionReference(Reference reference) {
        JsonObject item = new JsonObject();
        RefType type = reference.getReferenceType();
        item.addProperty("target_address", canonicalAddress(reference.getToAddress()));
        item.addProperty("type", type.getName());
        item.addProperty("call", type.isCall());
        item.addProperty("jump", type.isJump());
        item.addProperty("indirect", type.isIndirect());
        item.addProperty("computed", type.isComputed());
        item.addProperty("operand_index", reference.getOperandIndex());
        return item;
    }

    private JsonObject inspectNativeInstruction(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "address"));
        requireDocument(params);
        Address address = requireAddress(params, "address");
        Instruction instruction = currentProgram.getListing().getInstructionAt(address);
        Function function = currentProgram.getFunctionManager().getFunctionContaining(address);
        JsonObject result = new JsonObject();
        result.addProperty("address", canonicalAddress(address));
        result.add("procedure", function == null ? JsonNull.INSTANCE : GSON.toJsonTree(canonicalAddress(function.getEntryPoint())));
        result.addProperty("architecture", currentProgram.getLanguageID().getIdAsString());
        result.addProperty("mode", currentProgram.getLanguage().getLanguageDescription().getVariant());
        JsonArray operands = new JsonArray();
        JsonArray references = new JsonArray();
        JsonArray destinations = new JsonArray();
        JsonObject flow = new JsonObject();
        flow.addProperty("kind", "unavailable");
        flow.addProperty("conditional", false);
        flow.addProperty("computed", false);
        if (instruction == null) {
            result.addProperty("status", !currentProgram.getMemory().contains(address) ? "outside-memory" : currentProgram.getListing().getInstructionContaining(address) != null
                ? "not-instruction-boundary" : currentProgram.getListing().getDefinedDataContaining(address) != null ? "data" : "undecodable");
            for (String key : List.of("bytes", "length", "mnemonic", "raw_disassembly")) result.add(key, JsonNull.INSTANCE);
        } else {
            result.addProperty("status", "decoded");
            result.addProperty("bytes", java.util.HexFormat.of().formatHex(instruction.getBytes()));
            result.addProperty("length", instruction.getLength());
            result.addProperty("mnemonic", instruction.getMnemonicString());
            result.addProperty("raw_disassembly", instruction.toString());
            RefType type = instruction.getFlowType();
            flow.addProperty("kind", type.isCall() ? "call" : type.isJump() ? "jump" : type.isTerminal() ? "terminal" : "fallthrough");
            flow.addProperty("conditional", type.isConditional());
            flow.addProperty("computed", type.isComputed());
            if (!type.isComputed()) for (Address target : instruction.getFlows()) destinations.add(canonicalAddress(target));
            for (Reference reference : instruction.getReferencesFrom()) references.add(instructionReference(reference));
            for (int index = 0; index < instruction.getNumOperands(); index++) {
                JsonObject operand = new JsonObject();
                operand.addProperty("index", index);
                operand.addProperty("raw", instruction.getDefaultOperandRepresentation(index));
                operand.addProperty("provider_type", instruction.getOperandType(index));
                operand.addProperty("memory_addressing", "unavailable");
                JsonArray components = new JsonArray();
                for (Object object : instruction.getOpObjects(index)) {
                    JsonObject component = new JsonObject();
                    component.addProperty("text", object.toString());
                    component.add("value", JsonNull.INSTANCE);
                    component.add("bit_width", JsonNull.INSTANCE);
                    if (object instanceof Register register) {
                        component.addProperty("kind", "register");
                        component.addProperty("value", register.getName());
                        component.addProperty("bit_width", register.getBitLength());
                    } else if (object instanceof Scalar scalar) {
                        component.addProperty("kind", "immediate");
                        component.addProperty("value", "0x" + Long.toUnsignedString(scalar.getUnsignedValue(), 16));
                        component.addProperty("bit_width", scalar.bitLength());
                    } else if (object instanceof Address target) {
                        component.addProperty("kind", "address");
                        component.addProperty("value", canonicalAddress(target));
                    } else component.addProperty("kind", "unknown");
                    components.add(component);
                }
                operand.add("components", components);
                operands.add(operand);
            }
        }
        flow.add("direct_destinations", destinations);
        result.add("operands", operands);
        result.add("flow", flow);
        result.add("references", references);
        result.add("limitations", GSON.toJsonTree(List.of("Operand components are Ghidra Listing decoder tokens; effective memory base/index/displacement roles and per-instruction context mode are unavailable. The mode field is the program language variant.", "Terminal flow is not classified as a return without provider evidence.")));
        return result;
    }

    private JsonObject resolveNativeCallTargets(JsonObject params) throws Exception {
        JsonObject instruction = inspectNativeInstruction(params);
        JsonObject result = new JsonObject();
        result.add("call_site", instruction.get("address"));
        result.add("procedure", instruction.get("procedure"));
        JsonArray targets = new JsonArray();
        JsonObject flow = instruction.getAsJsonObject("flow");
        boolean decoded = instruction.get("status").getAsString().equals("decoded");
        boolean call = flow.get("kind").getAsString().equals("call");
        boolean computed = flow.get("computed").getAsBoolean();
        Map<String, JsonArray> byTarget = new TreeMap<>();
        if (call) for (JsonElement element : instruction.getAsJsonArray("references")) {
            JsonObject reference = element.getAsJsonObject();
            if (reference.get("call").getAsBoolean())
                byTarget.computeIfAbsent(reference.get("target_address").getAsString(), ignored -> new JsonArray()).add(reference);
        }
        boolean ambiguous = byTarget.size() > 1;
        for (Map.Entry<String, JsonArray> entry : byTarget.entrySet()) {
            JsonObject target = new JsonObject();
            target.addProperty("address", entry.getKey());
            Address address = tryParseAddress(entry.getKey());
            Function function = address == null ? null : currentProgram.getFunctionManager().getFunctionAt(address);
            target.add("procedure", function == null ? JsonNull.INSTANCE : GSON.toJsonTree(canonicalAddress(function.getEntryPoint())));
            target.addProperty("status", ambiguous ? "candidate" : computed ? "resolved-indirect" : "direct");
            target.addProperty("basis", "provider-reference");
            target.add("references", entry.getValue());
            targets.add(target);
        }
        result.addProperty("status", !decoded ? "unavailable" : !call ? "not-call" : ambiguous ? "ambiguous" : targets.size() == 0 ? "unresolved" : computed ? "resolved-indirect" : "direct");
        result.addProperty("mechanism", !call ? "unavailable" : computed ? "computed" : "direct");
        result.add("targets", targets);
        result.add("limitations", GSON.toJsonTree(List.of("Targets are static Ghidra ReferenceManager call-reference observations. Computed calls without call references remain unresolved; a resolved reference is not proof of runtime execution.", "Objective-C, Swift, vtable and closure mechanisms are not identified by this reference-only boundary.")));
        return result;
    }

    private JsonArray xrefs(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "address"));
        requireDocument(params);
        Address address = requireAddress(params, "address");
        ReferenceIterator references = currentProgram.getReferenceManager().getReferencesTo(address);
        Set<Address> sources = new HashSet<>();
        while (references.hasNext()) {
            monitor.checkCancelled();
            Reference reference = references.next();
            if (reference.isEntryPointReference()) {
                continue;
            }
            sources.add(reference.getFromAddress());
            }
        List<Address> ordered = new ArrayList<>(sources);
        ordered.sort(Address::compareTo);
        JsonArray result = new JsonArray();
        for (Address source : ordered) {
            result.add(canonicalAddress(source));
        }
        return result;
    }

    private JsonObject analyzeFunction(JsonObject params) throws Exception {
        requireKeys(params, Set.of("procedure"));
        Function function = resolveProcedure(requireString(params, "procedure"));
        InstructionScan scan = scanInstructions(function, Integer.MAX_VALUE);
        DecompileResults decompilation = decompile(function);
        String pseudocode = decompiledText(decompilation);
        if (pseudocode == null) {
            pseudocode = "";
        }
        List<Reference> incomingReferences = collectReferences(scan.instructions, "incoming")
            .stream()
            .filter(reference -> !function.getBody().contains(reference.getFromAddress()))
            .toList();
        List<Reference> outgoingReferences = collectReferences(scan.instructions, "outgoing");
        JsonArray incoming = referenceEdges(incomingReferences);
        JsonArray outgoing = referenceEdges(outgoingReferences);
        JsonArray comments = comments(scan.instructions);
        JsonArray callers = procedureIdentities(function.getCallingFunctions(monitor));
        JsonArray callees = procedureIdentities(function.getCalledFunctions(monitor));
        JsonArray referencedStrings = referencedStrings(outgoingReferences);
        JsonArray referencedNames = referencedNames(outgoingReferences);
        JsonArray blocks = basicBlockValues(function);
        JsonArray assembly = GSON.toJsonTree(renderAssemblyLines(scan.instructions))
            .getAsJsonArray();

        JsonObject procedure = procedureIdentity(function);
        procedure.addProperty("signature", function.getPrototypeString(false, true));
        procedure.add("locals", functionLocals(function));
        JsonObject result = new JsonObject();
        result.add("procedure", procedure);
        result.addProperty("pseudocode", pseudocode);
        result.add("assembly", assembly);
        result.add("comments", comments);
        result.add("callers", callers);
        result.add("callees", callees);
        result.add("incoming_references", incoming);
        result.add("outgoing_references", outgoing);
        result.add("referenced_strings", referencedStrings);
        result.add("referenced_names", referencedNames);
        result.add("basic_blocks", blocks);
        result.add(
            "native_api",
            nativeApiBoundary(function, decompilation)
        );
        result.add("native_value_flow", nativeValueFlow(decompilation));
        JsonArray limitations = new JsonArray();
        limitations.add(
            "Unresolved computed or indirect flows without target addresses are not represented as reference edges."
        );
        limitations.add(
            "Thunk and external classifications are Ghidra FunctionManager observations; they do not resolve targetless calls."
        );
        limitations.add(
            "Pseudocode and assembly are Ghidra-specific representations, not original source or Hopper-equivalent text."
        );
        limitations.add(
            "Synthetic Ghidra entry-point references without actionable memory sources are omitted."
        );
        if (decompilation != null && decompilation.getErrorMessage() != null &&
            !decompilation.getErrorMessage().isBlank()) {
            limitations.add("Ghidra decompiler diagnostic: " + decompilation.getErrorMessage());
        }
        result.add("limitations", limitations);
        return result;
    }

    private JsonObject nativeValueFlow(DecompileResults decompilation) throws Exception {
        HighFunction highFunction =
            decompilation == null ? null : decompilation.getHighFunction();
        if (highFunction == null) {
            JsonObject unavailable = new JsonObject();
            unavailable.addProperty("available", false);
            unavailable.addProperty(
                "reason",
                "Ghidra has no HighFunction p-code model for this procedure"
            );
            JsonArray limitations = new JsonArray();
            limitations.add(
                "No p-code operations or def-use relationships were recovered for this procedure."
            );
            unavailable.add("limitations", limitations);
            return unavailable;
        }

        List<PcodeOpAST> selected = new ArrayList<>();
        int omittedOperationsLowerBound = 0;
        Iterator<PcodeOpAST> operations = highFunction.getPcodeOps();
        while (operations.hasNext()) {
            monitor.checkCancelled();
            PcodeOpAST operation = operations.next();
            if (selected.size() >= MAX_HIGH_PCODE_OPS) {
                omittedOperationsLowerBound = 1;
                break;
            }
            selected.add(operation);
        }

        Map<PcodeOpAST, String> operationIds = new IdentityHashMap<>();
        for (PcodeOpAST operation : selected) {
            operationIds.put(operation, pcodeOperationId(operation));
        }
        JsonArray parameterUses = new JsonArray();
        JsonArray parameterValues = new JsonArray();
        FunctionPrototype prototype = highFunction.getFunctionPrototype();
        for (int ordinal = 0; ordinal < prototype.getNumParams(); ordinal++) {
            HighSymbol parameter = prototype.getParam(ordinal);
            if (parameter == null) continue;
            JsonObject value = new JsonObject();
            value.addProperty("ordinal", ordinal);
            value.addProperty("name", parameter.getName());
            value.addProperty("data_type", parameter.getDataType().getPathName());
            parameterValues.add(value);
        }
        JsonArray operationValues = new JsonArray();
        JsonArray defUse = new JsonArray();
        JsonArray effects = new JsonArray();
        int omittedInputs = 0;
        int omittedEdges = 0;
        for (PcodeOpAST operation : selected) {
            monitor.checkCancelled();
            String operationId = operationIds.get(operation);
            JsonObject value = new JsonObject();
            value.addProperty("id", operationId);
            value.addProperty(
                "address",
                canonicalAddress(operation.getSeqnum().getTarget())
            );
            value.addProperty("sequence", operation.getSeqnum().getTime());
            value.addProperty("opcode", operation.getMnemonic());
            value.addProperty("is_dead", operation.isDead());
            value.addProperty("block_membership", operation.getParent() == null ? "detached" : "member");
            JsonArray inputs = new JsonArray();
            int inputCount = operation.getNumInputs();
            int capturedInputs = Math.min(inputCount, MAX_HIGH_PCODE_INPUTS_PER_OP);
            for (int inputIndex = 0; inputIndex < capturedInputs; inputIndex += 1) {
                Varnode input = operation.getInput(inputIndex);
                inputs.add(varnodeValue(input));
                if (input instanceof VarnodeAST astInput) {
                    if (astInput.getHigh() instanceof HighParam parameter) {
                        if (parameterUses.size() >= MAX_HIGH_PCODE_DEF_USE_EDGES) omittedEdges++;
                        else {
                            JsonObject use = new JsonObject();
                            use.addProperty("ordinal", parameter.getSlot());
                            use.addProperty("use", operationId);
                            use.addProperty("input_index", inputIndex);
                            parameterUses.add(use);
                        }
                    }
                    PcodeOp definition = astInput.getDef();
                    if (definition instanceof PcodeOpAST astDefinition) {
                        String definitionId = operationIds.get(astDefinition);
                        if (definitionId == null || defUse.size() >= MAX_HIGH_PCODE_DEF_USE_EDGES) {
                            omittedEdges += 1;
                        } else {
                            JsonObject edge = new JsonObject();
                            edge.addProperty("definition", definitionId);
                            edge.addProperty("use", operationId);
                            edge.addProperty("input_index", inputIndex);
                            defUse.add(edge);
                        }
                    }
                }
            }
            omittedInputs += inputCount - capturedInputs;
            value.add("inputs", inputs);
            Varnode output = operation.getOutput();
            value.add("output", output == null ? JsonNull.INSTANCE : varnodeValue(output));
            operationValues.add(value);
            addPcodeEffect(effects, operation, operationId);
        }

        JsonObject result = new JsonObject();
        result.addProperty("available", true);
        result.addProperty("provenance", "ghidra-high-pcode");
        result.add("operations", operationValues);
        result.add("def_use", defUse);
        result.add("parameters", parameterValues);
        result.add("parameter_uses", parameterUses);
        result.add("effects", effects);
        boolean truncated = omittedOperationsLowerBound > 0 ||
            omittedInputs > 0 || omittedEdges > 0;
        result.addProperty("truncated", truncated);
        result.addProperty(
            "omitted_operations_lower_bound",
            omittedOperationsLowerBound
        );
        result.addProperty("known_omitted_inputs", omittedInputs);
        result.addProperty("known_omitted_edges", omittedEdges);
        JsonArray limitations = new JsonArray();
        limitations.add(
            "High p-code is decompiler-derived, not original source or runtime behavior. is_dead preserves the Java AST flag; decoded block members can retain that flag, so block_membership separately reports actual syntax-tree membership."
        );
        limitations.add(
            "Def-use links do not cross function boundaries and may omit memory aliasing, call side effects, or unresolved indirect flow."
        );
        limitations.add(
            "Memory read/write effects include stack and temporary memory operations; they do not identify persistent state or business meaning."
        );
        limitations.add(
            "Operation, input, and def-use limits can truncate large functions; inspect truncation, omitted lower bounds, and known omitted counts before drawing conclusions."
        );
        limitations.add(
            "Known omitted-edge counts cover links omitted from retained operations; omitted operations may contain additional uncounted links."
        );
        result.add("limitations", limitations);
        return result;
    }

    private String pcodeOperationId(PcodeOpAST operation) {
        return canonicalAddress(operation.getSeqnum().getTarget()) + "#" +
            operation.getSeqnum().getTime();
    }

    private JsonObject varnodeValue(Varnode varnode) {
        JsonObject result = new JsonObject();
        String kind = varnode.isConstant()
            ? "constant"
            : varnode.isAddress()
                ? "address"
                : varnode.isRegister()
                    ? "register"
                    : varnode.isUnique() ? "unique" : "other";
        result.addProperty("kind", kind);
        result.addProperty("size_bytes", varnode.getSize());
        result.add(
            "location",
            varnode.isConstant()
                ? JsonNull.INSTANCE
                : GSON.toJsonTree(canonicalAddress(varnode.getAddress()))
        );
        result.add(
            "constant_hex",
            varnode.isConstant()
                ? GSON.toJsonTree(Long.toUnsignedString(varnode.getOffset(), 16))
                : JsonNull.INSTANCE
        );
        return result;
    }

    private void addPcodeEffect(
        JsonArray destination,
        PcodeOp operation,
        String operationId
    ) {
        String kind = null;
        Integer operandInput = null;
        Integer valueInput = null;
        switch (operation.getOpcode()) {
            case PcodeOp.LOAD -> {
                kind = "memory_read";
                operandInput = 1;
            }
            case PcodeOp.STORE -> {
                kind = "memory_write";
                operandInput = 1;
                valueInput = 2;
            }
            case PcodeOp.CBRANCH -> {
                kind = "conditional_branch";
                valueInput = 1;
            }
            case PcodeOp.BRANCHIND -> {
                kind = "indirect_branch";
                operandInput = 0;
            }
            case PcodeOp.CALL -> {
                kind = "direct_call";
                operandInput = 0;
            }
            case PcodeOp.CALLIND -> {
                kind = "indirect_call";
                operandInput = 0;
            }
            default -> { }
        }
        if (kind == null) return;
        JsonObject effect = new JsonObject();
        effect.addProperty("operation", operationId);
        effect.addProperty("kind", kind);
        effect.add(
            "operand_input",
            operandInput == null ? JsonNull.INSTANCE : GSON.toJsonTree(operandInput)
        );
        effect.add(
            "value_input",
            valueInput == null ? JsonNull.INSTANCE : GSON.toJsonTree(valueInput)
        );
        destination.add(effect);
    }

    private JsonElement addressName(JsonObject params) {
        requireKeys(params, Set.of("document", "address"));
        requireDocument(params);
        Address address = requireAddress(params, "address");
        Symbol symbol = currentProgram.getSymbolTable().getPrimarySymbol(address);
        return symbol == null ? JsonNull.INSTANCE : GSON.toJsonTree(symbol.getName(true));
    }

    private JsonArray listDocuments(JsonObject params) {
        requireKeys(params, Set.of());
        JsonArray result = new JsonArray();
        result.add(currentProgram.getName());
        return result;
    }

    private JsonArray listNames(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "address"));
        requireDocument(params);
        List<InventoryItem> inventory = names();
        String requested = optionalString(params, "address");
        if (requested != null) {
            Address address = parseReaAddress(requested);
            inventory = inventory.stream()
                .filter(item -> item.address.equals(address))
                .toList();
        }
        return inventory(inventory, "symbol");
    }

    private JsonArray listProcedures(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document"));
        requireDocument(params);
        List<InventoryItem> inventory = procedures().stream()
            .map(FunctionEntry::item)
            .toList();
        return inventory(inventory, "procedure");
    }

    private JsonArray listSegments(JsonObject params) {
        requireKeys(params, Set.of("document"));
        requireDocument(params);
        JsonArray result = new JsonArray();
        String imageBase = canonicalAddress(currentProgram.getImageBase());
        MemoryBlock[] blocks = currentProgram.getMemory().getBlocks();
        List<MemoryBlock> ordered = new ArrayList<>(List.of(blocks));
        ordered.sort(Comparator.comparing(MemoryBlock::getStart));
        for (MemoryBlock block : ordered) {
            JsonObject item = memoryRegion(block, imageBase);
            item.add("sections", new JsonArray());
            result.add(item);
        }
        return result;
    }

    private JsonArray listStrings(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "address"));
        requireDocument(params);
        List<InventoryItem> inventory = strings();
        String requested = optionalString(params, "address");
        if (requested != null) {
            Address address = parseReaAddress(requested);
            inventory = inventory.stream()
                .filter(item -> item.address.equals(address))
                .toList();
        }
        return inventory(inventory, "string");
    }

    private JsonElement procedureAddress(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "procedure"));
        requireDocument(params);
        return GSON.toJsonTree(canonicalAddress(resolveProcedure(requireString(params, "procedure")).getEntryPoint()));
    }

    private JsonObject containingProcedure(JsonObject params) {
        requireKeys(params, Set.of("document", "address"));
        requireDocument(params);
        Address query = requireAddress(params, "address");
        Function function = currentProgram.getFunctionManager().getFunctionAt(query);
        if (function == null && query.isMemoryAddress()) {
            function = currentProgram.getFunctionManager().getFunctionContaining(query);
        }
        JsonObject result = new JsonObject();
        result.addProperty("query_address", canonicalAddress(query));
        if (function != null) {
            result.addProperty("found", true);
            result.add("procedure", procedureIdentity(function));
            return result;
        }
        result.addProperty("found", false);
        result.add("procedure", JsonNull.INSTANCE);
        boolean inside = query.isMemoryAddress() && currentProgram.getMemory().contains(query);
        result.addProperty("reason", inside ? "not_in_procedure" : "outside_segments");
        return result;
    }

    private JsonArray search(JsonObject params, boolean procedureSearch) throws Exception {
        requireKeys(
            params,
            Set.of("pattern", "mode", "case_sensitive", "document")
        );
        requireDocument(params);
        String expression = requireString(params, "pattern");
        String mode = requireString(params, "mode");
        if (!mode.equals("literal") && !mode.equals("regex")) {
            throw new RequestFailure("invalid_request", "mode must be literal or regex");
        }
        boolean caseSensitive = requireBoolean(params, "case_sensitive");
        List<InventoryItem> inventory = procedureSearch
            ? procedures().stream().map(FunctionEntry::item).toList()
            : strings();
        ValueMatcher matcher = mode.equals("literal")
            ? literalMatcher(expression, caseSensitive)
            : regexMatcher(expression, caseSensitive);
        JsonArray items = new JsonArray();
        for (InventoryItem item : inventory) {
            if (!matcher.matches(item.value)) {
                continue;
            }
            items.add(resultItem(item, null));
        }
        return items;
    }

    private List<InventoryItem> names() throws Exception {
        if (nameInventory != null) {
            return nameInventory;
        }
        List<InventoryItem> result = new ArrayList<>();
        SymbolIterator symbols = currentProgram.getSymbolTable().getAllSymbols(true);
        while (symbols.hasNext()) {
            monitor.checkCancelled();
            Symbol symbol = symbols.next();
            Address address = symbol.getAddress();
            if (!address.isMemoryAddress() && !address.isExternalAddress()) {
                continue;
            }
            JsonObject facts = new JsonObject();
            facts.addProperty("primary", symbol.isPrimary());
            facts.addProperty("dynamic", symbol.isDynamic());
            facts.addProperty("external", symbol.isExternal());
            facts.addProperty("type", normalizedSymbolType(symbol));
            facts.addProperty("source", normalizedSource(symbol.getSource()));
            result.add(new InventoryItem(address, symbol.getName(true), facts));
        }
        result.sort(INVENTORY_ORDER);
        nameInventory = List.copyOf(result);
        return nameInventory;
    }

    private List<FunctionEntry> procedures() throws Exception {
        if (procedureInventory != null) {
            return procedureInventory;
        }
        List<FunctionEntry> result = new ArrayList<>();
        Set<Address> seen = new HashSet<>();
        appendFunctions(result, seen, currentProgram.getFunctionManager().getFunctions(true));
        appendFunctions(result, seen, currentProgram.getFunctionManager().getExternalFunctions());
        result.sort((left, right) -> INVENTORY_ORDER.compare(left.item, right.item));
        procedureInventory = List.copyOf(result);
        return procedureInventory;
    }

    private void appendFunctions(
            List<FunctionEntry> destination,
            Set<Address> seen,
            FunctionIterator functions) throws Exception {
        while (functions.hasNext()) {
            monitor.checkCancelled();
            Function function = functions.next();
            if (!seen.add(function.getEntryPoint())) {
                continue;
            }
            JsonObject facts = new JsonObject();
            facts.addProperty("external", function.isExternal());
            facts.addProperty("thunk", function.isThunk());
            Function target = function.isThunk() ? function.getThunkedFunction(false) : null;
            if (target == null) {
                facts.add("thunk_target", JsonNull.INSTANCE);
            }
            else {
                facts.addProperty("thunk_target", canonicalAddress(target.getEntryPoint()));
            }
            Symbol symbol = function.getSymbol();
            InventoryItem item = new InventoryItem(
                function.getEntryPoint(),
                symbol == null ? function.getName() : symbol.getName(true),
                facts
            );
            destination.add(new FunctionEntry(function, item));
        }
    }

    private List<InventoryItem> strings() throws Exception {
        if (stringInventory != null) {
            return stringInventory;
        }
        List<InventoryItem> result = new ArrayList<>();
        DataIterator dataItems = currentProgram.getListing().getDefinedData(true);
        while (dataItems.hasNext()) {
            monitor.checkCancelled();
            Data data = dataItems.next();
            if (!data.hasStringValue()) {
                continue;
            }
            StringDataInstance instance = StringDataInstance.getStringDataInstance(data);
            String value = instance.getStringValue();
            if (value == null) {
                continue;
            }
            JsonObject facts = new JsonObject();
            String charset = instance.getCharsetName();
            facts.addProperty("encoding", charset == null || charset.isEmpty() ? "unknown" : charset);
            facts.addProperty(
                "termination",
                instance.isMissingNullTerminator() ? "missing" : "present_or_not_required"
            );
            facts.addProperty("byte_length", Math.max(0, data.getLength()));
            result.add(new InventoryItem(data.getAddress(), value, facts));
        }
        result.sort(INVENTORY_ORDER);
        stringInventory = List.copyOf(result);
        return stringInventory;
    }

    private Function resolveProcedure(String value) throws Exception {
        Address address = tryParseAddress(value);
        if (address != null) {
            Function function = currentProgram.getFunctionManager().getFunctionAt(address);
            if (function == null && address.isMemoryAddress()) {
                function = currentProgram.getFunctionManager().getFunctionContaining(address);
            }
            if (function == null) {
                throw new RequestFailure("not_found", "No procedure exists at the requested address");
            }
            return function;
        }
        List<Function> matches = new ArrayList<>();
        for (FunctionEntry entry : procedures()) {
            Function function = entry.function;
            Symbol symbol = function.getSymbol();
            String qualified = symbol == null ? function.getName() : symbol.getName(true);
            if (function.getName().equals(value) || qualified.equals(value)) {
                matches.add(function);
            }
        }
        if (matches.isEmpty()) {
            throw new RequestFailure("not_found", "Unknown Ghidra procedure name");
        }
        if (matches.size() != 1) {
            throw new RequestFailure("ambiguous", "Ghidra procedure name is ambiguous");
        }
        return matches.get(0);
    }

    private JsonObject nativeApiBoundary(
        Function function,
        DecompileResults decompilation
    ) throws Exception {
        if (decompilation == null || decompilation.getHighFunction() == null) {
            return unavailableNativeApiBoundary(
                "Ghidra has no HighFunction model for an external or bodyless procedure"
            );
        }

        HighFunction highFunction = decompilation.getHighFunction();
        FunctionPrototype prototype = highFunction.getFunctionPrototype();
        String signatureSource = function
            .getSignatureSource()
            .name()
            .toLowerCase(Locale.ROOT);
        JsonObject result = new JsonObject();
        result.addProperty("available", true);
        result.addProperty("provenance", "ghidra-high-function");
        result.addProperty("signature_source", signatureSource);
        String callingConvention = prototype.getModelName();
        result.addProperty(
            "calling_convention",
            callingConvention == null || callingConvention.isBlank()
                ? "unknown"
                : callingConvention
        );
        result.add(
            "return_type",
            inferredBoundaryType(
                "return",
                null,
                null,
                prototype.getReturnType(),
                prototype.getReturnStorage().toString(),
                false,
                signatureSource
            )
        );

        JsonArray parameters = new JsonArray();
        result.add("parameters", parameters);

        JsonArray jumpTables = new JsonArray();
        result.add("jump_tables", jumpTables);

        JsonObject pseudocode = new JsonObject();
        pseudocode.addProperty("classification", "decompiler-generated-non-source");
        pseudocode.addProperty("compilable", false);
        result.add("pseudocode", pseudocode);

        JsonArray artifacts = new JsonArray();
        artifacts.add("recovered-signature");
        artifacts.add("register-and-stack-variables");
        artifacts.add("compiler-generated-control-flow");
        artifacts.add("pointer-arithmetic");
        artifacts.add("pseudocode");
        result.add("decompiler_artifacts", artifacts);

        JsonArray limitations = new JsonArray();
        limitations.add(
            "Types and calling conventions are Ghidra decompiler observations, not source declarations."
        );
        limitations.add(
            "Register variables, compiler-generated blocks, and pointer arithmetic remain decompiler artifacts."
        );
        limitations.add(
            "Pseudocode is neither original source nor guaranteed to compile."
        );
        result.add("limitations", limitations);
        for (int index = 0; index < prototype.getNumParams(); index += 1) {
            HighSymbol parameter = prototype.getParam(index);
            if (parameter == null) {
                continue;
            }
            parameters.add(
                inferredBoundaryType(
                    "parameter",
                    index,
                    parameter.getName(),
                    parameter.getDataType(),
                    parameter.getStorage().toString(),
                    parameter.isTypeLocked(),
                    signatureSource
                )
            );
        }

        JumpTable[] recoveredJumpTables = highFunction.getJumpTables();
        List<ClangNode> caseTokens = new ArrayList<>();
        if (decompilation.getCCodeMarkup() != null) {
            decompilation.getCCodeMarkup().flatten(caseTokens);
        }
        for (int index = 0; index < recoveredJumpTables.length; index += 1) {
            jumpTables.add(inferredJumpTable(recoveredJumpTables[index], caseTokens));
        }
        return result;
    }

    private static JsonObject unavailableNativeApiBoundary(String reason) {
        JsonObject unavailable = new JsonObject();
        unavailable.addProperty("available", false);
        unavailable.addProperty("reason", reason);
        JsonArray unknowns = new JsonArray();
        unknowns.add("Return and parameter boundary types are unavailable.");
        unknowns.add("Jump-table mappings are unavailable.");
        unavailable.add("residual_unknowns", unknowns);
        return unavailable;
    }

    private static JsonObject inferredBoundaryType(
        String role,
        Integer ordinal,
        String name,
        DataType dataType,
        String storage,
        boolean typeLocked,
        String signatureSource
    ) {
        JsonObject result = new JsonObject();
        result.addProperty("role", role);
        if (ordinal == null) {
            result.add("ordinal", JsonNull.INSTANCE);
        }
        else {
            result.addProperty("ordinal", ordinal);
        }
        if (name == null || name.isBlank()) {
            result.add("name", JsonNull.INSTANCE);
        }
        else {
            result.addProperty("name", name);
        }
        result.addProperty("data_type", dataType.getDisplayName());
        int dataTypeLength = dataType.getLength();
        if (dataTypeLength < 0) {
            result.add("size_bytes", JsonNull.INSTANCE);
        }
        else {
            result.addProperty("size_bytes", dataTypeLength);
        }
        if (storage.isBlank()) {
            result.add("storage", JsonNull.INSTANCE);
        }
        else {
            result.addProperty("storage", storage);
        }
        result.addProperty(
            "confidence",
            inferenceConfidence(signatureSource, typeLocked)
        );

        JsonArray evidence = new JsonArray();
        evidence.add(
            inferenceEvidence(
                "signature-source",
                "ghidra-function-manager",
                "Function signature source is " + signatureSource + "."
            )
        );
        evidence.add(
            inferenceEvidence(
                "decompiler-type",
                "ghidra-high-function",
                "HighFunction recovered data type " + dataType.getDisplayName() + "."
            )
        );
        if (typeLocked) {
            evidence.add(
                inferenceEvidence(
                    "type-lock",
                    "ghidra-high-symbol",
                    "The decompiler marks this parameter type as locked."
                )
            );
        }
        result.add("evidence", evidence);

        JsonArray artifacts = new JsonArray();
        artifacts.add("recovered-signature");
        if (!storage.isBlank()) {
            artifacts.add("register-or-stack-storage");
        }
        if (name != null && (name.startsWith("param_") || name.startsWith("unaff_"))) {
            artifacts.add("compiler-generated-variable");
        }
        result.add("decompiler_artifacts", artifacts);
        return result;
    }

    private JsonObject inferredJumpTable(
        JumpTable jumpTable,
        List<ClangNode> caseTokens
    ) throws Exception {
        JsonObject result = new JsonObject();
        result.addProperty(
            "dispatch_address",
            canonicalAddress(jumpTable.getSwitchAddress())
        );
        JumpTable.LoadTable[] loadTables = jumpTable.getLoadTables();
        RecoveredAArch64RelativeTable recoveredAArch64 =
            loadTables.length == 0
                ? recoverAArch64RelativeTable(jumpTable)
                : null;
        List<Address> referencedDataAddresses = loadTables.length == 0
            ? dispatchPathDataReferences(jumpTable)
            : List.of();
        JsonArray dataSources = new JsonArray();
        for (int index = 0; index < loadTables.length; index += 1) {
            monitor.checkCancelled();
            JumpTable.LoadTable loadTable = loadTables[index];
            JsonObject source = new JsonObject();
            source.addProperty("address", canonicalAddress(loadTable.getAddress()));
            source.addProperty("provenance", "ghidra-decompiler-load-table");
            int entrySize = loadTable.getSize();
            int entryCount = loadTable.getNum();
            if (entrySize > 0) source.addProperty("entry_size_bytes", entrySize);
            else source.add("entry_size_bytes", JsonNull.INSTANCE);
            if (entryCount > 0) source.addProperty("entry_count", entryCount);
            else source.add("entry_count", JsonNull.INSTANCE);
            source.addProperty(
                "confidence",
                entrySize > 0 && entryCount > 0 ? "high" : "medium"
            );
            JsonArray evidence = new JsonArray();
            evidence.add(
                inferenceEvidence(
                    "jump-table",
                    "ghidra-high-function",
                    "Decompiler load table starts at " +
                    canonicalAddress(loadTable.getAddress()) +
                    "."
                )
            );
            source.add("evidence", evidence);
            dataSources.add(source);
        }
        if (recoveredAArch64 != null) {
            JsonObject source = new JsonObject();
            source.addProperty(
                "address",
                canonicalAddress(recoveredAArch64.tableAddress)
            );
            source.addProperty("provenance", recoveredAArch64.entrySize == 1 ? "ghidra-aarch64-byte-table" : "ghidra-aarch64-halfword-table");
            source.addProperty("entry_size_bytes", recoveredAArch64.entrySize);
            source.addProperty("entry_count", recoveredAArch64.mappings.size());
            source.addProperty("confidence", "high");
            JsonArray evidence = new JsonArray();
            evidence.add(
                inferenceEvidence(
                    "jump-table",
                    "ghidra-instruction-and-memory",
                    "Decoded " + recoveredAArch64.mappings.size() +
                    " entries of size " + recoveredAArch64.entrySize + " bytes from " + canonicalAddress(recoveredAArch64.tableAddress) +
                    "; the AArch64 LDRB-or-LDRH/ADR/ADD/BR chain uses a selector guarded by an unsigned upper-bound branch."
                )
            );
            source.add("evidence", evidence);
            dataSources.add(source);
        }
        for (int index = 0; index < referencedDataAddresses.size(); index += 1) {
            Address address = referencedDataAddresses.get(index);
            if (
                recoveredAArch64 != null &&
                recoveredAArch64.tableAddress.equals(address)
            ) {
                continue;
            }
            JsonObject source = new JsonObject();
            source.addProperty("address", canonicalAddress(address));
            source.addProperty(
                "provenance",
                "ghidra-dispatch-block-data-reference"
            );
            source.add("entry_size_bytes", JsonNull.INSTANCE);
            source.add("entry_count", JsonNull.INSTANCE);
            source.addProperty("confidence", "medium");
            JsonArray evidence = new JsonArray();
            evidence.add(
                inferenceEvidence(
                    "jump-table",
                    "ghidra-reference-manager",
                    "The dispatch block or an immediate predecessor contains a typed data reference to " +
                    canonicalAddress(address) +
                    "."
                )
            );
            source.add("evidence", evidence);
            dataSources.add(source);
        }
        result.add("data_sources", dataSources);
        Address[] targets = jumpTable.getCases();
        TypedJumpTableCases typedCases = typedJumpTableCases(jumpTable, caseTokens);
        JsonArray mappings = new JsonArray();
        JsonArray defaultTargets = new JsonArray();
        for (Address target : typedCases.defaults) {
            defaultTargets.add(typedJumpTableTarget(target, jumpTable, "Typed default label"));
        }
        Set<Address> coveredTargets = new HashSet<>(typedCases.cases.values());
        coveredTargets.addAll(typedCases.defaults);
        if (recoveredAArch64 != null) {
            for (int index = 0; index < recoveredAArch64.mappings.size(); index += 1) {
                monitor.checkCancelled();
                RecoveredAArch64Mapping recovered = recoveredAArch64.mappings.get(index);
                if (
                    typedCases.unknownTargets.contains(recovered.targetAddress) ||
                    typedCases.ambiguousValues.contains((long) recovered.caseValue)
                ) continue;
                Address typedTarget = typedCases.cases.get((long) recovered.caseValue);
                if (typedTarget != null && !typedTarget.equals(recovered.targetAddress)) {
                    typedCases.cases.remove((long) recovered.caseValue);
                    typedCases.ambiguousValues.add((long) recovered.caseValue);
                    typedCases.unknownTargets.add(typedTarget);
                    typedCases.unknownTargets.add(recovered.targetAddress);
                    typedCases.limitations.add(
                        "Typed case evidence and the verified relative table disagree on a destination; both destinations remain unknown for that case."
                    );
                    continue;
                }
                JsonObject mapping = new JsonObject();
                mapping.addProperty("case_value", recovered.caseValue);
                String targetAddress = canonicalAddress(recovered.targetAddress);
                mapping.addProperty("target_address", targetAddress);
                mapping.addProperty("confidence", "high");
                JsonArray evidence = new JsonArray();
                evidence.add(
                    inferenceEvidence(
                        "jump-table",
                        "ghidra-instruction-and-memory",
                        "Case value " + recovered.caseValue + (recoveredAArch64.entrySize == 1 ? " indexes byte " : " indexes halfword at byte offset ") +
                        (recovered.caseValue * recoveredAArch64.entrySize) + " at " + canonicalAddress(recoveredAArch64.tableAddress) +
                        "; the loaded unsigned entry selects a four-byte instruction offset from " +
                        canonicalAddress(recoveredAArch64.branchBase) + ", reaching " + targetAddress + "."
                    )
                );
                mapping.add("evidence", evidence);
                if (!typedCases.cases.containsKey((long) recovered.caseValue)) {
                    mappings.add(mapping);
                }
                coveredTargets.add(recovered.targetAddress);
            }
        }
        for (Map.Entry<Long, Address> entry : typedCases.cases.entrySet()) {
            JsonObject mapping = typedJumpTableTarget(
                entry.getValue(),
                jumpTable,
                "Typed case value " + entry.getKey()
            );
            mapping.addProperty("case_value", entry.getKey());
            mappings.add(mapping);
        }
        Set<Address> emittedUnknownTargets = new HashSet<>();
        for (int index = 0; index < targets.length; index += 1) {
            monitor.checkCancelled();
            boolean unresolvedToken = typedCases.unknownTargets.contains(targets[index]);
            if (coveredTargets.contains(targets[index]) && !unresolvedToken) continue;
            if (!emittedUnknownTargets.add(targets[index])) continue;
            JsonObject mapping = new JsonObject();
            mapping.add("case_value", JsonNull.INSTANCE);
            String targetAddress = canonicalAddress(targets[index]);
            mapping.addProperty("target_address", targetAddress);
            // Ghidra's recovered case-to-target relation does not identify
            // which backing load table produced an individual case. Keep the
            // table inventory and recovered mappings separate instead of
            // attaching every table address to every target.
            mapping.addProperty("confidence", "medium");
            JsonArray evidence = new JsonArray();
            evidence.add(
                inferenceEvidence(
                    "jump-table",
                    "ghidra-high-function",
                    "Ghidra recovered target " +
                          targetAddress +
                          " at dispatch " +
                          canonicalAddress(jumpTable.getSwitchAddress()) +
                          ", but no unambiguous, exactly representable case label or default relationship was available."
                )
            );
            mapping.add("evidence", evidence);
            mappings.add(mapping);
        }
        result.add("mappings", mappings);
        result.add("default_targets", defaultTargets);
        JsonArray limitations = new JsonArray();
        for (String limitation : typedCases.limitations) limitations.add(limitation);
        if (defaultTargets.isEmpty()) {
            limitations.add(
                "Ghidra exposed no typed default label with an unambiguous relationship to a recovered destination of this dispatch; default or out-of-range handling remains unknown."
            );
        }
        if (loadTables.length == 0 && referencedDataAddresses.isEmpty()) {
            limitations.add(
                "Ghidra recovered targets but exposed no backing load-table or dispatch-block data address."
            );
        }
        if (
            recoveredAArch64 == null &&
            loadTables.length == 0 &&
            !referencedDataAddresses.isEmpty()
        ) {
            limitations.add(
                "Load-table metadata was absent; table-level candidate ownership is inferred from typed data references in the dispatch block and its immediate control-flow predecessors, but candidates are not assigned to individual mappings."
            );
        }
        if (!emittedUnknownTargets.isEmpty()) {
            limitations.add(
                "Some recovered destinations lack an unambiguous, exactly representable case/default relationship; their case values remain unknown. Unequal label and destination arrays are never paired by index."
            );
        }
        if (recoveredAArch64 == null && loadTables.length == 0 && currentProgram.getLanguageID().getIdAsString().startsWith("AARCH64:")) {
            limitations.add("REA did not verify a supported byte/halfword relative dispatch chain with exact unsigned bounds and register definitions; unsupported encodings and ambiguous bounds remain unknown.");
        }
        if (targets.length == 0) {
            limitations.add(
                "Ghidra exposed a jump-table dispatch without recovered case targets."
            );
        }
        result.add("limitations", limitations);
        return result;
    }

    private static final class TypedJumpTableCases {
        private final Map<Long, Address> cases = new TreeMap<>();
        private final Set<Address> defaults = new java.util.TreeSet<>();
        private final Set<Address> unknownTargets = new HashSet<>();
        private final Set<Long> ambiguousValues = new HashSet<>();
        private final Set<String> limitations = new java.util.LinkedHashSet<>();
    }

    private TypedJumpTableCases typedJumpTableCases(
        JumpTable jumpTable,
        List<ClangNode> tokens
    ) throws Exception {
        TypedJumpTableCases result = new TypedJumpTableCases();
        Set<Address> targets = new HashSet<>();
        for (Address target : jumpTable.getCases()) targets.add(target);
        for (ClangNode node : tokens) {
            monitor.checkCancelled();
            if (!(node instanceof ClangCaseToken token)) continue;
            PcodeOp operation = token.getPcodeOp();
            if (operation == null || operation.getParent() == null) continue;
            PcodeBlockBasic block = operation.getParent();
            Address target = block.getStart();
            if (!targets.contains(target)) continue;
            PcodeOp dispatch = null;
            boolean ambiguousDispatch = false;
            boolean includesDispatch = false;
            for (int index = 0; index < block.getInSize(); index += 1) {
                PcodeBlock predecessor = block.getIn(index);
                if (!(predecessor instanceof PcodeBlockBasic basic)) continue;
                PcodeOp last = basic.getLastOp();
                if (last == null || last.getOpcode() != PcodeOp.BRANCHIND) continue;
                if (last.getSeqnum().getTarget().equals(jumpTable.getSwitchAddress())) {
                    includesDispatch = true;
                }
                if (dispatch != null && dispatch != last) ambiguousDispatch = true;
                dispatch = last;
            }
            if (!includesDispatch) continue;
            if (ambiguousDispatch) {
                result.unknownTargets.add(target);
                result.limitations.add(
                    "A typed case/default block has multiple indirect dispatch predecessors; REA cannot attribute its label to one switch."
                );
                continue;
            }
            // Default is a typed label role, not an OFF sentinel: Ghidra can
            // encode a default token with an ordinary in-range case value.
            if ("default".equals(token.getText())) {
                result.defaults.add(target);
                continue;
            }
            Long value = exactTypedCaseValue(token);
            if (value == null) {
                result.unknownTargets.add(target);
                result.limitations.add(
                    "Typed case label " + token.getText() +
                    " has encoded unsigned magnitude " + Long.toUnsignedString(token.getValue()) +
                    " at recovered target " + canonicalAddress(target) +
                    " for dispatch " + canonicalAddress(jumpTable.getSwitchAddress()) +
                    "; the label is nonliteral, inconsistent with its encoded magnitude, or outside the exact JSON integer range, so its numeric case value remains unknown."
                );
                continue;
            }
            if (result.ambiguousValues.contains(value)) {
                result.unknownTargets.add(target);
                continue;
            }
            Address previous = result.cases.putIfAbsent(value, target);
            if (previous != null && !previous.equals(target)) {
                result.cases.remove(value);
                result.ambiguousValues.add(value);
                result.unknownTargets.add(previous);
                result.unknownTargets.add(target);
                result.limitations.add(
                    "Typed tokens assign one case value to different recovered destinations; that case remains unknown."
                );
            }
        }
        return result;
    }

    private static Long exactTypedCaseValue(ClangCaseToken token) {
        String text = token.getText();
        if (text == null || !text.matches("-?(?:0[xX][0-9a-fA-F]+|[0-9]+)")) return null;
        boolean negative = text.startsWith("-");
        String literal = negative ? text.substring(1) : text;
        BigInteger magnitude = literal.startsWith("0x") || literal.startsWith("0X")
            ? new BigInteger(literal.substring(2), 16)
            : new BigInteger(literal, 10);
        // Negative numeric tokens carry an unsigned magnitude in OFF, so
        // getValue()/getScalar() alone would incorrectly emit positive cases.
        if (!magnitude.equals(new BigInteger(Long.toUnsignedString(token.getValue())))) return null;
        BigInteger value = negative ? magnitude.negate() : magnitude;
        if (value.abs().compareTo(BigInteger.valueOf(9007199254740991L)) > 0) return null;
        return value.longValueExact();
    }

    private static JsonObject typedJumpTableTarget(
        Address target,
        JumpTable table,
        String label
    ) {
        JsonObject result = new JsonObject();
        String address = canonicalAddress(target);
        result.addProperty("target_address", address);
        result.addProperty("confidence", "high");
        JsonArray evidence = new JsonArray();
        evidence.add(inferenceEvidence(
            "jump-table",
            "ghidra-clang-case-token",
            label + " belongs to the p-code block starting at recovered target " +
            address + "; its unique indirect dispatch predecessor is " +
            canonicalAddress(table.getSwitchAddress()) + "."
        ));
        result.add("evidence", evidence);
        return result;
    }

    private static final class RecoveredAArch64Mapping {
        private final int caseValue;
        private final Address targetAddress;

        private RecoveredAArch64Mapping(int caseValue, Address targetAddress) {
            this.caseValue = caseValue;
            this.targetAddress = targetAddress;
        }
    }

    private static final class RecoveredAArch64RelativeTable {
        private final Address tableAddress;
        private final Address branchBase;
        private final int entrySize;
        private final List<RecoveredAArch64Mapping> mappings;

        private RecoveredAArch64RelativeTable(
            Address tableAddress,
            Address branchBase,
            int entrySize,
            List<RecoveredAArch64Mapping> mappings
        ) {
            this.tableAddress = tableAddress;
            this.branchBase = branchBase;
            this.entrySize = entrySize;
            this.mappings = mappings;
        }
    }

    /**
     * Recover only the directly verified AArch64 byte/halfword-indexed relative branch
     * table form. Other instruction sequences keep their case labels unknown.
     */
    private RecoveredAArch64RelativeTable recoverAArch64RelativeTable(
        JumpTable jumpTable
    ) throws Exception {
        if (!currentProgram.getLanguageID().getIdAsString().startsWith("AARCH64:")) {
            return null;
        }
        Function function = containingFunction(jumpTable.getSwitchAddress());
        if (function == null) return null;

        List<Instruction> instructions = new ArrayList<>();
        InstructionIterator iterator = currentProgram.getListing().getInstructions(
            function.getBody(), true
        );
        while (iterator.hasNext()) {
            monitor.checkCancelled();
            Instruction instruction = iterator.next();
            instructions.add(instruction);
            if (instruction.getAddress().equals(jumpTable.getSwitchAddress())) break;
        }
        int branchIndex = instructions.size() - 1;
        if (branchIndex < 1 ||
            !instructions.get(branchIndex).getMnemonicString().equalsIgnoreCase("BR")) {
            return null;
        }

        Address[] recoveredTargets = jumpTable.getCases();
        Set<String> recoveredTargetSet = new HashSet<>();
        for (Address target : recoveredTargets) recoveredTargetSet.add(canonicalAddress(target));
        List<Address> dataAddresses = dispatchPathDataReferences(jumpTable);

        for (int loadIndex = 0; loadIndex < branchIndex; loadIndex += 1) {
            Instruction load = instructions.get(loadIndex);
            int entrySize = load.getMnemonicString().equalsIgnoreCase("LDRB") ? 1 : load.getMnemonicString().equalsIgnoreCase("LDRH") ? 2 : 0;
            if (entrySize == 0 || branchIndex != loadIndex + 2 || loadIndex < 3 ||
                !instructions.get(loadIndex - 1).getMnemonicString().equalsIgnoreCase("ADR") ||
                !instructions.get(loadIndex - 2).getMnemonicString().equalsIgnoreCase("ADD") ||
                !instructions.get(loadIndex - 3).getMnemonicString().equalsIgnoreCase("ADRP")) continue;
            String loadOperands = operands(load);
            java.util.regex.Matcher loadMatcher = java.util.regex.Pattern
                .compile(entrySize == 1 ? "(?i)^[wx]\\d+,\\s*\\[([wx]\\d+),\\s*([wx]\\d+)\\]$" : "(?i)^[wx]\\d+,\\s*\\[([wx]\\d+),\\s*([wx]\\d+),\\s*LSL\\s*#(?:0x)?1\\]$")
                .matcher(loadOperands);
            if (!loadMatcher.matches()) continue;
            String loadedRegister = normalizedRegister(loadOperands.substring(0, loadOperands.indexOf(',')));
            String tableBaseRegister = normalizedRegister(loadMatcher.group(1));
            String indexRegister = normalizedRegister(loadMatcher.group(2));

            Address resolvedTableAddress = null;
            for (int index = loadIndex - 3; index < loadIndex - 1; index += 1) {
                Instruction instruction = instructions.get(index);
                String mnemonic = instruction.getMnemonicString().toUpperCase(Locale.ROOT);
                String text = operands(instruction);
                if (mnemonic.equals("ADRP") &&
                    text.matches("(?i)^[wx]\\d+,\\s*0x[0-9a-f]+$")) {
                    String[] parts = text.split(",");
                    if (normalizedRegister(parts[0]).equals(tableBaseRegister)) {
                        resolvedTableAddress = addressFromOperand(parts[1]);
                    }
                }
                else if (mnemonic.equals("ADD") && resolvedTableAddress != null &&
                    text.matches("(?i)^[wx]\\d+,\\s*[wx]\\d+,\\s*#?(?:0x[0-9a-f]+|[0-9]+)$")) {
                    String[] parts = text.split(",");
                    if (normalizedRegister(parts[0]).equals(tableBaseRegister) &&
                        normalizedRegister(parts[1]).equals(tableBaseRegister)) {
                        resolvedTableAddress = resolvedTableAddress.add(parseInteger(parts[2].trim().replaceFirst("^#", "")));
                    }
                }
            }
            if (resolvedTableAddress == null || !currentProgram.getMemory().contains(resolvedTableAddress) ||
                (!dataAddresses.isEmpty() && !dataAddresses.contains(resolvedTableAddress))) continue;
            Address tableAddress = resolvedTableAddress;

            Address branchBase = null;
            boolean addressChain = false;
            for (int index = loadIndex - 1; index < branchIndex; index += 1) {
                Instruction instruction = instructions.get(index);
                String mnemonic = instruction.getMnemonicString().toUpperCase(Locale.ROOT);
                String text = operands(instruction);
                if (index < loadIndex && mnemonic.equals("ADR") && text.matches("(?i)^[wx]\\d+,\\s*0x[0-9a-f]+$")) {
                    int comma = text.indexOf(',');
                    String destination = normalizedRegister(text.substring(0, comma));
                    if (!destination.equals(normalizedRegister(operands(instructions.get(branchIndex))))) continue;
                    branchBase = addressFromOperand(text.substring(comma + 1));
                }
                if (index > loadIndex && mnemonic.equals("ADD") && branchBase != null &&
                    text.matches("(?i)^[wx]\\d+,\\s*[wx]\\d+,\\s*[wx]\\d+,\\s*LSL\\s*#(?:0x)?2$")) {
                    String[] parts = text.split(",");
                    String destination = normalizedRegister(parts[0]);
                    String base = normalizedRegister(parts[1]);
                    String offset = normalizedRegister(parts[2]);
                    if (destination.equals(base) &&
                        base.equals(normalizedRegister(operands(instructions.get(branchIndex)))) &&
                        offset.equals(loadedRegister)) {
                        addressChain = true;
                    }
                }
            }
            if (!addressChain || branchBase == null) continue;

            int entryCount = -1;
            Address defaultTarget = null;
            for (int compareIndex = 0; compareIndex < loadIndex; compareIndex += 1) {
                Instruction compare = instructions.get(compareIndex);
                if (!compare.getMnemonicString().equalsIgnoreCase("CMP")) continue;
                java.util.regex.Matcher compareMatcher = java.util.regex.Pattern
                    .compile("(?i)^([wx]\\d+),\\s*#?(0x[0-9a-f]+|[0-9]+)$")
                    .matcher(operands(compare));
                if (!compareMatcher.matches()) continue;
                String comparedRegister = normalizedRegister(compareMatcher.group(1));
                long upperBound = parseInteger(compareMatcher.group(2));
                if (upperBound < 0 || upperBound >= 4096) continue;
                for (int guardIndex = compareIndex + 1; guardIndex < loadIndex; guardIndex += 1) {
                    Instruction guard = instructions.get(guardIndex);
                    String mnemonic = guard.getMnemonicString().toUpperCase(Locale.ROOT);
                    if (!mnemonic.equals("B.HI")) continue;
                    Address[] flows = guard.getFlows();
                    if (flows.length != 1 || !recoveredTargetSet.contains(canonicalAddress(flows[0]))) continue;
                    boolean supportedSequence = true;
                    for (int sequenceIndex = compareIndex + 1; sequenceIndex < loadIndex; sequenceIndex += 1) {
                        String sequenceMnemonic = instructions.get(sequenceIndex)
                            .getMnemonicString().toUpperCase(Locale.ROOT);
                        if (!Set.of("B.HI", "MOV", "ADRP", "ADD", "ADR").contains(sequenceMnemonic)) {
                            supportedSequence = false;
                            break;
                        }
                    }
                    Set<String> selectorAliases = new HashSet<>();
                    selectorAliases.add(comparedRegister);
                    Set<String> boundedIndexes = new HashSet<>();
                    if (compareMatcher.group(1).toLowerCase(Locale.ROOT).startsWith("x")) boundedIndexes.add(comparedRegister);
                    for (int sequenceIndex = compareIndex + 1; sequenceIndex < loadIndex; sequenceIndex++) {
                        Instruction instruction = instructions.get(sequenceIndex);
                        String[] parts = operands(instruction).split(",");
                        if (parts.length == 0) continue;
                        if (instruction.getMnemonicString().equalsIgnoreCase("MOV")) {
                            String destination = normalizedRegister(parts[0]);
                            String source = parts.length == 2 ? normalizedRegister(parts[1]) : "";
                            boolean aliasesSelector = selectorAliases.contains(source);
                            boolean fullWidthBounded = boundedIndexes.contains(source) ||
                                (parts[0].trim().toLowerCase(Locale.ROOT).startsWith("w") && aliasesSelector);
                            if (aliasesSelector) selectorAliases.add(destination);
                            else selectorAliases.remove(destination);
                            if (fullWidthBounded) boundedIndexes.add(destination);
                            else boundedIndexes.remove(destination);
                        } else if (Set.of("ADRP", "ADD", "ADR").contains(instruction.getMnemonicString().toUpperCase(Locale.ROOT))) {
                            selectorAliases.remove(normalizedRegister(parts[0]));
                            boundedIndexes.remove(normalizedRegister(parts[0]));
                        }
                    }
                    boolean selectorFeedsTable = boundedIndexes.contains(indexRegister);
                    if (compareIndex < loadIndex - 3 && selectorFeedsTable && supportedSequence) {
                        entryCount = (int) upperBound + 1;
                        defaultTarget = flows[0];
                        break;
                    }
                }
                if (entryCount > 0) break;
            }
            if (entryCount <= 0 || entryCount > 4096 || defaultTarget == null) continue;

            List<RecoveredAArch64Mapping> mappings = new ArrayList<>();
            Set<String> mappedTargets = new HashSet<>();
            boolean valid = true;
            for (int caseValue = 0; caseValue < entryCount; caseValue += 1) {
                Address entry = tableAddress.add((long) caseValue * entrySize);
                int encodedOffset = entrySize == 1 ? currentProgram.getMemory().getByte(entry) & 0xff : currentProgram.getMemory().getShort(entry) & 0xffff;
                Address target = branchBase.add((long) encodedOffset * 4L);
                String canonicalTarget = canonicalAddress(target);
                if (!recoveredTargetSet.contains(canonicalTarget)) {
                    valid = false;
                    break;
                }
                mappedTargets.add(canonicalTarget);
                mappings.add(new RecoveredAArch64Mapping(caseValue, target));
            }
            if (!valid || mappedTargets.contains(canonicalAddress(defaultTarget))) continue;
            Set<String> accountedTargets = new HashSet<>(mappedTargets);
            accountedTargets.add(canonicalAddress(defaultTarget));
            if (!accountedTargets.equals(recoveredTargetSet)) continue;
            return new RecoveredAArch64RelativeTable(tableAddress, branchBase, entrySize, List.copyOf(mappings));
        }
        return null;
    }

    private static String operands(Instruction instruction) {
        List<String> values = new ArrayList<>();
        for (int index = 0; index < instruction.getNumOperands(); index += 1) {
            values.add(instruction.getDefaultOperandRepresentation(index));
        }
        return String.join(", ", values);
    }

    private static String normalizedRegister(String value) {
        String register = value.trim().toLowerCase(Locale.ROOT);
        return register.matches("[wx]\\d+") ? "r" + register.substring(1) : register;
    }

    private static long parseInteger(String value) {
        String number = value.toLowerCase(Locale.ROOT);
        return number.startsWith("0x")
            ? Long.parseUnsignedLong(number.substring(2), 16)
            : Long.parseLong(number);
    }

    private Address addressFromOperand(String value) {
        String hex = value.trim().replaceFirst("(?i)^0x", "");
        return currentProgram.getAddressFactory().getDefaultAddressSpace()
            .getAddress(Long.parseUnsignedLong(hex, 16));
    }

    private List<Address> dispatchPathDataReferences(JumpTable jumpTable)
        throws Exception {
        BasicBlockModel model = new BasicBlockModel(currentProgram, false);
        CodeBlock dispatchBlock = model.getFirstCodeBlockContaining(
            jumpTable.getSwitchAddress(),
            monitor
        );
        if (dispatchBlock == null) {
            return List.of();
        }
        List<CodeBlock> blocks = new ArrayList<>();
        blocks.add(dispatchBlock);
        CodeBlockReferenceIterator sources = dispatchBlock.getSources(monitor);
        while (sources.hasNext()) {
            monitor.checkCancelled();
            CodeBlock sourceBlock = sources.next().getSourceBlock();
            if (sourceBlock != null) {
                blocks.add(sourceBlock);
            }
        }
        Set<Address> addresses = new HashSet<>();
        for (CodeBlock block : blocks) {
            InstructionIterator instructions = currentProgram
                .getListing()
                .getInstructions(block, true);
            while (instructions.hasNext()) {
                monitor.checkCancelled();
                Instruction instruction = instructions.next();
                for (
                    Reference reference : currentProgram
                        .getReferenceManager()
                        .getReferencesFrom(instruction.getAddress())
                ) {
                    if (
                        reference.getReferenceType().isData() &&
                        currentProgram
                            .getMemory()
                            .getLoadedAndInitializedAddressSet()
                            .contains(reference.getToAddress())
                    ) {
                        addresses.add(reference.getToAddress());
                    }
                }
            }
        }
        List<Address> ordered = new ArrayList<>(addresses);
        ordered.sort(Address::compareTo);
        return List.copyOf(ordered);
    }

    private static JsonObject inferenceEvidence(
        String kind,
        String source,
        String detail
    ) {
        JsonObject evidence = new JsonObject();
        evidence.addProperty("kind", kind);
        evidence.addProperty("source", source);
        evidence.addProperty("detail", detail);
        return evidence;
    }

    private static String inferenceConfidence(
        String signatureSource,
        boolean typeLocked
    ) {
        if (
            typeLocked ||
            signatureSource.equals("user_defined") ||
            signatureSource.equals("imported")
        ) {
            return "high";
        }
        return signatureSource.equals("analysis") ? "medium" : "low";
    }

    private DecompileResults decompile(Function function) {
        if (function.isExternal() || function.getBody().isEmpty()) {
            return null;
        }
        DecompileResults results = decompiler.decompileFunction(
            function,
            0,
            monitor
        );
        if (results.isCancelled()) {
            throw new RequestFailure("decompile_cancelled", "Ghidra decompilation was cancelled");
        }
        if (!results.decompileCompleted()) {
            throw new RequestFailure(
                "decompile_failed",
                "Ghidra decompilation failed: " + diagnosticMessage(results.getErrorMessage())
            );
        }
        return results;
    }

    private static String decompiledText(DecompileResults results) {
        if (results == null) {
            return null;
        }
        DecompiledFunction value = results.getDecompiledFunction();
        return value == null ? null : value.getC();
    }

    private InstructionScan scanInstructions(Function function, int maximum) throws Exception {
        InstructionIterator iterator = currentProgram.getListing().getInstructions(
            function.getBody(),
            true
        );
        List<Instruction> instructions = new ArrayList<>();
        while (iterator.hasNext() && instructions.size() < maximum) {
            monitor.checkCancelled();
            instructions.add(iterator.next());
        }
        return new InstructionScan(List.copyOf(instructions), iterator.hasNext());
    }

    private static String renderAssembly(List<Instruction> instructions) {
        return String.join("\n", renderAssemblyLines(instructions));
    }

    private static List<String> renderAssemblyLines(List<Instruction> instructions) {
        List<String> result = new ArrayList<>();
        for (Instruction instruction : instructions) {
            StringBuilder line = new StringBuilder();
            line.append(canonicalAddress(instruction.getAddress()));
            line.append(": ");
            line.append(instruction.getMnemonicString());
            for (int index = 0; index < instruction.getNumOperands(); index += 1) {
                line.append(index == 0 ? " " : ", ");
                line.append(instruction.getDefaultOperandRepresentation(index));
            }
            result.add(line.toString());
        }
        return result;
    }

    private List<Reference> collectReferences(
            List<Instruction> instructions,
            String direction) throws Exception {
        TreeMap<String, Reference> observed = new TreeMap<>();
        for (Instruction instruction : instructions) {
            monitor.checkCancelled();
            if (direction.equals("outgoing")) {
                for (Reference reference : currentProgram.getReferenceManager()
                        .getReferencesFrom(instruction.getAddress())) {
                    addReference(observed, reference);
                }
            }
            else {
                ReferenceIterator iterator = currentProgram.getReferenceManager()
                    .getReferencesTo(instruction.getAddress());
                while (iterator.hasNext()) {
                    addReference(observed, iterator.next());
                }
            }
        }
        List<Reference> result = new ArrayList<>(observed.values());
        result.sort(REFERENCE_ORDER);
        return result;
    }

    private static void addReference(TreeMap<String, Reference> observed, Reference reference) {
        if (reference.isEntryPointReference()) {
            return;
        }
        String key = canonicalAddress(reference.getFromAddress()) + "\u0000" +
            canonicalAddress(reference.getToAddress()) + "\u0000" +
            reference.getReferenceType().getName() + "\u0000" +
            reference.getOperandIndex() + "\u0000" +
            reference.isPrimary();
        observed.putIfAbsent(key, reference);
    }

    private JsonArray referenceEdges(List<Reference> references) {
        JsonArray result = new JsonArray();
        for (Reference reference : references) {
            result.add(referenceEdge(reference));
        }
        return result;
    }

    private JsonObject referenceEdge(Reference reference) {
        JsonObject result = new JsonObject();
        result.addProperty("source_address", canonicalAddress(reference.getFromAddress()));
        result.addProperty("target_address", canonicalAddress(reference.getToAddress()));
        Function source = containingFunction(reference.getFromAddress());
        Function target = containingFunction(reference.getToAddress());
        result.add(
            "source_procedure",
            source == null ? JsonNull.INSTANCE : procedureIdentity(source)
        );
        result.add(
            "target_procedure",
            target == null ? JsonNull.INSTANCE : procedureIdentity(target)
        );
        result.add("kind", referenceKind(reference));
        return result;
    }

    private static JsonObject referenceKind(Reference reference) {
        RefType type = reference.getReferenceType();
        JsonObject result = new JsonObject();
        result.addProperty("available", true);
        result.addProperty("provenance", "ghidra-reference-manager");
        result.addProperty("type", type.getName());
        result.addProperty("flow", type.isFlow());
        result.addProperty("call", type.isCall());
        result.addProperty("jump", type.isJump());
        result.addProperty("data", type.isData());
        result.addProperty("read", type.isRead());
        result.addProperty("write", type.isWrite());
        result.addProperty("indirect", type.isIndirect());
        result.addProperty("computed", type.isComputed());
        result.addProperty("conditional", type.isConditional());
        result.addProperty("terminal", type.isTerminal());
        result.addProperty("primary", reference.isPrimary());
        result.addProperty("operand_index", reference.getOperandIndex());
        result.addProperty("external", reference.isExternalReference());
        return result;
    }

    private Function containingFunction(Address address) {
        Function result = currentProgram.getFunctionManager().getFunctionAt(address);
        if (result == null && address.isMemoryAddress()) {
            result = currentProgram.getFunctionManager().getFunctionContaining(address);
        }
        return result;
    }

    private static String procedureName(Function function) {
        Symbol symbol = function.getSymbol();
        return symbol == null ? function.getName() : symbol.getName(true);
    }

    private static JsonObject functionClassification(Function function) {
        JsonObject result = new JsonObject();
        result.addProperty("external", function.isExternal());
        result.addProperty("thunk", function.isThunk());
        Function target = function.isThunk() ? function.getThunkedFunction(false) : null;
        if (target == null) {
            result.add("thunk_target", JsonNull.INSTANCE);
        }
        else {
            result.addProperty("thunk_target", canonicalAddress(target.getEntryPoint()));
        }
        result.addProperty("provenance", "ghidra-function-manager");
        return result;
    }

    private static JsonArray functionLocals(Function function) {
        Variable[] variables = function.getLocalVariables();
        List<Variable> ordered = new ArrayList<>(List.of(variables));
        ordered.sort(
            Comparator.comparing(Variable::getName)
                .thenComparing(variable -> variable.getVariableStorage().toString())
        );
        JsonArray result = new JsonArray();
        for (Variable variable : ordered) {
            JsonObject item = new JsonObject();
            item.addProperty(
                "description",
                variable.getDataType().getDisplayName() + " " + variable.getName() +
                    " @ " + variable.getVariableStorage()
            );
            item.addProperty("provenance", "ghidra-function-database");
            result.add(item);
        }
        return result;
    }

    private JsonArray procedureIdentities(Set<Function> functions) {
        List<Function> ordered = new ArrayList<>(functions);
        ordered.sort(Comparator.comparing(Function::getEntryPoint));
        JsonArray result = new JsonArray();
        for (Function function : ordered) {
            result.add(procedureIdentity(function));
        }
        return result;
    }

    private List<CodeBlock> basicBlocks(Function function) throws Exception {
        BasicBlockModel model = new BasicBlockModel(currentProgram, false);
        CodeBlockIterator iterator = model.getCodeBlocksContaining(function.getBody(), monitor);
        List<CodeBlock> result = new ArrayList<>();
        while (iterator.hasNext()) {
            monitor.checkCancelled();
            result.add(iterator.next());
        }
        result.sort(Comparator.comparing(CodeBlock::getFirstStartAddress));
        return result;
    }

    private JsonArray basicBlockValues(Function function) throws Exception {
        JsonArray result = new JsonArray();
        for (CodeBlock block : basicBlocks(function)) {
            JsonObject item = new JsonObject();
            item.addProperty("start", canonicalAddress(block.getFirstStartAddress()));
            item.addProperty("end", exclusiveAddress(block.getMaxAddress()));
            Set<Address> successors = new HashSet<>();
            CodeBlockReferenceIterator destinations = block.getDestinations(monitor);
            while (destinations.hasNext()) {
                CodeBlockReference destination = destinations.next();
                CodeBlock destinationBlock = destination.getDestinationBlock();
                if (destinationBlock == null) {
                    continue;
                }
                Address address = destinationBlock.getFirstStartAddress();
                if (
                    !destination.getFlowType().isCall() &&
                    function.getBody().contains(address)
                ) {
                    successors.add(address);
                }
            }
            List<Address> ordered = new ArrayList<>(successors);
            ordered.sort(Address::compareTo);
            JsonArray values = new JsonArray();
            for (Address address : ordered) {
                values.add(canonicalAddress(address));
            }
            item.add("successors", values);
            result.add(item);
        }
        return result;
    }

    private static JsonArray comments(List<Instruction> instructions) {
        TreeMap<String, JsonObject> observed = new TreeMap<>();
        for (Instruction instruction : instructions) {
            for (CommentType type : CommentType.values()) {
                String text = instruction.getComment(type);
                if (text == null || text.isEmpty()) {
                    continue;
                }
                String kind = type == CommentType.EOL ? "inline" : "comment";
                JsonObject item = new JsonObject();
                item.addProperty("address", canonicalAddress(instruction.getAddress()));
                item.addProperty("kind", kind);
                item.addProperty("text", text);
                String key = canonicalAddress(instruction.getAddress()) + "\u0000" +
                    kind + "\u0000" + type.name() + "\u0000" + text;
                observed.put(key, item);
                    }
        }
        JsonArray result = new JsonArray();
        observed.values().forEach(result::add);
        return result;
    }

    private JsonArray referencedStrings(List<Reference> references) {
        TreeMap<String, JsonObject> observed = new TreeMap<>();
        for (Reference reference : references) {
            Data data = currentProgram.getListing().getDefinedDataContaining(
                reference.getToAddress()
            );
            if (data == null || !data.hasStringValue()) {
                continue;
            }
            String value = StringDataInstance.getStringDataInstance(data).getStringValue();
            if (value == null) {
                continue;
            }
            JsonObject item = new JsonObject();
            item.addProperty("address", canonicalAddress(data.getAddress()));
            item.addProperty("value", value);
            item.addProperty("source_address", canonicalAddress(reference.getFromAddress()));
            String key = canonicalAddress(data.getAddress()) + "\u0000" + value + "\u0000" +
                canonicalAddress(reference.getFromAddress());
            observed.put(key, item);
            }
        JsonArray result = new JsonArray();
        observed.values().forEach(result::add);
        return result;
    }

    private JsonArray referencedNames(List<Reference> references) {
        TreeMap<String, JsonObject> observed = new TreeMap<>();
        for (Reference reference : references) {
            Symbol symbol = currentProgram.getSymbolTable().getPrimarySymbol(
                reference.getToAddress()
            );
            if (symbol == null) {
                continue;
            }
            JsonObject item = new JsonObject();
            item.addProperty("address", canonicalAddress(reference.getToAddress()));
            item.addProperty("value", symbol.getName(true));
            item.addProperty("source_address", canonicalAddress(reference.getFromAddress()));
            String key = canonicalAddress(reference.getToAddress()) + "\u0000" +
                symbol.getName(true) + "\u0000" + canonicalAddress(reference.getFromAddress());
            observed.put(key, item);
            }
        JsonArray result = new JsonArray();
        observed.values().forEach(result::add);
        return result;
    }

    private static String exclusiveAddress(Address inclusive) {
        Address next = inclusive.next();
        if (next != null && next.getAddressSpace().equals(inclusive.getAddressSpace())) {
            return canonicalAddress(next);
        }
        BigInteger offset = new BigInteger(Long.toUnsignedString(inclusive.getOffset()));
        return canonicalOffset(inclusive.getAddressSpace(), offset.add(BigInteger.ONE));
    }

    private static String diagnosticMessage(String value) {
        if (value == null || value.isBlank()) {
            return "native decompiler returned no detail";
        }
        return value.replaceAll("[\\r\\n]+", " ");
    }

    private JsonArray inventory(
        List<InventoryItem> inventory,
        String factsName) throws Exception {
        JsonArray result = new JsonArray();
        for (InventoryItem item : inventory) {
            monitor.checkCancelled();
            result.add(resultItem(item, factsName));
        }
        return result;
    }

    private static JsonObject resultItem(InventoryItem item, String factsName) {
        JsonObject result = new JsonObject();
        result.addProperty("address", canonicalAddress(item.address));
        result.addProperty("value", item.value);
        if (factsName != null) {
            result.add(factsName, item.facts.deepCopy());
        }
        return result;
    }

    private static JsonObject memoryRegion(MemoryBlock block, String imageBase) {
        JsonObject permissions = new JsonObject();
        permissions.addProperty("available", true);
        permissions.addProperty("source", "ghidra-memory-block");
        JsonObject result = new JsonObject();
        result.addProperty("name", block.getName());
        result.addProperty("start", canonicalAddress(block.getStart()));
        result.addProperty("end", exclusiveEnd(block));
        result.addProperty("readable", block.isRead());
        result.addProperty("writable", block.isWrite());
        result.addProperty("executable", block.isExecute());
        result.add("permissions", permissions);
        result.addProperty("provenance", "ghidra-memory-block");
        result.addProperty("address_space", block.getStart().getAddressSpace().getName());
        result.addProperty("image_base", imageBase);
        result.addProperty("initialized", block.isInitialized());
        result.addProperty("overlay", block.isOverlay());
        return result;
    }

    private static JsonObject procedureIdentity(Function function) {
        JsonObject result = new JsonObject();
        result.addProperty("address", canonicalAddress(function.getEntryPoint()));
        result.addProperty("name", procedureName(function));
        result.add("classification", functionClassification(function));
        result.add("body", functionBody(function));
        return result;
    }

    /** Observe the entire AddressSet; range endpoints are inclusive, not a guessed span. */
    private static JsonObject functionBody(Function function) {
        JsonArray ranges = new JsonArray();
        BigInteger total = BigInteger.ZERO;
        Address first = null;
        Address last = null;
        AddressSpace space = null;
        boolean multipleSpaces = false;
        AddressRangeIterator iterator = function.getBody().getAddressRanges(true);
        while (iterator.hasNext()) {
            AddressRange range = iterator.next();
            Address start = range.getMinAddress();
            Address end = range.getMaxAddress();
            if (start.getAddressSpace().getAddressableUnitSize() != 1) {
                throw new IllegalStateException("Function body byte coverage requires a byte-addressed space");
            }
            JsonObject value = new JsonObject();
            value.addProperty("start", canonicalAddress(start));
            value.addProperty("end", canonicalAddress(end));
            ranges.add(value);
            BigInteger begin = new BigInteger(Long.toUnsignedString(start.getOffset()));
            BigInteger finish = new BigInteger(Long.toUnsignedString(end.getOffset()));
            total = total.add(finish.subtract(begin).add(BigInteger.ONE));
            if (first == null) {
                first = start;
                space = start.getAddressSpace();
            } else if (!space.equals(start.getAddressSpace())) {
                multipleSpaces = true;
            }
            last = end;
        }
        JsonObject result = new JsonObject();
        result.addProperty("available", true);
        result.addProperty("provenance", "ghidra-function-body-address-set");
        result.add("ranges", ranges);
        result.addProperty("total_bytes", safeBodyByteCount(total));
        if (multipleSpaces) {
            result.add("span_bytes", JsonNull.INSTANCE);
        } else {
            BigInteger span = first == null ? BigInteger.ZERO :
                new BigInteger(Long.toUnsignedString(last.getOffset()))
                    .subtract(new BigInteger(Long.toUnsignedString(first.getOffset())))
                    .add(BigInteger.ONE);
            result.addProperty("span_bytes", safeBodyByteCount(span));
        }
        result.addProperty("non_contiguous", ranges.size() > 1);
        result.addProperty("contains_entry", function.getBody().contains(function.getEntryPoint()));
        return result;
    }

    private static long safeBodyByteCount(BigInteger value) {
        if (value.signum() < 0 || value.compareTo(BigInteger.valueOf(9007199254740991L)) > 0) {
            throw new IllegalStateException("Function body byte coverage exceeds exact JSON integer range");
        }
        return value.longValueExact();
    }

    private static String exclusiveEnd(MemoryBlock block) {
        Address next = block.getEnd().next();
        if (next != null && next.getAddressSpace().equals(block.getStart().getAddressSpace())) {
            return canonicalAddress(next);
        }
        BigInteger start = new BigInteger(Long.toUnsignedString(block.getStart().getOffset()));
        return canonicalOffset(
            block.getStart().getAddressSpace(),
            start.add(BigInteger.valueOf(block.getSize()))
        );
    }

    private static String canonicalAddress(Address address) {
        return canonicalOffset(
            address.getAddressSpace(),
            new BigInteger(Long.toUnsignedString(address.getOffset()))
        );
    }

    private static String canonicalOffset(AddressSpace space, BigInteger offset) {
        String value = "0x" + offset.toString(16);
        if (space.equals(sessionDefaultAddressSpace)) {
            return value;
        }
        return encodeAddressSpace(space.getName()) + ":" + value;
    }

    private Address requireAddress(JsonObject params, String name) {
        return parseReaAddress(requireString(params, name));
    }

    private Address parseReaAddress(String value) {
        Address address = tryParseAddress(value);
        if (address == null) {
            throw new RequestFailure("invalid_request", "Unknown or invalid Ghidra address");
        }
        return address;
    }

    private Address tryParseAddress(String value) {
        try {
            String spaceName = null;
            String offset = value;
            int separator = value.lastIndexOf(":0x");
            if (separator >= 0) {
                spaceName = decodeAddressSpace(value.substring(0, separator));
                offset = value.substring(separator + 3);
            }
            else if (value.startsWith("0x")) {
                offset = value.substring(2);
            }
            if (!offset.matches("[0-9A-Fa-f]+")) {
                return null;
            }
            AddressSpace space = spaceName == null
                ? currentProgram.getAddressFactory().getDefaultAddressSpace()
                : currentProgram.getAddressFactory().getAddressSpace(spaceName);
            return space == null ? null : space.getAddress(offset);
        }
        catch (Exception exception) {
            return null;
        }
    }

    private static String encodeAddressSpace(String value) {
        StringBuilder result = new StringBuilder();
        for (byte item : value.getBytes(StandardCharsets.UTF_8)) {
            int unsigned = Byte.toUnsignedInt(item);
            if ((unsigned >= 'A' && unsigned <= 'Z') ||
                (unsigned >= 'a' && unsigned <= 'z') ||
                (unsigned >= '0' && unsigned <= '9') ||
                unsigned == '.' || unsigned == '_' || unsigned == '~' || unsigned == '-') {
                result.append((char) unsigned);
            }
            else {
                result.append('%');
                result.append(Character.toUpperCase(Character.forDigit(unsigned >>> 4, 16)));
                result.append(Character.toUpperCase(Character.forDigit(unsigned & 0xf, 16)));
            }
        }
        return result.toString();
    }

    private static String decodeAddressSpace(String value) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int index = 0; index < value.length();) {
            char item = value.charAt(index);
            if (item == '%') {
                if (index + 2 >= value.length()) {
                    throw new RequestFailure("invalid_request", "Address space encoding is invalid");
                }
                int high = Character.digit(value.charAt(index + 1), 16);
                int low = Character.digit(value.charAt(index + 2), 16);
                if (high < 0 || low < 0) {
                    throw new RequestFailure("invalid_request", "Address space encoding is invalid");
                }
                bytes.write((high << 4) | low);
                index += 3;
            }
            else if ((item >= 'A' && item <= 'Z') ||
                     (item >= 'a' && item <= 'z') ||
                     (item >= '0' && item <= '9') ||
                     item == '.' || item == '_' || item == '~' || item == '-') {
                bytes.write((byte) item);
                index += 1;
            }
            else {
                throw new RequestFailure("invalid_request", "Address space encoding is invalid");
            }
        }
        return bytes.toString(StandardCharsets.UTF_8);
    }

    private static String normalizedSymbolType(Symbol symbol) {
        String value = symbol.getSymbolType().toString()
            .toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9]+", "_")
            .replaceAll("^_+|_+$", "");
        return value.isEmpty() ? "unknown" : value;
    }

    private static String normalizedSource(SourceType source) {
        return source.name().toLowerCase(Locale.ROOT);
    }

    private static ValueMatcher literalMatcher(String pattern, boolean caseSensitive) {
        String needle = caseSensitive ? pattern : pattern.toLowerCase(Locale.ROOT);
        return value -> {
            String candidate = caseSensitive ? value : value.toLowerCase(Locale.ROOT);
            return candidate.contains(needle);
        };
    }

    private static ValueMatcher regexMatcher(String expression, boolean caseSensitive) {
        Pattern pattern;
        try {
            pattern = Pattern.compile(
                expression,
                caseSensitive ? 0 : Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
            );
        }
        catch (PatternSyntaxException exception) {
            throw new RequestFailure("invalid_request", "Invalid regex pattern");
        }
        return value -> pattern.matcher(value).find();
    }

    private static SessionDescriptor readDescriptor(Path path) throws IOException {
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new IllegalArgumentException("REA session descriptor is invalid");
        }
        JsonObject object = requireObject(
            JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8)),
            DESCRIPTOR_KEYS
        );
        return new SessionDescriptor(
            requireString(object, "transport"),
            requireString(object, "endpoint_path"),
            requireString(object, "token"),
            requireString(object, "run_id"),
            requireSha256(object, "target_sha256"),
            requireString(object, "provider_version"),
            requireString(object, "profile_digest")
        );
    }

    private static Request parseRequest(String line, String expectedToken) {
        JsonObject object = requireObject(JsonParser.parseString(line), REQUEST_KEYS);
        int id = requireInteger(object, "id");
        if (id <= 0 || !constantTimeEquals(requireString(object, "token"), expectedToken)) {
            throw new IllegalArgumentException("Bridge request authentication failed");
        }
        JsonElement params = object.get("params");
        if (params == null || !params.isJsonObject()) {
            throw new IllegalArgumentException("Bridge request parameters are invalid");
        }
        return new Request(id, requireString(object, "method"), params.getAsJsonObject());
    }

    private static JsonObject requireObject(JsonElement element, Set<String> keys) {
        if (!element.isJsonObject()) {
            throw new IllegalArgumentException("JSON object required");
        }
        JsonObject object = element.getAsJsonObject();
        if (!object.keySet().equals(keys)) {
            throw new IllegalArgumentException("JSON object fields are invalid");
        }
        return object;
    }

    private static void requireKeys(JsonObject object, Set<String> keys) {
        if (!object.keySet().equals(keys)) {
            throw new RequestFailure("invalid_request", "Bridge request fields are invalid");
        }
    }

    private void requireDocument(JsonObject params) {
        String document = optionalString(params, "document");
        if (document != null && !document.equals(currentProgram.getName())) {
            throw new RequestFailure("not_found", "Unknown Ghidra Program identity");
        }
    }

    private static String optionalString(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || value.isJsonNull()) {
            return null;
        }
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new RequestFailure("invalid_request", name + " must be a string or null");
        }
        String result = value.getAsString();
        if (result.isEmpty()) {
            throw new RequestFailure("invalid_request", name + " cannot be empty");
        }
        return result;
    }

    private static String requireString(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new RequestFailure("invalid_request", name + " must be a string");
        }
        String result = value.getAsString();
        if (result.isEmpty()) {
            throw new RequestFailure("invalid_request", name + " cannot be empty");
        }
        return result;
    }

    private static String requireSha256(JsonObject object, String name) {
        String value = requireString(object, name);
        if (!value.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException(name + " must be lowercase SHA-256");
        }
        return value;
    }

    private static int requireInteger(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException("JSON integer required");
        }
        int result = value.getAsInt();
        if (value.getAsDouble() != result) {
            throw new IllegalArgumentException("JSON integer required");
        }
        return result;
    }

    private static int requireBoundedInteger(
            JsonObject object,
            String name,
            int minimum,
            int maximum) {
        try {
            int value = requireInteger(object, name);
            if (value < minimum || value > maximum) {
                throw new RequestFailure(
                    "invalid_request",
                    name + " is outside its supported range"
                );
            }
            return value;
        }
        catch (IllegalArgumentException exception) {
            throw new RequestFailure("invalid_request", name + " must be an integer");
        }
    }

    private static boolean requireBoolean(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean()) {
            throw new RequestFailure("invalid_request", name + " must be a boolean");
        }
        return value.getAsBoolean();
    }

    private static boolean constantTimeEquals(String provided, String expected) {
        return MessageDigest.isEqual(
            provided.getBytes(StandardCharsets.UTF_8),
            expected.getBytes(StandardCharsets.UTF_8)
        );
    }

    private static void writeSuccess(BufferedWriter writer, int id, JsonElement result)
            throws IOException {
        JsonObject response = new JsonObject();
        response.addProperty("id", id);
        response.addProperty("ok", true);
        response.add("result", result);
        writeResponse(writer, response);
    }

    private static void writeFailure(
            BufferedWriter writer,
            int id,
            String code,
            String message) throws IOException {
        JsonObject error = new JsonObject();
        error.addProperty("code", code);
        error.addProperty("message", message);
        JsonObject response = new JsonObject();
        response.addProperty("id", id);
        response.addProperty("ok", false);
        response.add("error", error);
        writeResponse(writer, response);
    }

    private static void writeResponse(BufferedWriter writer, JsonObject response) throws IOException {
        String encoded = GSON.toJson(response);
        writer.write(encoded);
        writer.newLine();
        writer.flush();
    }

    private static String safeMessage(Exception exception) {
        String message = exception.getMessage();
        return message == null || message.isBlank() ? "operation failed" : message;
    }

    private interface ValueMatcher {
        boolean matches(String value);
    }

    private static final Comparator<InventoryItem> INVENTORY_ORDER =
        Comparator.comparing(InventoryItem::address)
            .thenComparing(InventoryItem::value)
            .thenComparing(item -> GSON.toJson(item.facts));
    private static final Comparator<Reference> REFERENCE_ORDER =
        Comparator.comparing(Reference::getFromAddress)
            .thenComparing(Reference::getToAddress)
            .thenComparing(reference -> reference.getReferenceType().getName())
            .thenComparingInt(Reference::getOperandIndex)
            .thenComparing(Reference::isPrimary);

    private record InventoryItem(Address address, String value, JsonObject facts) {}
    private record FunctionEntry(Function function, InventoryItem item) {}
    private record InstructionScan(List<Instruction> instructions, boolean truncated) {}
    private record SessionDescriptor(
        String transport,
        String endpointPath,
        String token,
        String runId,
        String targetSha256,
        String providerVersion,
        String profileDigest
    ) {}
    private record Request(int id, String method, JsonObject params) {}

    private static final class RequestFailure extends RuntimeException {
        private final String code;

        RequestFailure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

}
