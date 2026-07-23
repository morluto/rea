// REA's packaged, read-only Ghidra headless bridge.
// @category REA

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.Reader;
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
import java.util.List;
import java.util.Locale;
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
import ghidra.framework.Application;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.block.BasicBlockModel;
import ghidra.program.model.block.CodeBlock;
import ghidra.program.model.block.CodeBlockIterator;
import ghidra.program.model.block.CodeBlockReference;
import ghidra.program.model.block.CodeBlockReferenceIterator;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.CommentType;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Variable;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;

public final class ReaGhidraBridge extends HeadlessScript {
    private static final int BRIDGE_VERSION = 5;
    private static final int MAX_DESCRIPTOR_BYTES = 16 * 1024;
    private static final int MAX_REQUEST_CHARACTERS = 256 * 1024;
    private static final int MAX_RESPONSE_BYTES = 1024 * 1024;
    private static final int MAX_INVENTORY_ITEMS = 1_000_000;
    private static final int MAX_FUNCTION_ITEMS = 100_000;
    private static final int MAX_FUNCTION_INSTRUCTIONS = 100_000;
    private static final int DECOMPILE_TIMEOUT_SECONDS = 30;
    private static final int DECOMPILE_PAYLOAD_MBYTES = 8;
    private static final int MAX_LIST_VALUE_CODE_POINTS = 1_024;
    private static final int MAX_SEARCH_VALUE_CODE_POINTS = 4_096;
    private static final int MAX_REGEX_CANDIDATE_CHARACTERS = 4_096;
    private static final long MAX_REGEX_BACKTRACKING_PATHS = 10_000;
    private static final long MAX_LITERAL_SEARCH_WORK_UNITS = 1_000_000;
    private static final long MAX_REGEX_SEARCH_WORK_UNITS = 1_000_000;
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final Set<String> DESCRIPTOR_KEYS = Set.of(
        "schema_version",
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
            endpoint.addProperty("schema_version", 1);
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
            String line = readBoundedLine(reader, MAX_REQUEST_CHARACTERS);
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
        result.addProperty("bridge_version", BRIDGE_VERSION);
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

    private void initializeDecompiler() {
        DecompileOptions options = new DecompileOptions();
        options.setDefaultTimeout(DECOMPILE_TIMEOUT_SECONDS);
        options.setMaxPayloadMBytes(DECOMPILE_PAYLOAD_MBYTES);
        options.setMaxInstructions(MAX_FUNCTION_INSTRUCTIONS);
        decompiler = new DecompInterface();
        decompiler.setOptions(options);
        decompiler.toggleCCode(true);
        decompiler.toggleSyntaxTree(true);
        if (!decompiler.openProgram(currentProgram)) {
            throw new IllegalStateException("Ghidra decompiler could not open the imported Program");
        }
    }

    private JsonElement procedurePseudocode(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "procedure"));
        requireDocument(params);
        String value = decompile(resolveProcedure(requireString(params, "procedure")));
        return value == null ? JsonNull.INSTANCE : GSON.toJsonTree(value);
    }

    private JsonElement procedureAssembly(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "procedure"));
        requireDocument(params);
        Function function = resolveProcedure(requireString(params, "procedure"));
        InstructionScan scan = scanInstructions(function, MAX_FUNCTION_INSTRUCTIONS);
        if (scan.truncated) {
            throw functionLimit("Procedure assembly exceeds the 100000-instruction limit");
        }
        return GSON.toJsonTree(renderAssembly(scan.instructions));
    }

    private JsonObject readFunctionInstructions(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "procedure", "offset", "limit"));
        requireDocument(params);
        Function function = resolveProcedure(requireString(params, "procedure"));
        int offset = requireBoundedInteger(params, "offset", 0, 100_000);
        int limit = requireBoundedInteger(params, "limit", 1, 500);
        InstructionScan scan = scanInstructions(function, offset + limit + 1);
        int start = Math.min(offset, scan.instructions.size());
        int end = Math.min(scan.instructions.size(), start + limit);
        JsonArray items = new JsonArray();
        for (String line : renderAssemblyLines(scan.instructions.subList(start, end))) {
            items.add(line);
        }
        boolean hasMore = scan.truncated || end < scan.instructions.size();
        JsonObject instructions = new JsonObject();
        instructions.add("items", items);
        if (scan.truncated) {
            instructions.add("total", JsonNull.INSTANCE);
        }
        else {
            instructions.addProperty("total", scan.instructions.size());
        }
        instructions.addProperty("returned", items.size());
        instructions.addProperty("truncated", hasMore);
        if (hasMore) {
            instructions.addProperty("next_offset", end);
        }
        else {
            instructions.add("next_offset", JsonNull.INSTANCE);
        }

        JsonArray limitations = new JsonArray();
        limitations.add("Instruction text and ordering are Ghidra-specific representations.");
        limitations.add(
            "The fast path does not invoke the decompiler or scan whole-program names and strings."
        );
        JsonObject result = new JsonObject();
        result.add("procedure", procedureIdentity(function));
        result.add("instructions", instructions);
        result.addProperty("instructions_scanned", scan.instructions.size());
        result.addProperty("instruction_scan_truncated", scan.truncated);
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
        if (observed.size() > MAX_FUNCTION_ITEMS) {
            throw functionLimit("Resolved call set exceeds the 100000-item limit");
        }
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
        result.addProperty("length", function.getBody().getNumAddresses());
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
                "direction",
                "offset",
                "limit",
                "max_instructions"
            )
        );
        requireDocument(params);
        Function function = resolveProcedure(requireString(params, "procedure"));
        String direction = requireString(params, "direction");
        if (!direction.equals("incoming") && !direction.equals("outgoing")) {
            throw new RequestFailure("invalid_request", "direction must be incoming or outgoing");
        }
        int offset = requireBoundedInteger(params, "offset", 0, Integer.MAX_VALUE);
        int limit = requireBoundedInteger(params, "limit", 1, 500);
        int maximum = requireBoundedInteger(params, "max_instructions", 1, 5_000);
        InstructionScan scan = scanInstructions(function, maximum);
        List<Reference> references = collectReferences(scan.instructions, direction);
        JsonArray edges = new JsonArray();
        for (Reference reference : references) {
            edges.add(referenceEdge(reference));
        }
        JsonObject result = new JsonObject();
        result.add("procedure", procedureIdentity(function));
        result.addProperty("direction", direction);
        result.add("references", bounded(edges, offset, limit, !scan.truncated));
        result.addProperty("instructions_scanned", scan.instructions.size());
        result.addProperty("instruction_scan_truncated", scan.truncated);
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
            if (sources.size() > MAX_FUNCTION_ITEMS) {
                throw functionLimit("Cross-reference set exceeds the 100000-item limit");
            }
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
        requireKeys(
            params,
            Set.of(
                "procedure",
                "include_assembly",
                "limit",
                "max_pseudocode_chars",
                "max_instructions",
                "pseudocode_offset",
                "assembly_offset",
                "collection_offset"
            )
        );
        Function function = resolveProcedure(requireString(params, "procedure"));
        boolean includeAssembly = requireBoolean(params, "include_assembly");
        int limit = requireBoundedInteger(params, "limit", 1, 500);
        int maximumCharacters = requireBoundedInteger(
            params,
            "max_pseudocode_chars",
            1,
            100_000
        );
        int maximumInstructions = requireBoundedInteger(
            params,
            "max_instructions",
            1,
            5_000
        );
        int pseudocodeOffset = requireBoundedInteger(
            params,
            "pseudocode_offset",
            0,
            Integer.MAX_VALUE
        );
        int assemblyOffset = requireBoundedInteger(
            params,
            "assembly_offset",
            0,
            Integer.MAX_VALUE
        );
        JsonObject offsets = requireCollectionOffsets(params);
        InstructionScan scan = scanInstructions(function, maximumInstructions);
        String pseudocode = decompile(function);
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
        JsonArray assembly = includeAssembly
            ? GSON.toJsonTree(renderAssemblyLines(scan.instructions)).getAsJsonArray()
            : new JsonArray();

        JsonObject procedure = procedureIdentity(function);
        procedure.addProperty("signature", function.getPrototypeString(false, true));
        procedure.add("locals", functionLocals(function));
        JsonObject result = new JsonObject();
        result.add("procedure", procedure);
        result.add(
            "pseudocode",
            pseudocodePage(pseudocode, pseudocodeOffset, maximumCharacters)
        );
        result.add(
            "assembly",
            includeAssembly
                ? bounded(assembly, assemblyOffset, maximumInstructions, !scan.truncated)
                : bounded(assembly, 0, maximumInstructions, true)
        );
        result.add(
            "comments",
            bounded(comments, collectionOffset(offsets, "comments"), limit, !scan.truncated)
        );
        result.add("callers", bounded(callers, collectionOffset(offsets, "callers"), limit, true));
        result.add("callees", bounded(callees, collectionOffset(offsets, "callees"), limit, true));
        result.add(
            "incoming_references",
            bounded(
                incoming,
                collectionOffset(offsets, "incoming_references"),
                limit,
                !scan.truncated
            )
        );
        result.add(
            "outgoing_references",
            bounded(
                outgoing,
                collectionOffset(offsets, "outgoing_references"),
                limit,
                !scan.truncated
            )
        );
        result.add(
            "referenced_strings",
            bounded(
                referencedStrings,
                collectionOffset(offsets, "referenced_strings"),
                limit,
                !scan.truncated
            )
        );
        result.add(
            "referenced_names",
            bounded(
                referencedNames,
                collectionOffset(offsets, "referenced_names"),
                limit,
                !scan.truncated
            )
        );
        result.add(
            "basic_blocks",
            bounded(blocks, collectionOffset(offsets, "basic_blocks"), limit, true)
        );
        JsonObject instructionScan = new JsonObject();
        instructionScan.addProperty("scanned", scan.instructions.size());
        instructionScan.addProperty("truncated", scan.truncated);
        result.add("instruction_scan", instructionScan);
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
        result.add("limitations", limitations);
        return result;
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

    private JsonObject listNames(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "address", "offset", "limit"));
        requireDocument(params);
        List<InventoryItem> inventory = names();
        String requested = optionalString(params, "address");
        if (requested != null) {
            Address address = parseReaAddress(requested);
            inventory = inventory.stream()
                .filter(item -> item.address.equals(address))
                .toList();
        }
        return page(
            inventory,
            requireBoundedInteger(params, "offset", 0, Integer.MAX_VALUE),
            requireBoundedInteger(params, "limit", 1, 500),
            "symbol"
        );
    }

    private JsonObject listProcedures(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "offset", "limit"));
        requireDocument(params);
        List<InventoryItem> inventory = procedures().stream()
            .map(FunctionEntry::item)
            .toList();
        return page(
            inventory,
            requireBoundedInteger(params, "offset", 0, Integer.MAX_VALUE),
            requireBoundedInteger(params, "limit", 1, 500),
            "procedure"
        );
    }

    private JsonArray listSegments(JsonObject params) {
        requireKeys(params, Set.of("document"));
        requireDocument(params);
        JsonArray result = new JsonArray();
        String imageBase = canonicalAddress(currentProgram.getImageBase());
        MemoryBlock[] blocks = currentProgram.getMemory().getBlocks();
        if (blocks.length > MAX_INVENTORY_ITEMS) {
            throw inventoryLimit();
        }
        List<MemoryBlock> ordered = new ArrayList<>(List.of(blocks));
        ordered.sort(Comparator.comparing(MemoryBlock::getStart));
        for (MemoryBlock block : ordered) {
            JsonObject item = memoryRegion(block, imageBase);
            item.add("sections", new JsonArray());
            result.add(item);
        }
        return result;
    }

    private JsonObject listStrings(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "address", "offset", "limit"));
        requireDocument(params);
        List<InventoryItem> inventory = strings();
        String requested = optionalString(params, "address");
        if (requested != null) {
            Address address = parseReaAddress(requested);
            inventory = inventory.stream()
                .filter(item -> item.address.equals(address))
                .toList();
        }
        return page(
            inventory,
            requireBoundedInteger(params, "offset", 0, Integer.MAX_VALUE),
            requireBoundedInteger(params, "limit", 1, 500),
            "string"
        );
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

    private JsonObject search(JsonObject params, boolean procedureSearch) throws Exception {
        requireKeys(
            params,
            Set.of("pattern", "mode", "case_sensitive", "offset", "limit", "document")
        );
        requireDocument(params);
        String expression = requireString(params, "pattern");
        if (expression.codePointCount(0, expression.length()) > 256) {
            throw new RequestFailure(
                "invalid_request",
                "pattern must contain between 1 and 256 characters"
            );
        }
        String mode = requireString(params, "mode");
        if (!mode.equals("literal") && !mode.equals("regex")) {
            throw new RequestFailure("invalid_request", "mode must be literal or regex");
        }
        boolean caseSensitive = requireBoolean(params, "case_sensitive");
        int offset = requireBoundedInteger(params, "offset", 0, Integer.MAX_VALUE);
        int limit = requireBoundedInteger(params, "limit", 1, 100);
        List<InventoryItem> inventory = procedureSearch
            ? procedures().stream().map(FunctionEntry::item).toList()
            : strings();
        ValueMatcher matcher = mode.equals("literal")
            ? literalMatcher(expression, caseSensitive)
            : regexMatcher(expression, caseSensitive);
        JsonArray items = new JsonArray();
        int total = 0;
        long pageEnd = (long) offset + limit;
        for (InventoryItem item : inventory) {
            if (!matcher.matches(item.value)) {
                continue;
            }
            if (total >= offset && total < pageEnd) {
                items.add(resultItem(item, null, MAX_SEARCH_VALUE_CODE_POINTS));
            }
            total += 1;
        }
        return pageResult(items, offset, limit, total);
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
            addBounded(
                result,
                new InventoryItem(address, symbol.getName(true), facts)
            );
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
            if (destination.size() >= MAX_INVENTORY_ITEMS) {
                throw inventoryLimit();
            }
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
            addBounded(result, new InventoryItem(data.getAddress(), value, facts));
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

    private String decompile(Function function) {
        if (function.isExternal() || function.getBody().isEmpty()) {
            return null;
        }
        DecompileResults results = decompiler.decompileFunction(
            function,
            DECOMPILE_TIMEOUT_SECONDS,
            monitor
        );
        if (results.isTimedOut()) {
            throw new RequestFailure(
                "decompile_timeout",
                "Ghidra decompilation reached its 30-second deadline"
            );
        }
        if (results.isCancelled()) {
            throw new RequestFailure("decompile_cancelled", "Ghidra decompilation was cancelled");
        }
        if (!results.decompileCompleted()) {
            throw new RequestFailure(
                "decompile_failed",
                "Ghidra decompilation failed: " + boundedMessage(results.getErrorMessage())
            );
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
        if (observed.size() > MAX_FUNCTION_ITEMS) {
            throw functionLimit("Reference set exceeds the 100000-item limit");
        }
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
        if (variables.length > MAX_FUNCTION_ITEMS) {
            throw functionLimit("Local-variable set exceeds the 100000-item limit");
        }
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
        if (functions.size() > MAX_FUNCTION_ITEMS) {
            throw functionLimit("Resolved call set exceeds the 100000-item limit");
        }
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
            if (result.size() >= MAX_FUNCTION_ITEMS) {
                throw functionLimit("Basic-block set exceeds the 100000-item limit");
            }
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
                if (observed.size() > MAX_FUNCTION_ITEMS) {
                    throw functionLimit("Comment set exceeds the 100000-item limit");
                }
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
            if (observed.size() > MAX_FUNCTION_ITEMS) {
                throw functionLimit("Referenced-string set exceeds the 100000-item limit");
            }
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
            if (observed.size() > MAX_FUNCTION_ITEMS) {
                throw functionLimit("Referenced-name set exceeds the 100000-item limit");
            }
        }
        JsonArray result = new JsonArray();
        observed.values().forEach(result::add);
        return result;
    }

    private static JsonObject pseudocodePage(String value, int offset, int limit) {
        int total = value.codePointCount(0, value.length());
        int start = Math.min(offset, total);
        int returned = Math.min(limit, total - start);
        int startIndex = value.offsetByCodePoints(0, start);
        int endIndex = value.offsetByCodePoints(startIndex, returned);
        int next = start + returned;
        JsonObject result = new JsonObject();
        result.addProperty("text", value.substring(startIndex, endIndex));
        result.addProperty("total_chars", total);
        result.addProperty("returned_chars", returned);
        result.addProperty("truncated", next < total);
        if (next < total) {
            result.addProperty("next_offset", next);
        }
        else {
            result.add("next_offset", JsonNull.INSTANCE);
        }
        return result;
    }

    private static JsonObject bounded(
            JsonArray values,
            int offset,
            int limit,
            boolean complete) {
        int start = Math.min(offset, values.size());
        int end = Math.min(values.size(), start + limit);
        JsonArray items = new JsonArray();
        for (int index = start; index < end; index += 1) {
            items.add(values.get(index).deepCopy());
        }
        boolean hasMore = end < values.size();
        JsonObject result = new JsonObject();
        result.add("items", items);
        if (complete) {
            result.addProperty("total", values.size());
        }
        else {
            result.add("total", JsonNull.INSTANCE);
        }
        result.addProperty("returned", items.size());
        result.addProperty("truncated", !complete || hasMore);
        if (complete && hasMore) {
            result.addProperty("next_offset", end);
        }
        else {
            result.add("next_offset", JsonNull.INSTANCE);
        }
        return result;
    }

    private static JsonObject requireCollectionOffsets(JsonObject params) {
        JsonElement value = params.get("collection_offset");
        if (value == null || !value.isJsonObject()) {
            throw new RequestFailure("invalid_request", "collection_offset must be an object");
        }
        JsonObject result = value.getAsJsonObject();
        requireKeys(
            result,
            Set.of(
                "comments",
                "callers",
                "callees",
                "incoming_references",
                "outgoing_references",
                "referenced_strings",
                "referenced_names",
                "basic_blocks"
            )
        );
        for (String name : result.keySet()) {
            requireBoundedInteger(result, name, 0, Integer.MAX_VALUE);
        }
        return result;
    }

    private static int collectionOffset(JsonObject offsets, String name) {
        return requireBoundedInteger(offsets, name, 0, Integer.MAX_VALUE);
    }

    private static String exclusiveAddress(Address inclusive) {
        Address next = inclusive.next();
        if (next != null && next.getAddressSpace().equals(inclusive.getAddressSpace())) {
            return canonicalAddress(next);
        }
        BigInteger offset = new BigInteger(Long.toUnsignedString(inclusive.getOffset()));
        return canonicalOffset(inclusive.getAddressSpace(), offset.add(BigInteger.ONE));
    }

    private static String boundedMessage(String value) {
        if (value == null || value.isBlank()) {
            return "native decompiler returned no detail";
        }
        return truncate(value.replaceAll("[\\r\\n]+", " "), 512).value;
    }

    private static RequestFailure functionLimit(String message) {
        return new RequestFailure("limit_exceeded", message);
    }

    private JsonObject page(
            List<InventoryItem> inventory,
            int offset,
            int limit,
            String factsName) {
        int start = Math.min(offset, inventory.size());
        int end = Math.min(inventory.size(), start + limit);
        JsonArray items = new JsonArray();
        for (int index = start; index < end; index += 1) {
            items.add(resultItem(inventory.get(index), factsName, MAX_LIST_VALUE_CODE_POINTS));
        }
        return pageResult(items, offset, limit, inventory.size());
    }

    private static JsonObject pageResult(JsonArray items, int offset, int limit, int total) {
        int next = offset + items.size();
        boolean hasMore = next < total;
        JsonObject result = new JsonObject();
        result.add("items", items);
        result.addProperty("offset", offset);
        result.addProperty("limit", limit);
        result.addProperty("total", total);
        if (hasMore) {
            result.addProperty("next_offset", next);
        }
        else {
            result.add("next_offset", JsonNull.INSTANCE);
        }
        result.addProperty("has_more", hasMore);
        return result;
    }

    private static JsonObject resultItem(
            InventoryItem item,
            String factsName,
            int maximumCodePoints) {
        TruncatedValue truncated = truncate(item.value, maximumCodePoints);
        JsonObject result = new JsonObject();
        result.addProperty("address", canonicalAddress(item.address));
        result.addProperty("value", truncated.value);
        result.addProperty("value_truncated", truncated.truncated);
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
        return result;
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

    private static void addBounded(List<InventoryItem> destination, InventoryItem item) {
        if (destination.size() >= MAX_INVENTORY_ITEMS) {
            throw inventoryLimit();
        }
        destination.add(item);
    }

    private static RequestFailure inventoryLimit() {
        return new RequestFailure(
            "limit_exceeded",
            "Ghidra inventory exceeds the 1000000-item safety limit"
        );
    }

    private static TruncatedValue truncate(String value, int maximumCodePoints) {
        int codePoints = value.codePointCount(0, value.length());
        if (codePoints <= maximumCodePoints) {
            return new TruncatedValue(value, false);
        }
        int end = value.offsetByCodePoints(0, maximumCodePoints);
        return new TruncatedValue(value.substring(0, end), true);
    }

    private static ValueMatcher literalMatcher(String pattern, boolean caseSensitive) {
        String needle = caseSensitive ? pattern : pattern.toLowerCase(Locale.ROOT);
        return new ValueMatcher() {
            private long remaining = MAX_LITERAL_SEARCH_WORK_UNITS;

            @Override
            public boolean matches(String value) {
                long required = (long) Math.max(value.length(), 1) + needle.length();
                if (required > remaining) {
                    throw new RequestFailure(
                        "limit_exceeded",
                        "Literal search exceeds the 1000000-unit work budget"
                    );
                }
                remaining -= required;
                String candidate = caseSensitive ? value : value.toLowerCase(Locale.ROOT);
                return candidate.contains(needle);
            }
        };
    }

    private static ValueMatcher regexMatcher(String expression, boolean caseSensitive) {
        RegexMetrics metrics;
        Pattern pattern;
        try {
            metrics = new BoundedRegexParser(expression).parse();
            pattern = Pattern.compile(
                expression,
                caseSensitive ? 0 : Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
            );
        }
        catch (PatternSyntaxException exception) {
            throw new RequestFailure("invalid_request", "Invalid regex pattern");
        }
        long workPerCharacter = metrics.paths * Math.max(metrics.steps, 1);
        return new ValueMatcher() {
            private long remaining = MAX_REGEX_SEARCH_WORK_UNITS;

            @Override
            public boolean matches(String value) {
                if (value.length() > MAX_REGEX_CANDIDATE_CHARACTERS) {
                    throw new RequestFailure(
                        "limit_exceeded",
                        "Regex candidate exceeds the 4096-character safety limit"
                    );
                }
                long required = workPerCharacter * Math.max(value.length(), 1);
                if (required > remaining) {
                    throw new RequestFailure(
                        "limit_exceeded",
                        "Regex search exceeds the 1000000-unit work budget"
                    );
                }
                remaining -= required;
                return pattern.matcher(value).find();
            }
        };
    }

    private static SessionDescriptor readDescriptor(Path path) throws IOException {
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) ||
            Files.size(path) > MAX_DESCRIPTOR_BYTES) {
            throw new IllegalArgumentException("REA session descriptor is invalid");
        }
        JsonObject object = requireObject(
            JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8)),
            DESCRIPTOR_KEYS
        );
        if (requireInteger(object, "schema_version") != 2) {
            throw new IllegalArgumentException("REA session descriptor version is invalid");
        }
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

    private static String readBoundedLine(Reader reader, int maximumCharacters) throws IOException {
        StringBuilder line = new StringBuilder();
        while (true) {
            int character = reader.read();
            if (character < 0) {
                return line.isEmpty() ? null : line.toString();
            }
            if (character == '\n') {
                return line.toString();
            }
            if (character != '\r') {
                if (line.length() >= maximumCharacters) {
                    throw new IOException("Bridge request exceeded the maximum line size");
                }
                line.append((char) character);
            }
        }
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
        if (encoded.getBytes(StandardCharsets.UTF_8).length > MAX_RESPONSE_BYTES) {
            int id = response.get("id").getAsInt();
            JsonObject error = new JsonObject();
            error.addProperty("code", "output_limit");
            error.addProperty("message", "Ghidra response exceeds the 1 MiB wire limit");
            JsonObject bounded = new JsonObject();
            bounded.addProperty("id", id);
            bounded.addProperty("ok", false);
            bounded.add("error", error);
            encoded = GSON.toJson(bounded);
        }
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
    private record TruncatedValue(String value, boolean truncated) {}
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
    private record RegexMetrics(long paths, long steps, boolean containsRepeat) {}

    private static final class RequestFailure extends RuntimeException {
        private final String code;

        RequestFailure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static final class BoundedRegexParser {
        private final String expression;
        private int index;

        BoundedRegexParser(String expression) {
            this.expression = expression;
        }

        RegexMetrics parse() {
            RegexMetrics result = parseExpression(false);
            if (index != expression.length()) {
                throw invalidRegex();
            }
            return result;
        }

        private RegexMetrics parseExpression(boolean grouped) {
            RegexMetrics result = parseSequence(grouped);
            while (peek('|')) {
                index += 1;
                RegexMetrics branch = parseSequence(grouped);
                result = new RegexMetrics(
                    checkedPaths(result.paths, branch.paths, false),
                    Math.max(result.steps, branch.steps),
                    result.containsRepeat || branch.containsRepeat
                );
            }
            return result;
        }

        private RegexMetrics parseSequence(boolean grouped) {
            RegexMetrics result = new RegexMetrics(1, 0, false);
            while (index < expression.length() && !peek('|') && !(grouped && peek(')'))) {
                RegexMetrics item = parseAtom();
                result = new RegexMetrics(
                    checkedPaths(result.paths, item.paths, true),
                    result.steps + item.steps,
                    result.containsRepeat || item.containsRepeat
                );
            }
            return result;
        }

        private RegexMetrics parseAtom() {
            if (index >= expression.length()) {
                throw invalidRegex();
            }
            char item = expression.charAt(index++);
            RegexMetrics atom;
            if (item == '(') {
                if (peek('?')) {
                    if (index + 1 >= expression.length() || expression.charAt(index + 1) != ':') {
                        throw new RequestFailure(
                            "invalid_request",
                            "Regex lookarounds and backreferences are not supported"
                        );
                    }
                    index += 2;
                }
                atom = parseExpression(true);
                if (!peek(')')) {
                    throw invalidRegex();
                }
                index += 1;
            }
            else if (item == '[') {
                consumeCharacterClass();
                atom = leaf();
            }
            else if (item == '\\') {
                consumeEscape();
                atom = leaf();
            }
            else if (item == '*' || item == '+') {
                throw unboundedRepeat();
            }
            else if (item == '?' || item == '{' || item == '}' || item == ')') {
                throw invalidRegex();
            }
            else {
                atom = leaf();
            }
            if (index >= expression.length()) {
                return atom;
            }
            if (peek('*') || peek('+')) {
                throw unboundedRepeat();
            }
            int minimum;
            int maximum;
            if (peek('?')) {
                index += 1;
                minimum = 0;
                maximum = 1;
            }
            else if (peek('{')) {
                int[] bounds = consumeBounds();
                minimum = bounds[0];
                maximum = bounds[1];
            }
            else {
                return atom;
            }
            if (atom.containsRepeat) {
                throw new RequestFailure(
                    "invalid_request",
                    "Nested regex repetitions are not supported"
                );
            }
            if (maximum > 1_000) {
                throw unboundedRepeat();
            }
            return new RegexMetrics(
                repeatPaths(atom.paths, minimum, maximum),
                maximum * atom.steps,
                true
            );
        }

        private void consumeCharacterClass() {
            boolean escaped = false;
            boolean hasContent = false;
            while (index < expression.length()) {
                char item = expression.charAt(index++);
                if (escaped) {
                    escaped = false;
                    hasContent = true;
                }
                else if (item == '\\') {
                    escaped = true;
                }
                else if (item == ']' && hasContent) {
                    return;
                }
                else {
                    hasContent = true;
                }
            }
            throw invalidRegex();
        }

        private void consumeEscape() {
            if (index >= expression.length()) {
                throw invalidRegex();
            }
            char escaped = expression.charAt(index++);
            if (Character.isDigit(escaped) || escaped == 'k') {
                throw new RequestFailure(
                    "invalid_request",
                    "Regex lookarounds and backreferences are not supported"
                );
            }
            if (escaped == 'Q' || escaped == 'E' || escaped == 'p' || escaped == 'P') {
                throw new RequestFailure(
                    "invalid_request",
                    "Regex operation is not supported by the bounded matcher"
                );
            }
            if (escaped == 'x') {
                consumeHexDigits(2);
            }
            else if (escaped == 'u') {
                consumeHexDigits(4);
            }
        }

        private void consumeHexDigits(int count) {
            if (index + count > expression.length()) {
                throw invalidRegex();
            }
            for (int current = 0; current < count; current += 1) {
                if (Character.digit(expression.charAt(index + current), 16) < 0) {
                    throw invalidRegex();
                }
            }
            index += count;
        }

        private int[] consumeBounds() {
            index += 1;
            int minimum = consumeDecimal();
            int maximum = minimum;
            if (peek(',')) {
                index += 1;
                if (peek('}')) {
                    throw unboundedRepeat();
                }
                maximum = consumeDecimal();
            }
            if (!peek('}') || minimum > maximum) {
                throw invalidRegex();
            }
            index += 1;
            return new int[] { minimum, maximum };
        }

        private int consumeDecimal() {
            int start = index;
            long value = 0;
            while (index < expression.length() && Character.isDigit(expression.charAt(index))) {
                value = value * 10 + Character.digit(expression.charAt(index), 10);
                if (value > Integer.MAX_VALUE) {
                    throw unboundedRepeat();
                }
                index += 1;
            }
            if (index == start) {
                throw invalidRegex();
            }
            return (int) value;
        }

        private boolean peek(char expected) {
            return index < expression.length() && expression.charAt(index) == expected;
        }

        private static RegexMetrics leaf() {
            return new RegexMetrics(1, 1, false);
        }

        private static long repeatPaths(long childPaths, int minimum, int maximum) {
            long result = 0;
            long repeated = 1;
            for (int count = 0; count <= maximum; count += 1) {
                if (count >= minimum) {
                    result = checkedPaths(result, repeated, false);
                }
                if (count < maximum) {
                    repeated = checkedPaths(repeated, childPaths, true);
                }
            }
            return result;
        }

        private static long checkedPaths(long left, long right, boolean multiply) {
            boolean exceeded = multiply
                ? right != 0 && left > MAX_REGEX_BACKTRACKING_PATHS / right
                : left > MAX_REGEX_BACKTRACKING_PATHS - right;
            long result = multiply ? left * right : left + right;
            if (exceeded || result > MAX_REGEX_BACKTRACKING_PATHS) {
                throw new RequestFailure(
                    "invalid_request",
                    "Regex exceeds the 10000-path backtracking budget"
                );
            }
            return result;
        }

        private static RequestFailure unboundedRepeat() {
            return new RequestFailure(
                "invalid_request",
                "Unbounded or excessive regex repetitions are not supported"
            );
        }

        private static RequestFailure invalidRegex() {
            return new RequestFailure("invalid_request", "Invalid regex pattern");
        }
    }
}
