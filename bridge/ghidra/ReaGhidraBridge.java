// REA's packaged, read-only Ghidra headless bridge.
// @category REA

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.Writer;
import java.lang.ref.SoftReference;
import java.math.BigInteger;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.Channels;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonIOException;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.stream.JsonWriter;

import generic.concurrent.ConcurrentQ;
import generic.concurrent.ConcurrentQBuilder;
import generic.concurrent.GThreadPool;
import generic.concurrent.QResult;
import ghidra.app.cmd.function.ApplyFunctionSignatureCmd;
import ghidra.app.cmd.function.FunctionRenameOption;
import ghidra.app.util.cparser.C.CParser;
import ghidra.app.util.headless.HeadlessScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.app.decompiler.ClangCaseToken;
import ghidra.app.decompiler.ClangNode;
import ghidra.app.decompiler.parallel.DecompilerCallback;
import ghidra.framework.Application;
import ghidra.app.util.bin.format.pdb.PdbParserConstants;
import ghidra.app.util.opinion.ElfLoader;
import ghidra.framework.options.Options;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressFactory;
import ghidra.program.model.address.AddressIterator;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.address.AddressRange;
import ghidra.program.model.address.AddressRangeIterator;
import ghidra.program.model.block.BasicBlockModel;
import ghidra.program.model.block.CodeBlock;
import ghidra.program.model.block.CodeBlockIterator;
import ghidra.program.model.block.CodeBlockReference;
import ghidra.program.model.block.CodeBlockReferenceIterator;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.data.CategoryPath;
import ghidra.program.model.data.DataType;
import ghidra.program.model.data.DataTypeConflictHandler;
import ghidra.program.model.data.DataTypeManager;
import ghidra.program.model.data.FunctionDefinitionDataType;
import ghidra.program.model.data.ParameterDefinition;
import ghidra.program.model.data.MutabilitySettingsDefinition;
import ghidra.program.model.data.Undefined;
import ghidra.program.model.lang.OperandType;
import ghidra.program.model.lang.Register;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.listing.Bookmark;
import ghidra.program.model.listing.BookmarkType;
import ghidra.program.model.listing.CommentType;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.FunctionSignature;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Variable;
import ghidra.program.model.listing.VariableStorage;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.mem.MemoryBlockSourceInfo;
import ghidra.program.database.mem.FileBytes;
import ghidra.program.model.address.SegmentedAddress;
import ghidra.program.model.reloc.Relocation;
import ghidra.program.model.symbol.Namespace;
import ghidra.program.model.symbol.FlowType;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.symbol.SymbolTable;
import ghidra.program.model.symbol.SymbolType;
import ghidra.program.model.symbol.SymbolUtilities;
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
import ghidra.program.util.ContextEvaluatorAdapter;
import ghidra.program.util.SymbolicPropogator;
import ghidra.program.util.VarnodeContext;
import ghidra.util.UndefinedFunction;
import ghidra.util.exception.CancelledException;
import ghidra.util.task.TaskMonitor;
import ghidra.util.task.TaskMonitorAdapter;

public final class ReaGhidraBridge extends HeadlessScript {
    // At most 24 KiB after worst-case JSON escaping (six bytes per UTF-16 unit).
    private static final int PDB_ATTRIBUTE_UTF16_BUDGET = 4096;
    private static final int DEFAULT_HIGH_PCODE_OPS = 3000;
    private static final int DEFAULT_HIGH_PCODE_INPUTS_PER_OP = 64;
    private static final int DEFAULT_HIGH_PCODE_DEF_USE_EDGES = 12000;
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final Map<SymbolType, String> NORMALIZED_SYMBOL_TYPES = new ConcurrentHashMap<>();
    private static final Map<SourceType, String> NORMALIZED_SOURCES = new ConcurrentHashMap<>();
    private static final Pattern NON_ALNUM_RUN = Pattern.compile("[^a-z0-9]+");
    private static final Pattern EDGE_UNDERSCORES = Pattern.compile("^_+|_+$");
    private static final Pattern FS_PTR_PREFIX =
        Pattern.compile("(?i)\\b(?:byte|word|dword|qword)\\s+ptr\\s+");
    private static final Pattern WHITESPACE_RUN = Pattern.compile("\\s+");
    private final Map<FileBytes, Boolean> targetSourceIdentity = new IdentityHashMap<>();
    private final Map<FileBytes, String> originalFileBytesSha256 = new IdentityHashMap<>();
    private final NavigableMap<Address, LoaderInitializedRelocation> loaderInitializedRelocations =
        new TreeMap<>();
    private String admittedTargetSha256;
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
        "read_binary_inventory_summary",
        "annotate_native_function",
        "define_native_data_types",
        "set_address_name",
        "set_addresses_names",
        "inspect_native_load_image",
        "read_bytes",
        "search_bytes",
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

    private List<NameEntry> nameInventory;
    private List<ProcedureEntry> procedureInventory;
    private Map<String, Object> procedureNameIndex;
    private List<StringEntry> stringInventory;
    private Boolean swiftProgramCached;
    private DecompInterface decompiler;
    /**
     * Completed decompilations of the current Program state, least recently
     * used first. DecompInterface keeps no results, so a repeated request would
     * otherwise run the native decompiler again. The key carries every input a
     * result depends on; soft references let the heap reclaim large results.
     */
    private final LinkedHashMap<DecompileCacheKey, SoftReference<DecompileResults>> decompileResults =
        new LinkedHashMap<>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(
                Map.Entry<DecompileCacheKey, SoftReference<DecompileResults>> eldest
            ) {
                return size() > DECOMPILE_RESULT_ENTRIES;
            }
        };
    // Fixed: this bounds retained Java objects, not analysis the caller can
    // observe. A miss only repeats a decompile, and soft references release
    // entries under heap pressure. Ghidra's own panel keeps 10 by default.
    private static final int DECOMPILE_RESULT_ENTRIES = 32;
    /** Decompiler processes kept between read-ahead windows of one workflow. */
    private DecompilerCallback<DecompileResults> decompileAheadWorkers;
    /** REA's own threads, so read-ahead never resizes or queues on Ghidra's shared pools. */
    private GThreadPool decompileAheadThreads;
    private static final int DECOMPILE_AHEAD_WORKERS = 8;
    // A hint beyond the retained results would evict the window's own first
    // results before their requests arrive, so later selectors are ignored.
    private static final int DECOMPILE_AHEAD_WINDOW = DECOMPILE_RESULT_ENTRIES;
    // Fixed: read-ahead serves consecutive requests of one workflow, which
    // arrive milliseconds apart. After this idle time the pooled native
    // decompiler processes are released; a later window starts them again.
    private static final long DECOMPILE_AHEAD_IDLE_MILLIS = 30_000;
    private final Object decompileAheadLock = new Object();
    private final ScheduledExecutorService decompileAheadReaper =
        Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "REA decompile read-ahead reaper");
            thread.setDaemon(true);
            return thread;
        });
    private ScheduledFuture<?> decompileAheadIdleRelease;
    /**
     * The read-ahead result for the request that carried the window: that
     * request consumes it whatever its outcome instead of decompiling again.
     */
    private DecompileCacheKey decompileAheadForegroundKey;
    private DecompileResults decompileAheadForeground;
    private boolean existingProject;
    // A refused Program may only report its admission failure to the client.
    private String identityAdmissionFailure;
    /** Per-function native decompiler limit from the session; 0 leaves it unbounded. */
    private int decompileTimeoutSeconds;
    private Integer decompileMaxPayloadMiB;
    // DecompileProcess converts MiB to bytes using a signed-int left shift.
    private static final int MAX_DECOMPILE_PAYLOAD_MIB = Integer.MAX_VALUE >> 20;
    private ValueFlowLimits valueFlowLimits = defaultValueFlowLimits();
    // Context registers whose entry values TypeScript committed for this import, such as TMode.
    private List<String> entryContextRegisters = List.of();
    // The registers GHIDRA_RAW_ENTRY_CONTEXT can commit; the launcher tests keep them equal.
    private static final Set<String> ENTRY_CONTEXT_REGISTERS = Set.of("TMode");
    // DecompileProcess converts seconds to an int millisecond timer delay.
    private static final int MAX_DECOMPILE_TIMEOUT_SECONDS = Integer.MAX_VALUE / 1000;
    private final ReaGhidraExtensions analysisExtensions = new ReaGhidraExtensions();
    private static AddressSpace sessionDefaultAddressSpace;
    private Path checkpointDirectory;
    private long checkpointModification;

    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 1) {
            throw new IllegalArgumentException("REA bridge requires one session descriptor");
        }
        Path descriptorPath = Path.of(arguments[0]);
        checkpointDirectory = descriptorPath.toAbsolutePath().normalize().getParent();
        SessionDescriptor descriptor = readDescriptor(descriptorPath);
        existingProject = descriptor.existingProject;
        decompileTimeoutSeconds = descriptor.decompileTimeoutSeconds();
        entryContextRegisters = descriptor.entryContextRegisters();
        // Windows retains a native immutable bearer descriptor lease until
        // runtime_close; POSIX removes it after this read. Normal cleanup removes
        // the Windows file, while abrupt owner death can leave private residue.
        // Its protected runtime DACL also protects the bearer token while the
        // bridge is running. POSIX keeps its existing consume-and-delete flow.
        if (!isWindowsHost()) {
            Files.deleteIfExists(descriptorPath);
        }
        if (currentProgram == null) {
            throw new IllegalStateException("REA bridge requires an imported program");
        }
        sessionDefaultAddressSpace =
            currentProgram.getAddressFactory().getDefaultAddressSpace();
        if (currentProgram.getExecutableFormat().equals("Old-style DOS Executable (COM)") &&
            !currentProgram.getOptions(ghidra.program.model.listing.Program.PROGRAM_INFO)
                .getBoolean("REA DOS COM prepared", false)) {
            throw new IllegalStateException("REA DOS COM entry/context preparation failed");
        }
        if (currentProgram.getExecutableFormat().equals("Raw Binary")) {
            boolean dosCom = currentProgram.getLanguageID().getIdAsString()
                .equals("x86:LE:16:Real Mode");
            String preparation = dosCom ? "REA DOS COM prepared" : "REA raw binary prepared";
            if (!currentProgram.getOptions(ghidra.program.model.listing.Program.PROGRAM_INFO)
                .getBoolean(preparation, false)) {
                throw new IllegalStateException(
                    dosCom ? "REA DOS COM entry/context preparation failed" :
                        "REA raw binary entry preparation failed"
                );
            }
        }
        if (!Application.getApplicationVersion().equals(descriptor.providerVersion)) {
            throw new IllegalStateException("Ghidra provider version does not match the session");
        }
        String importedSha256 = currentProgram.getExecutableSHA256();
        if (importedSha256 == null || !importedSha256.matches("(?i)[0-9a-f]{64}")) {
            identityAdmissionFailure = "import_identity_unavailable";
        }
        else if (!constantTimeEquals(importedSha256.toLowerCase(Locale.ROOT),
                                     descriptor.targetSha256)) {
            identityAdmissionFailure = "import_identity_mismatch";
        }
        if (identityAdmissionFailure != null) {
            end(false);
            serve(descriptor);
            return;
        }
        admittedTargetSha256 = descriptor.targetSha256;
        // GhidraScript wraps run() in a transaction. End it before serving so
        // each edit owns a real outer transaction and can roll back immediately.
        end(true);
        try {
            if (!descriptor.transport.equals("unix-socket") && descriptor.analysisExtensions.size() > 0)
                throw new IOException("Windows Ghidra P0 does not admit metadata recovery or database mutation.");
            analysisExtensions.analyze(descriptor.analysisExtensions, currentProgram, monitor);
            // Read-only sessions keep the discovered limitation but cannot mark blocks volatile.
            protectLoaderInitializedRelocations(
                !descriptor.existingProject && descriptor.transport.equals("unix-socket"));
            initializeDecompiler();
            checkpointModification = currentProgram.getModificationNumber();
            serve(descriptor);
        }
        finally {
            disposeDecompileAhead();
            decompileAheadReaper.shutdownNow();
            if (decompileAheadThreads != null) decompileAheadThreads.shutdownNow();
            if (decompiler != null) {
                decompiler.dispose();
                decompiler = null;
            }
            analysisExtensions.close();
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
            // The Windows native reader refuses a file while a writer still
            // owns it. Closing CREATE_NEW publishes the complete record without
            // requesting rename rights on the retained private directory guard.
            Files.writeString(
                isWindowsHost() ? endpointPath : pendingPath,
                GSON.toJson(endpoint) + "\n",
                StandardCharsets.UTF_8,
                StandardOpenOption.CREATE_NEW,
                StandardOpenOption.WRITE
            );
            if (!isWindowsHost()) {
                try {
                    Files.move(pendingPath, endpointPath, StandardCopyOption.ATOMIC_MOVE);
                }
                catch (AtomicMoveNotSupportedException exception) {
                    Files.move(pendingPath, endpointPath);
                }
            }
            acceptAuthenticatedLoopbackClient(server, descriptor);
        }
        finally {
            Files.deleteIfExists(pendingPath);
            Files.deleteIfExists(endpointPath);
        }
    }

    private static boolean isWindowsHost() {
        return System.getProperty("os.name", "").startsWith("Windows");
    }

    private static String readLoopbackHandshake(
            SocketChannel client, int maxBytes, long timeoutMillis) throws IOException {
        long deadline = System.nanoTime() + timeoutMillis * 1_000_000L;
        InputStream input = client.socket().getInputStream();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        while (true) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) throw new SocketTimeoutException("Bridge authentication timed out");
            client.socket().setSoTimeout((int) Math.max(1,
                Math.min(Integer.MAX_VALUE, (remaining + 999_999L) / 1_000_000L)));
            int value = input.read();
            if (value == -1) return null;
            if (value == '\n') return bytes.toString(StandardCharsets.UTF_8);
            if (bytes.size() == maxBytes) throw new IOException("Bridge authentication frame is too large");
            bytes.write(value);
        }
    }

    private void acceptAuthenticatedLoopbackClient(
            ServerSocketChannel server, SessionDescriptor descriptor) throws Exception {
        while (true) {
            try (SocketChannel client = server.accept()) {
                Request first;
                try {
                    String line = readLoopbackHandshake(client, 64 * 1024, 1_000);
                    if (line == null) continue;
                    first = parseRequest(line, descriptor.token);
                }
                catch (IOException | RuntimeException rejected) {
                    // A rejected unauthenticated peer cannot consume the bridge session.
                    continue;
                }
                client.socket().setSoTimeout(0);
                try (BufferedReader reader = new BufferedReader(
                         Channels.newReader(client, StandardCharsets.UTF_8));
                     BufferedWriter writer = new BufferedWriter(
                         Channels.newWriter(client, StandardCharsets.UTF_8))) {
                    serveClient(descriptor, reader, writer, first);
                }
                return;
            }
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
            serveClient(descriptor, reader, writer, null);
        }
    }

    /**
     * One frame handed from the connection reader to the request handler: a
     * request with its cancellation monitor, an unusable frame, a read
     * failure, or the end of the connection when every field is unset.
     */
    private record Inbound(Request request, TaskMonitor monitor, boolean invalid, IOException failure) {}

    // A full queue only delays the reader; REA writes one Program request at a
    // time, plus lifecycle requests beside it.
    private static final int INBOUND_REQUEST_CAPACITY = 8;

    /** Monitors of requests that were read and have not been answered. */
    private final Map<Integer, TaskMonitor> requestMonitors = new ConcurrentHashMap<>();

    private Inbound admitRequest(Request request) {
        // Registered before the handler can see the request, so a cancel read
        // right behind it finds the monitor even while the request still waits.
        TaskMonitor requestMonitor = new TaskMonitorAdapter(true);
        requestMonitors.put(request.id, requestMonitor);
        return new Inbound(request, requestMonitor, false, null);
    }

    /**
     * Read frames while the handler works. This is the bridge's only second
     * thread: it never touches the Program or the writer. It cancels the
     * monitor of the request a `cancel` frame names and queues every other
     * frame in arrival order, so requests still run one at a time.
     */
    private void readRequests(
            SessionDescriptor descriptor,
            BufferedReader reader,
            BlockingQueue<Inbound> inbound) {
        try {
            while (true) {
                String line;
                try {
                    line = reader.readLine();
                }
                catch (IOException exception) {
                    inbound.put(new Inbound(null, null, false, exception));
                    return;
                }
                if (line == null) {
                    inbound.put(new Inbound(null, null, false, null));
                    return;
                }
                Request request;
                try {
                    request = parseRequest(line, descriptor.token);
                    if (request.method.equals("cancel")) {
                        requireKeys(request.params, Set.of("request_id"));
                        // A request that already answered has no monitor left.
                        TaskMonitor active = requestMonitors.get(requireInteger(request.params, "request_id"));
                        if (active != null) active.cancel();
                        continue;
                    }
                }
                catch (RuntimeException exception) {
                    inbound.put(new Inbound(null, null, true, null));
                    return;
                }
                inbound.put(admitRequest(request));
            }
        }
        catch (InterruptedException exception) {
            // The handler finished with this connection.
        }
    }

    private void serveClient(
            SessionDescriptor descriptor,
            BufferedReader reader,
            BufferedWriter writer,
            Request first) throws Exception {
        TaskMonitor scriptMonitor = monitor;
        BlockingQueue<Inbound> inbound = new ArrayBlockingQueue<>(INBOUND_REQUEST_CAPACITY);
        if (first != null) inbound.put(admitRequest(first));
        Thread requestReader = new Thread(
            () -> readRequests(descriptor, reader, inbound), "rea-bridge-request-reader");
        requestReader.setDaemon(true);
        requestReader.start();
        try {
            serveRequests(descriptor, writer, inbound);
        }
        finally {
            monitor = scriptMonitor;
            requestMonitors.clear();
            // Interrupting a blocked channel read closes the connection, which
            // the caller is about to do anyway.
            requestReader.interrupt();
        }
    }

    private void serveRequests(
            SessionDescriptor descriptor,
            BufferedWriter writer,
            BlockingQueue<Inbound> inbound) throws Exception {
        while (true) {
            Inbound next = inbound.take();
            if (next.failure() != null) throw next.failure();
            if (next.invalid()) {
                // The request id may not have parsed, so the connection-level
                // failure uses id 0, which no client request uses.
                writeFailure(writer, CONNECTION_FAILURE_ID, "invalid_request", "Bridge request is invalid");
                return;
            }
            Request request = next.request();
            if (request == null) return;
            monitor = next.monitor();
            try {
                if (request.method.equals("shutdown")) {
                    requireKeys(request.params, Set.of());
                    JsonObject result = new JsonObject();
                    result.addProperty("shutdown", true);
                    result.addProperty("project_ephemeral", true);
                    writeSuccess(writer, request.id, result);
                    return;
                }
                if (identityAdmissionFailure != null) {
                    // Keep the producer alive until the client has consumed the
                    // refusal and closed or sent shutdown. Every other request
                    // remains refused, including further startup attempts.
                    writeFailure(writer, request.id, identityAdmissionFailure,
                        "Ghidra imported identity admission failed");
                    continue;
                }
                decompileTimeoutSeconds = request.decompileTimeoutSeconds() == null
                    ? descriptor.decompileTimeoutSeconds() : request.decompileTimeoutSeconds();
                valueFlowLimits = request.valueFlowLimits();
                applyRequestDecompilerOptions(request);
                monitor.checkCancelled();
                dispatchAndWrite(writer, request, descriptor);
            }
            catch (RequestFailure failure) {
                writeFailure(writer, request.id, failure);
            }
            catch (StackOverflowError exhausted) {
                // Ghidra's data-type code can overflow while holding its database
                // lock, which then stays held: the Program can no longer be saved
                // or trusted. Admission bounds caller types (MAX_C_TYPE_DEPTH) so
                // this is not reachable from caller text; if it happens anyway,
                // say why and end the session rather than keep serving it.
                writeFailure(writer, request.id, "bridge_exception",
                    "StackOverflowError: Ghidra exhausted its stack and may hold its database lock; this Ghidra session cannot continue");
                throw exhausted;
            }
            catch (CancelledException exception) {
                writeFailure(writer, request.id, "request_cancelled", "Ghidra request was cancelled");
            }
            catch (Exception exception) {
                writeFailure(
                    writer,
                    request.id,
                    "bridge_exception",
                    exception.getClass().getSimpleName() + ": " + safeMessage(exception)
                );
            }
            finally {
                requestMonitors.remove(request.id);
            }
        }
    }

    private void dispatchAndWrite(
            BufferedWriter writer,
            Request request,
            SessionDescriptor descriptor) throws Exception {
        if (request.method.equals("ping")) {
            requireKeys(request.params, Set.of());
            writeSuccess(writer, request.id, sessionInfo(descriptor));
            return;
        }
        if (analysisTimeoutOccurred()) {
            throw new RequestFailure(
                "analysis_incomplete",
                "Ghidra auto-analysis did not complete for this Program"
            );
        }
        if (descriptor.existingProject && isMutatingOperation(request.method))
            throw new RequestFailure("method_unavailable", "Existing Ghidra project sessions are read-only");
        switch (request.method) {
            case "list_names" -> writeStreamingSuccess(writer, request.id, listNames(request.params));
            case "list_procedures" -> writeStreamingSuccess(writer, request.id, listProcedures(request.params));
            case "list_strings" -> writeStreamingSuccess(writer, request.id, listStrings(request.params));
            case "search_procedures" -> writeStreamingSuccess(writer, request.id, search(request.params, true));
            case "search_strings" -> writeStreamingSuccess(writer, request.id, search(request.params, false));
            default -> writeSuccess(writer, request.id, handleRequest(request, descriptor));
        }
    }

    private JsonElement handleRequest(Request request, SessionDescriptor descriptor)
            throws Exception {
        return switch (request.method) {
            case "checkpoint_program" -> checkpointProgram(request.params, descriptor);
            case "read_binary_inventory_summary" -> binaryInventorySummary(request.params);
            case "inspect_native_load_image" -> inspectNativeLoadImage(request.params);
            case "read_bytes" -> readMemoryBytes(request.params);
            case "search_bytes" -> searchMemoryBytes(request.params, descriptor);
            case "address_to_file_offset" -> addressToFileOffset(request.params);
            case "address_name" -> addressName(request.params);
            case "list_documents" -> listDocuments(request.params);
            case "list_segments" -> listSegments(request.params);
            case "procedure_address" -> procedureAddress(request.params);
            case "procedure_assembly" -> procedureAssembly(request.params);
            case "procedure_callees" -> procedureCalls(request.params, false);
            case "procedure_callers" -> procedureCalls(request.params, true);
            case "procedure_info" -> procedureInfo(request.params);
            case "procedure_pseudo_code" -> {
                try {
                    decompileAhead(request.decompileReadAhead());
                    yield procedurePseudocode(request.params);
                }
                finally {
                    // An unconsumed foreground result belongs to this request only.
                    clearDecompileAheadForeground();
                }
            }
            case "read_function_instructions" -> readFunctionInstructions(request.params);
            case "procedure_references" -> procedureReferences(request.params);
            case "resolve_containing_procedure" -> containingProcedure(request.params);
            case "inspect_native_data_type" -> inspectNativeDataType(request.params);
            case "inspect_native_instruction" -> inspectNativeInstruction(request.params, true);
            case "resolve_native_call_targets" -> resolveNativeCallTargets(request.params);
            case "xrefs" -> xrefs(request.params);
            case "analyze_function" -> {
                FunctionAnalysisObservation observation = analyzeFunctionObservation(request.params);
                JsonObject result = functionObservation(observation.dossier(), observation.limitations());
                result.add("relationship_coverage", observation.relationshipCoverage());
                if (observation.decompilerFailed()) result.addProperty("cache_policy", "live");
                yield result;
            }
            case "set_address_name", "set_addresses_names" -> {
                if (!descriptor.transport.equals("unix-socket"))
                    throw new RequestFailure("method_unavailable", "Windows P0 does not admit database mutation");
                yield request.method.equals("set_address_name")
                    ? setAddressName(request.params) : setAddressesNames(request.params);
            }
            case "annotate_native_function" -> {
                if (!descriptor.transport.equals("unix-socket"))
                    throw new RequestFailure("method_unavailable", "Windows P0 does not admit database mutation");
                yield annotateNativeFunction(request.params);
            }
            case "define_native_data_types" -> {
                if (!descriptor.transport.equals("unix-socket"))
                    throw new RequestFailure("method_unavailable", "Windows P0 does not admit database mutation");
                yield defineNativeDataTypes(request.params);
            }
            default -> throw new RequestFailure(
                "method_unavailable",
                "Bridge method is unavailable"
            );
        };
    }

    private static boolean isMutatingOperation(String method) {
        return method.equals("annotate_native_function") || method.equals("define_native_data_types") ||
            method.equals("set_address_name") || method.equals("set_addresses_names");
    }

    /** Internal lifecycle request: the destination is inside this owned runtime. */
    private JsonObject checkpointProgram(JsonObject params, SessionDescriptor descriptor) throws Exception {
        requireKeys(params, Set.of("path", "force"));
        if (descriptor.existingProject || !descriptor.transport.equals("unix-socket"))
            throw new RequestFailure("method_unavailable", "This Program has no checkpoint authority");
        Path output = Path.of(requireString(params, "path")).toAbsolutePath().normalize();
        if (!output.getParent().equals(checkpointDirectory) ||
            !output.getFileName().toString().matches("checkpoint-[a-f0-9-]{36}\\.gzf"))
            throw new RequestFailure("invalid_request", "Checkpoint destination must belong to this runtime");
        JsonElement forced = params.get("force");
        if (!forced.isJsonPrimitive() || !forced.getAsJsonPrimitive().isBoolean())
            throw new RequestFailure("invalid_request", "Checkpoint force must be a boolean");
        boolean force = forced.getAsBoolean();
        JsonObject result = new JsonObject();
        boolean changed = currentProgram.getModificationNumber() != checkpointModification;
        result.addProperty("saved", force || changed);
        if (force || changed) {
            if (Files.exists(output)) throw new RequestFailure("invalid_request", "Checkpoint destination already exists");
            currentProgram.saveToPackedFile(output.toFile(), monitor);
            checkpointModification = currentProgram.getModificationNumber();
            result.addProperty("path", output.toString());
        }
        return result;
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
        boolean readOnly = descriptor.existingProject || !descriptor.transport.equals("unix-socket");
        result.addProperty("read_only", readOnly);
        if (descriptor.existingProject) {
            result.add("analysis_complete", JsonNull.INSTANCE);
            result.addProperty("existing_project", true);
        } else result.addProperty("analysis_complete", !timedOut);
        result.addProperty("analysis_timed_out", timedOut);
        result.add("capabilities", GSON.toJsonTree(
            java.util.Arrays.stream(CAPABILITIES)
                .filter(value -> !readOnly || !isMutatingOperation(value))
                .toArray(String[]::new)
        ));
        result.add("target", target);
        result.add("pdb", pdbObservation());
        JsonArray extensions = analysisExtensions.reports();
        if (extensions.size() > 0) result.add("analysis_extensions", extensions);
        // Written by ReaGhidraApplySeeds before auto-analysis; REA checks it
        // against the committed profile.
        String seeds = currentProgram.getOptions(ghidra.program.model.listing.Program.PROGRAM_INFO)
            .getString("REA analysis seeds", null);
        if (seeds != null) result.add("analysis_seeds", JsonParser.parseString(seeds));
        // Written by ReaGhidraAnalysisOptions before auto-analysis; REA checks it
        // against the committed profile.
        String disabledAnalyzers = currentProgram.getOptions(ghidra.program.model.listing.Program.PROGRAM_INFO)
            .getString("REA disabled analyzers", null);
        if (disabledAnalyzers != null) result.add("disabled_analyzers", JsonParser.parseString(disabledAnalyzers));
        // Written by ReaGhidraMipsSoftFloat after analysis; REA requires it
        // exactly when the committed profile declares soft-float storage.
        String softFloat = currentProgram.getOptions(ghidra.program.model.listing.Program.PROGRAM_INFO)
            .getString("REA MIPS soft-float storage", null);
        if (softFloat != null) result.add("mips_soft_float_storage", JsonParser.parseString(softFloat));
        // Written by ReaGhidraRiscvCallingConvention after analysis; REA requires it
        // exactly when the committed profile declares a RISC-V calling-convention policy.
        String riscvCallingConvention = currentProgram.getOptions(ghidra.program.model.listing.Program.PROGRAM_INFO)
            .getString("REA RISC-V calling convention", null);
        if (riscvCallingConvention != null) result.add("riscv_calling_convention", JsonParser.parseString(riscvCallingConvention));
        // Written by ReaGhidraPrepareElfLoad before auto-analysis; REA requires it
        // exactly when the committed profile declares a RISC-V load preparation.
        String loadPreparation = currentProgram.getOptions(ghidra.program.model.listing.Program.PROGRAM_INFO)
            .getString("REA ELF load preparation", null);
        if (loadPreparation != null) result.add("elf_load_preparation", JsonParser.parseString(loadPreparation));
        return result;
    }

    /** Read loader/analyzer-owned facts without searching for or applying companions. */
    private JsonObject pdbObservation() {
        Options info = currentProgram.getOptions(ghidra.program.model.listing.Program.PROGRAM_INFO);
        JsonObject pdb = new JsonObject();
        String[] names = {"file", "guid", "age", "signature", "version"};
        String[] attributes = {
            PdbParserConstants.PDB_FILE, PdbParserConstants.PDB_GUID,
            PdbParserConstants.PDB_AGE, PdbParserConstants.PDB_SIGNATURE,
            PdbParserConstants.PDB_VERSION
        };
        int remaining = PDB_ATTRIBUTE_UTF16_BUDGET;
        JsonArray omitted = new JsonArray();
        for (int index = 0; index < names.length; index++) {
            String value = info.getString(attributes[index], null);
            if (value != null && value.length() > remaining) {
                omitted.add(names[index]);
                pdb.add(names[index], JsonNull.INSTANCE);
            } else {
                pdb.addProperty(names[index], value);
                if (value != null) remaining -= value.length();
            }
        }
        if (omitted.size() > 0) {
            JsonObject limit = new JsonObject();
            limit.addProperty("utf16_budget", PDB_ATTRIBUTE_UTF16_BUDGET);
            limit.add("omitted_attributes", omitted);
            pdb.add("resource_limit", limit);
        }
        if (info.contains(PdbParserConstants.PDB_LOADED))
            pdb.addProperty("loaded", info.getBoolean(PdbParserConstants.PDB_LOADED, false));
        else
            pdb.add("loaded", JsonNull.INSTANCE);
        return pdb;
    }

    private static String bytesHex(byte[] bytes) {
        return java.util.HexFormat.of().formatHex(bytes);
    }

    private String hashFileBytes(FileBytes source, boolean modified) throws Exception {
        if (!modified) {
            // Original FileBytes are immutable across analysis edits.
            String cached = originalFileBytesSha256.get(source);
            if (cached != null) return cached;
        }
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
        String hash = bytesHex(digest.digest());
        if (!modified) {
            originalFileBytesSha256.put(source, hash);
        }
        return hash;
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
        JsonArray recovery = analysisExtensions.inspectImage();
        if (recovery.size() > 0) result.add("metadata_recovery", recovery);
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
                mapping.addProperty("readable", block.isRead());
                mapping.addProperty("writable", block.isWrite());
                mapping.addProperty("executable", block.isExecute());
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
            row.add("symbol", GSON.toJsonTree(relocation.getSymbolName()));
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
        JsonArray contexts = new JsonArray();
        for (Address entry : entries) {
            JsonObject context = new JsonObject();
            context.addProperty("address", canonicalAddress(entry));
            JsonArray registers = new JsonArray();
            List<String> names = new ArrayList<>(List.of("CS", "DS", "ES", "SS"));
            for (String name : entryContextRegisters) if (!names.contains(name)) names.add(name);
            for (String name : names) {
                Register register = currentProgram.getRegister(name);
                if (register == null) continue;
                JsonObject row = new JsonObject();
                row.addProperty("name", name);
                BigInteger value = currentProgram.getProgramContext().getValue(register, entry, false);
                row.add("value_hex", value == null ? JsonNull.INSTANCE : GSON.toJsonTree("0x" + value.toString(16)));
                registers.add(row);
            }
            context.add("registers", registers);
            contexts.add(context);
        }
        result.add("entry_context", contexts);
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

    private record ByteSearchBlock(MemoryBlock block, Address low, Address high) {}

    private JsonObject searchMemoryBytes(JsonObject params, SessionDescriptor descriptor) throws Exception {
        // mask, start, end, and cursor are omitted when absent; JSON encoding drops those keys.
        Set<String> keys = params.keySet();
        if (!keys.containsAll(Set.of("document", "pattern", "limit")) ||
            !Set.of("document", "pattern", "mask", "start", "end", "limit", "cursor").containsAll(keys))
            throw new RequestFailure("invalid_request", "Bridge request fields are invalid");
        requireDocument(params);
        // Public input validation owns the grammar; validate again at the socket boundary.
        String pattern = requireString(params, "pattern").replaceAll("[\\s\\p{Z}\\uFEFF]", "");
        String mask = params.has("mask") ? requireString(params, "mask") : null;
        if (mask != null) mask = mask.replaceAll("[\\s\\p{Z}\\uFEFF]", "");
        if (pattern.isEmpty() || pattern.length() % 2 != 0 ||
            (mask != null && mask.length() != pattern.length()))
            throw new RequestFailure("invalid_request", "Mask length must equal a nonempty byte pattern length");
        byte[] bytes = new byte[pattern.length() / 2];
        byte[] masks = new byte[bytes.length];
        boolean constrained = false;
        for (int index = 0; index < bytes.length; index++) {
            monitor.checkCancelled();
            String pair = pattern.substring(index * 2, index * 2 + 2);
            if ((!pair.equals("??") && !isHexadecimal(pair, 0, 2)) ||
                (mask != null && !isHexadecimal(mask, index * 2, index * 2 + 2)))
                throw new RequestFailure("invalid_request", "Use hexadecimal byte pairs or ?? wildcards");
            int selected = mask == null ? 255 : Integer.parseInt(mask.substring(index * 2, index * 2 + 2), 16);
            bytes[index] = (byte) (pair.equals("??") ? 0 : Integer.parseInt(pair, 16));
            masks[index] = (byte) (pair.equals("??") ? 0 : selected);
            constrained |= masks[index] != 0;
        }
        if (!constrained) throw new RequestFailure("invalid_request", "Pattern must constrain at least one bit");
        int limit = requireBoundedInteger(params, "limit", 1, 1000);
        Address start = params.has("start") ? requireAddress(params, "start") : null;
        Address end = params.has("end") ? requireAddress(params, "end") : null;
        if (start != null && end != null &&
            (!start.getAddressSpace().equals(end.getAddressSpace()) || start.compareTo(end) > 0))
            throw new RequestFailure("invalid_request", "Search bounds must be ordered in one address space");
        JsonArray identity = new JsonArray();
        for (String value : new String[] { descriptor.targetSha256, descriptor.profileDigest,
                bytesHex(bytes), bytesHex(masks), start == null ? "" : canonicalAddress(start),
                end == null ? "" : canonicalAddress(end), optionalString(params, "document") }) identity.add(value);
        String binding = bytesHex(MessageDigest.getInstance("SHA-256").digest(identity.toString().getBytes(StandardCharsets.UTF_8)));
        String cursor = params.has("cursor") ? requireString(params, "cursor") : null;
        Address resume = null;
        if (cursor != null) {
            // The prefix is a one-way digest of target, profile, pattern,
            // mask, bounds, and document. A mismatch cannot name which one
            // differs, so this code reports the binding instead of schema repair.
            if (!cursor.startsWith(binding + ":"))
                throw new RequestFailure("byte_search_cursor_mismatch",
                    "Byte search cursor does not match this search. It is bound to the target, analysis profile (including a selected Ghidra project), pattern, mask, bounds, and document, and does not identify which of those differs.");
            resume = parseReaAddress(cursor.substring(binding.length() + 1));
            MemoryBlock resumedBlock = currentProgram.getMemory().getBlock(resume);
            Address bound = start == null ? end : start;
            if (resumedBlock == null || !resumedBlock.isInitialized() ||
                (bound != null && !bound.getAddressSpace().equals(resume.getAddressSpace())) ||
                (start != null && resume.compareTo(start) < 0) ||
                (end != null && resume.compareTo(end) > 0))
                throw new RequestFailure("invalid_request", "Byte search cursor lies outside initialized query memory");
        }
        List<MemoryBlock> ordered = new ArrayList<>(List.of(currentProgram.getMemory().getBlocks()));
        ordered.sort(Comparator.comparing(MemoryBlock::getStart));
        JsonArray matches = new JsonArray();
        JsonArray blocks = new JsonArray();
        JsonArray skipped = new JsonArray();
        JsonArray notLoaded = new JsonArray();
        JsonArray overlays = new JsonArray();
        List<ByteSearchBlock> eligible = new ArrayList<>();
        for (MemoryBlock block : ordered) {
            monitor.checkCancelled();
            Address low = block.getStart();
            Address high = block.getEnd();
            Address bound = start == null ? end : start;
            if (bound != null && !bound.getAddressSpace().equals(low.getAddressSpace())) continue;
            // Without bounds, search loaded non-overlay memory. Unloaded file
            // parts and loaded overlays stay reachable through explicit bounds.
            if (bound == null && !block.isLoaded()) {
                notLoaded.add(byteSearchCoverage(block, low, high));
                continue;
            }
            if (bound == null && block.isOverlay()) {
                overlays.add(byteSearchCoverage(block, low, high));
                continue;
            }
            if (start != null && low.compareTo(start) < 0) low = start;
            if (end != null && high.compareTo(end) > 0) high = end;
            if (low.compareTo(high) > 0) continue;
            if (!block.isInitialized()) {
                skipped.add(byteSearchCoverage(block, low, high));
                continue;
            }
            eligible.add(new ByteSearchBlock(block, low, high));
        }
        long covered = 0;
        String next = null;
        for (int first = 0; first < eligible.size() && next == null;) {
            monitor.checkCancelled();
            int last = first;
            while (last + 1 < eligible.size()) {
                monitor.checkCancelled();
                ByteSearchBlock previous = eligible.get(last);
                ByteSearchBlock following = eligible.get(last + 1);
                if (!previous.high().getAddressSpace().equals(following.low().getAddressSpace()) ||
                    previous.high().next() == null || !previous.high().next().equals(following.low())) break;
                last++;
            }
            Address low = eligible.get(first).low();
            Address high = eligible.get(last).high();
            if (resume != null && low.compareTo(resume) < 0) low = resume;
            if (low.compareTo(high) <= 0 && low.getAddressSpace().equals(high.getAddressSpace())) {
                Address at = low;
                Address examinedEnd = high;
                while (at != null && at.compareTo(high) <= 0 && high.subtract(at) >= bytes.length - 1L) {
                    monitor.checkCancelled();
                    // findBytes bounds candidate starts. The entire candidate remains in this eligible run.
                    Address found = currentProgram.getMemory().findBytes(at, high.subtract(bytes.length - 1L), bytes, masks, true, monitor);
                    monitor.checkCancelled();
                    if (found == null || high.subtract(found) < bytes.length - 1L) break;
                    if (matches.size() == limit) {
                        next = binding + ":" + canonicalAddress(found);
                        examinedEnd = found.addNoWrap(bytes.length - 1L);
                        break;
                    }
                    MemoryBlock matchBlock = currentProgram.getMemory().getBlock(found);
                    JsonObject match = new JsonObject();
                    match.addProperty("address", canonicalAddress(found));
                    match.addProperty("segment", matchBlock.getName());
                    Long offset = targetFileOffset(matchBlock, found).offset();
                    match.add("file_offset", offset == null ? JsonNull.INSTANCE : GSON.toJsonTree(offset));
                    Function function = currentProgram.getFunctionManager().getFunctionContaining(found);
                    JsonObject procedure = new JsonObject();
                    if (function != null) {
                        procedure.addProperty("address", canonicalAddress(function.getEntryPoint()));
                        procedure.addProperty("name", function.getName(true));
                    }
                    match.add("procedure", function == null ? JsonNull.INSTANCE : procedure);
                    matches.add(match);
                    at = found.next();
                }
                for (int index = first; index <= last; index++) {
                    monitor.checkCancelled();
                    ByteSearchBlock item = eligible.get(index);
                    Address coveredLow = item.low().compareTo(low) < 0 ? low : item.low();
                    Address coveredHigh = item.high().compareTo(examinedEnd) > 0 ? examinedEnd : item.high();
                    if (coveredLow.compareTo(coveredHigh) > 0) continue;
                    JsonObject coverage = byteSearchCoverage(item.block(), coveredLow, coveredHigh);
                    covered = Math.addExact(covered, coverage.get("bytes").getAsLong());
                    blocks.add(coverage);
                }
            }
            first = last + 1;
        }
        JsonObject searched = new JsonObject();
        searched.add("blocks", blocks);
        searched.addProperty("bytes", covered);
        searched.add("skipped_uninitialized", skipped);
        searched.add("skipped_not_loaded", notLoaded);
        searched.add("skipped_overlays", overlays);
        JsonObject result = new JsonObject();
        result.add("matches", matches);
        result.add("searched", searched);
        result.addProperty("complete", next == null);
        result.add("next_cursor", next == null ? JsonNull.INSTANCE : GSON.toJsonTree(next));
        return result;
    }

    private static JsonObject byteSearchCoverage(MemoryBlock block, Address low, Address high) {
        JsonObject result = new JsonObject();
        result.addProperty("segment", block.getName());
        result.addProperty("start", canonicalAddress(low));
        result.addProperty("end", canonicalAddress(high));
        result.addProperty("bytes", high.subtract(low) + 1);
        return result;
    }

    private record TargetFileOffset(Long offset, int mappings) {}

    private TargetFileOffset targetFileOffset(MemoryBlock block, Address address) throws Exception {
        Long offset = null;
        int mappings = 0;
        for (MemoryBlockSourceInfo source : block.getSourceInfos()) {
            if (!source.contains(address) || source.getFileBytes().isEmpty() ||
                !isTargetSource(source.getFileBytes().get())) continue;
            long candidate = source.getFileBytesOffset(address);
            if (candidate < 0) continue;
            offset = candidate;
            mappings++;
        }
        return new TargetFileOffset(mappings == 1 && offset <= 9007199254740991L ? offset : null, mappings);
    }

    private JsonObject addressToFileOffset(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "address"));
        requireDocument(params);
        Address address = requireAddress(params, "address");
        String at = canonicalAddress(address);
        // A well-formed address can still lack one exact source offset. Each
        // outcome has its own code, so REA reports the reason rather than
        // schema repair. Initialization, not the loaded flag, decides whether
        // source bytes can exist: file-backed overlays are not loaded.
        MemoryBlock block = currentProgram.getMemory().getBlock(address);
        if (block == null)
            throw new RequestFailure("address_unmapped",
                "Address " + at + " is outside every Ghidra memory block");
        if (!block.isInitialized())
            throw new RequestFailure("address_uninitialized",
                "Address " + at + " is in uninitialized Ghidra memory block " + block.getName());
        TargetFileOffset mapping = targetFileOffset(block, address);
        if (mapping.mappings() == 0)
            throw new RequestFailure("file_mapping_absent",
                "Address " + at + " in initialized Ghidra memory block " + block.getName() +
                " has no authoritative mapping to the admitted target file");
        if (mapping.mappings() > 1)
            throw new RequestFailure("file_mapping_ambiguous",
                "Address " + at + " has " + mapping.mappings() +
                " authoritative mappings to the admitted target file");
        Long fileOffset = mapping.offset();
        if (fileOffset == null)
            throw new RequestFailure("file_offset_unrepresentable",
                "Address " + at + " maps to an admitted target-file offset beyond the exact JSON integer range");
        JsonObject result = new JsonObject();
        result.addProperty("address", at);
        result.addProperty("file_offset", fileOffset);
        return result;
    }

    /**
     * Ghidra applies most loader relocations, but one it cannot apply (for
     * example an ELF copy relocation in RELRO, whose value comes from another
     * object, or a TLS slot that only the dynamic loader fills) keeps its
     * on-disk bytes while the runtime loader supplies a different value. Mark
     * such a destination in a non-writable loaded block volatile before opening
     * the decompiler so those bytes cannot be constant-propagated as if they
     * were runtime values.
     *
     * Volatility is set on the destination's own data item (its Mutability
     * setting), so the rest of the block, for example the GOT entries Ghidra
     * applied beside a TLS slot, stays foldable. Where no data item can be
     * placed on exactly the destination, the whole block is marked volatile
     * instead. This changes only the ephemeral analysis database: source
     * FileBytes and the original target remain untouched, and block
     * permissions are preserved.
     *
     * Without database-mutation authority (Windows P0 or a caller's existing
     * project) the relocations are still recorded so affected procedures carry
     * the limitation, but nothing is marked volatile.
     */
    private void protectLoaderInitializedRelocations(boolean markVolatile) throws Exception {
        String elfFileType = currentProgram.getOptions(
            ghidra.program.model.listing.Program.PROGRAM_INFO
        ).getString(ElfLoader.ELF_FILE_TYPE_PROPERTY, "");
        // Ghidra also marks ELF ET_DYN and ET_CORE programs relocatable.
        if (currentProgram.getRelocationTable().isRelocatable() &&
            !elfFileType.equals("shared object")) return;
        Map<Address, LoaderInitializedRelocation> discovered = new TreeMap<>();
        Map<Address, MemoryBlock> blocks = new TreeMap<>();
        Iterator<Relocation> iterator = currentProgram.getRelocationTable().getRelocations();
        while (iterator.hasNext()) {
            monitor.checkCancelled();
            Relocation relocation = iterator.next();
            // An applied relocation already holds the value the loader writes
            // (for example GLOB_DAT or RELATIVE), so folding it is correct and
            // keeping its block foldable preserves GOT-call pseudocode.
            Relocation.Status status = relocation.getStatus();
            if (status == Relocation.Status.APPLIED || status == Relocation.Status.APPLIED_OTHER)
                continue;
            Address location = relocation.getAddress();
            MemoryBlock block = currentProgram.getMemory().getBlock(location);
            if (block == null || !block.isLoaded() || !block.isInitialized() || block.isWrite())
                continue;
            long lengthInBytes = relocation.getLength();
            int addressableUnitSize = location.getAddressSpace().getAddressableUnitSize();
            long lengthInAddressableUnits = Math.max(
                1L,
                (lengthInBytes + addressableUnitSize - 1L) / addressableUnitSize
            );
            discovered.put(
                location,
                new LoaderInitializedRelocation(
                    location,
                    lengthInAddressableUnits,
                    block.getName(),
                    relocation.getSymbolName()
                )
            );
            blocks.put(location, block);
        }
        if (discovered.isEmpty()) return;
        loaderInitializedRelocations.putAll(discovered);
        if (!markVolatile) return;

        int transaction = currentProgram.startTransaction("REA loader relocation semantics");
        boolean commit = false;
        try {
            Listing listing = currentProgram.getListing();
            Set<MemoryBlock> wholeBlocks =
                java.util.Collections.newSetFromMap(new IdentityHashMap<>());
            for (LoaderInitializedRelocation relocation : discovered.values()) {
                monitor.checkCancelled();
                Data data = volatileRelocationData(listing, relocation);
                if (data == null) wholeBlocks.add(blocks.get(relocation.address()));
                else MutabilitySettingsDefinition.DEF.setChoice(
                    data, MutabilitySettingsDefinition.VOLATILE);
            }
            for (MemoryBlock block : wholeBlocks) {
                monitor.checkCancelled();
                if (!block.isVolatile()) block.setVolatile(true);
            }
            commit = true;
        }
        finally {
            currentProgram.endTransaction(transaction, commit);
        }
    }

    /**
     * The data item that starts at this relocation destination and covers it,
     * created as undefined bytes when nothing is defined there; null when an
     * instruction occupies it or a data item starts before it.
     */
    private Data volatileRelocationData(
            Listing listing, LoaderInitializedRelocation relocation) throws Exception {
        Address start = relocation.address();
        long length = relocation.lengthInAddressableUnits();
        if (length > Integer.MAX_VALUE) return null;
        Data existing = listing.getDefinedDataContaining(start);
        if (existing != null)
            return existing.getAddress().equals(start) && existing.getLength() >= length
                ? existing
                : null;
        // A range iterator only sees instructions whose start lies in the range.
        if (listing.getInstructionContaining(start) != null) return null;
        Address end = start.add(length - 1);
        if (listing.getInstructions(new ghidra.program.model.address.AddressSet(start, end), true)
                .hasNext())
            return null;
        if (listing.getDefinedData(new ghidra.program.model.address.AddressSet(start, end), true)
                .hasNext())
            return null;
        return listing.createData(start, Undefined.getUndefinedDataType((int) length));
    }

    private LoaderInitializedRelocation loaderInitializedRelocationAt(Address address) {
        Map.Entry<Address, LoaderInitializedRelocation> entry =
            loaderInitializedRelocations.floorEntry(address);
        if (entry == null) return null;
        LoaderInitializedRelocation relocation = entry.getValue();
        return relocation.contains(address) ? relocation : null;
    }

    private DecompileOptions decompileOptions(Integer payloadMiB) {
        DecompileOptions options = new DecompileOptions();
        options.setMaxInstructions(Integer.MAX_VALUE);
        if (payloadMiB != null) options.setMaxPayloadMBytes(payloadMiB);
        return options;
    }

    /**
     * Only a request that carries decompiler options changes them. Another
     * read leaves the session's payload limit, and the decompiles completed
     * under it, in place.
     */
    private void applyRequestDecompilerOptions(Request request) {
        if (request.decompilePayload() != null)
            applyDecompilePayloadLimit(request.decompilePayload().mebibytes());
    }

    private void applyDecompilePayloadLimit(Integer payloadMiB) {
        if (java.util.Objects.equals(decompileMaxPayloadMiB, payloadMiB)) return;
        // DecompInterface supports live setOptions: it updates the existing
        // DecompileProcess result-size bound before sending native options.
        if (!decompiler.setOptions(decompileOptions(payloadMiB)))
            throw new RequestFailure("decompile_options_failed", "Ghidra could not apply the selected native decompiler payload limit");
        decompiler.flushCache();
        decompileResults.clear();
        disposeDecompileAhead();
        decompileMaxPayloadMiB = payloadMiB;
    }

    private void initializeDecompiler() {
        decompiler = new DecompInterface();
        decompiler.setOptions(decompileOptions(decompileMaxPayloadMiB));
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
        String selector = requireString(params, "procedure");
        JsonObject selection = new JsonObject();
        Function function = resolveDecompileProcedure(selector, selection);
        try {
            DecompileResults results = decompile(function);
            String value = decompiledText(results);
            Function decompiled = decompiledFunction(function, results);
            List<String> limitations = new ArrayList<>(functionBoundaryLimitations(
                decompiled,
                currentProgram.getListing().getInstructions(decompiled.getBody(), true)
            ));
            if (selection.has("undefined_function_entry"))
                limitations.add(0, undefinedFunctionLimitation(selection));
            JsonObject result = functionObservation(
                value == null ? JsonNull.INSTANCE : GSON.toJsonTree(value),
                limitations
            );
            // The file-offset selection is a contract field; an undefined
            // function's inferred entry is carried by its limitation.
            if (selection.has("file_offset")) {
                JsonObject fileOffsetSelection = new JsonObject();
                for (String key : List.of("file_offset", "mapped_address", "procedure_address"))
                    fileOffsetSelection.add(key, selection.get(key));
                result.add("selection", fileOffsetSelection);
            }
            return result;
        } catch (RequestFailure failure) {
            if (!selection.has("mapped_address")) throw failure;
            // Preserve completed resolution facts without changing the backend's
            // failure code or suggesting that the successful mapping was invalid.
            throw failure.prefixed("Selector " + selector +
                " mapped to analysis address " + selection.get("mapped_address").getAsString() +
                " and procedure " + canonicalAddress(function.getEntryPoint()) + "; ");
        }
    }

    private Function resolveDecompileProcedure(String selector, JsonObject selection) throws Exception {
        String prefix = "file-offset:";
        boolean explicitOffset = selector.startsWith(prefix);
        if (!explicitOffset) {
            try {
                return resolveProcedure(selector);
            } catch (RequestFailure failure) {
                // Existing names/addresses win. Only an unresolved numeric input
                // can fall back to source coordinates; ambiguity never falls back.
                if (!failure.code.equals("procedure_not_found")) throw failure;
                // Analyzed code outside every function is still an analysis
                // address, so it wins over a file-offset reading of the number.
                Address requested = isExplicitReaAddress(selector) ? parseReaAddress(selector) : tryParseAddress(selector);
                Function undefined = requested == null ? null : undefinedFunctionAt(requested, selection);
                if (undefined != null) return undefined;
                if (!selector.matches("0x[0-9a-fA-F]+")) throw failure;
            }
        }
        String coordinate = explicitOffset ? selector.substring(prefix.length()) : selector;
        if (!coordinate.matches("0x[0-9a-fA-F]+"))
            throw new RequestFailure("invalid_request", "File offsets require hexadecimal file-offset:0x... syntax");
        BigInteger parsed = new BigInteger(coordinate.substring(2), 16);
        if (parsed.compareTo(BigInteger.valueOf(9007199254740991L)) > 0)
            throw new RequestFailure("invalid_request", "File offset exceeds the exact JSON integer range");
        long offset = parsed.longValueExact();
        monitor.checkCancelled();
        // Ghidra's convenience lookup spans every FileBytes and uses coordinates
        // local to each object. Only a complete, digest-matched target source
        // establishes that the caller's offset belongs to the admitted file.
        Set<Address> mappedAddresses = new java.util.LinkedHashSet<>();
        for (MemoryBlock block : currentProgram.getMemory().getBlocks()) {
            for (MemoryBlockSourceInfo source : block.getSourceInfos()) {
                monitor.checkCancelled();
                FileBytes backing = source.getFileBytes().orElse(null);
                if (backing == null || !isTargetSource(backing)) continue;
                Address mapped = source.locateAddressForFileOffset(offset);
                if (mapped != null) mappedAddresses.add(mapped);
            }
        }
        List<Address> candidates = new ArrayList<>(mappedAddresses);
        if (candidates.size() > 1)
            throw new RequestFailure("file_offset_ambiguous", "File offset " + coordinate +
                " has multiple loaded mappings: " + candidates.stream().map(ReaGhidraBridge::canonicalAddress).toList() +
                "; select an explicit analysis address");
        if (candidates.isEmpty())
            throw new RequestFailure("file_offset_unmapped",
                (explicitOffset || !isMappedAnalysisAddress(selector) ? "" :
                    coordinate + " is a mapped analysis address that holds no disassembled code and no procedure. Read as a file offset instead: ") +
                "File offset " + coordinate +
                " has no loaded source mapping for the admitted target file; Ghidra image base: " + canonicalAddress(currentProgram.getImageBase()) +
                ". Inspect mappings with rea inspect-native-load-image <path> --provider ghidra --json or MCP inspect_native_load_image.");
        Address mapped = candidates.get(0);
        // A file offset names the same location as its mapped analysis
        // address, so it resolves the way that address does, including code
        // outside every function.
        Function function = functionAtOrContaining(mapped);
        if (function == null) function = undefinedFunctionAt(mapped, selection);
        if (function == null)
            throw new RequestFailure("procedure_not_found", "File offset " + coordinate +
                " maps to analysis address " + canonicalAddress(mapped) +
                ", but no procedure starts at or contains that address in the current Ghidra analysis. " +
                "Choose an observed procedure with CLI rea search <path> . --kind procedures --mode regex --provider ghidra --json or MCP list_procedures.");
        selection.addProperty("file_offset", offset);
        selection.addProperty("mapped_address", canonicalAddress(mapped));
        selection.addProperty("procedure_address", canonicalAddress(function.getEntryPoint()));
        return function;
    }

    /**
     * Ghidra can disassemble code without creating a function for it, for
     * example a range named only by an exception-frame entry and reached
     * through a data reference, as `main` is in a stripped ELF. The decompiler
     * panel reads such code through an on-the-fly UndefinedFunction, which
     * leaves the Program unchanged; this does the same and records that the
     * entry is inferred from control flow and absent from the inventory.
     */
    private Function undefinedFunctionAt(Address address, JsonObject selection) throws Exception {
        if (!isCodeOutsideFunctions(address)) return null;
        UndefinedFunction undefined =
            UndefinedFunction.findFunction(currentProgram, address, monitor);
        if (undefined == null) return null;
        selection.addProperty("requested_address", canonicalAddress(address));
        selection.addProperty("undefined_function_entry", canonicalAddress(undefined.getEntryPoint()));
        return undefined;
    }

    private static final String CODE_OUTSIDE_FUNCTIONS =
        "Ghidra disassembled code there without creating a function, so it is absent from the procedure inventory";

    private boolean isCodeOutsideFunctions(Address address) {
        return address.isMemoryAddress() &&
            currentProgram.getListing().getInstructionContaining(address) != null &&
            functionAtOrContaining(address) == null;
    }

    private boolean isMappedAnalysisAddress(String selector) {
        Address address = tryParseAddress(selector);
        return address != null && address.isMemoryAddress() && currentProgram.getMemory().contains(address);
    }

    private static String undefinedFunctionLimitation(JsonObject selection) {
        return "No Ghidra function contains " + selection.get("requested_address").getAsString() +
            ": Ghidra disassembled this code without creating a function, so it is absent from the procedure inventory. " +
            "This pseudocode is Ghidra's on-the-fly decompilation from " +
            selection.get("undefined_function_entry").getAsString() +
            ", an entry inferred by following control flow back from the requested address. " +
            "The entry and extent are not an analyzed function boundary, and the Program is unchanged.";
    }

    private boolean isTargetSource(FileBytes source) throws Exception {
        Boolean observed = targetSourceIdentity.get(source);
        if (observed != null) return observed;
        // Original FileBytes are immutable even when analysis memory is edited.
        // Partial/auxiliary sources remain inspectable but cannot establish an
        // original-target offset from their object-local coordinates alone.
        boolean matched = source.getFileOffset() == 0 &&
            constantTimeEquals(hashFileBytes(source, false), admittedTargetSha256);
        targetSourceIdentity.put(source, matched);
        return matched;
    }

    private JsonElement procedureAssembly(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "procedure"));
        requireDocument(params);
        Function function = resolveProcedure(requireString(params, "procedure"));
        InstructionScan scan = scanInstructions(function, Integer.MAX_VALUE);
        return functionObservation(
            GSON.toJsonTree(renderAssembly(scan.instructions)),
            functionBoundaryLimitations(function, scan.instructions)
        );
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
        List<String> boundaryLimitations = functionBoundaryLimitations(function, scan.instructions);
        for (String limitation : boundaryLimitations) limitations.add(limitation);
        JsonObject result = new JsonObject();
        result.add("procedure", procedureIdentity(function));
        result.add("instructions", items);
        result.add("limitations", limitations);
        return functionObservation(result, boundaryLimitations);
    }

    private JsonObject procedureCalls(JsonObject params, boolean callers) throws Exception {
        requireKeys(params, Set.of("document", "procedure"));
        requireDocument(params);
        String selector = requireString(params, "procedure");
        if (callers) {
            Address target = incomingNonProcedureAddress(selector);
            if (target != null) return addressCallers(target);
        }
        Function function = resolveProcedure(selector);
        Set<Function> observed = callers
            ? function.getCallingFunctions(monitor)
            : function.getCalledFunctions(monitor);
        List<Function> ordered = new ArrayList<>(observed);
        ordered.sort(Comparator.comparing(Function::getEntryPoint));
        JsonArray result = new JsonArray();
        for (Function item : ordered) {
            result.add(canonicalAddress(item.getEntryPoint()));
        }
        if (callers) {
            JsonObject observation = functionObservation(result, functionBoundaryLimitations(function,
                currentProgram.getListing().getInstructions(function.getBody(), true)
            ));
            observation.add("relationship_coverage", callRelationshipCoverage(null,
                unrepresentedIncomingCalls(function, observed)));
            monitor.checkCancelled();
            return observation;
        }
        CallBoundaryObservation calls = callBoundaryObservation(
            function, currentProgram.getListing().getInstructions(function.getBody(), true), observed, false, null
        );
        return callRelationshipObservation(result, calls);
    }

    private JsonObject procedureInfo(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "procedure"));
        requireDocument(params);
        Function function = resolveProcedure(requireString(params, "procedure"));
        JsonObject result = new JsonObject();
        result.addProperty("name", procedureName(function));
        Symbol symbol = function.getSymbol();
        result.add("symbol", symbol == null ? JsonNull.INSTANCE : symbolMetadata(symbol));
        result.addProperty("entrypoint", canonicalAddress(function.getEntryPoint()));
        result.addProperty("basicblock_count", basicBlocks(function).size());
        JsonObject body = functionBody(function);
        result.addProperty("length", body.get("total_bytes").getAsLong());
        result.add("body", body);
        result.addProperty("signature", function.getPrototypeString(false, true));
        result.add("locals", functionLocals(function));
        result.add("classification", functionClassification(function));
        return functionObservation(
            result,
            functionBoundaryLimitations(
                function,
                currentProgram.getListing().getInstructions(function.getBody(), true)
            )
        );
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
        String selector = requireString(params, "procedure");
        String direction = requireString(params, "direction");
        if (!direction.equals("incoming") && !direction.equals("outgoing")) {
            throw new RequestFailure("invalid_request", "direction must be incoming or outgoing");
        }
        if (direction.equals("incoming")) {
            Address target = incomingNonProcedureAddress(selector);
            if (target != null) return addressReferences(target);
        }
        Function function = resolveProcedure(selector);
        List<Reference> references = collectReferences(function, direction);
        JsonArray edges = referenceEdges(references);
        JsonObject result = new JsonObject();
        result.add("procedure", procedureIdentity(function));
        result.addProperty("direction", direction);
        result.add("references", edges);
        result.addProperty("reference_kinds_available", true);
        List<String> limitations;
        JsonArray unresolvedCalls = new JsonArray();
        if (direction.equals("outgoing")) {
            CallBoundaryObservation calls = callBoundaryObservation(
                function, currentProgram.getListing().getInstructions(function.getBody(), true), null, true, references
            );
            unresolvedCalls = calls.unresolvedCalls();
            limitations = calls.limitations();
        } else {
            limitations = functionBoundaryLimitations(
                function,
                currentProgram.getListing().getInstructions(function.getBody(), true)
            );
        }
        result.add("unresolved_calls", unresolvedCalls);
        return functionObservation(result, limitations);
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
            result.addProperty("kind", dataTypeKind(type));
            if (isCallerDefinedType(type)) result.addProperty("source", "caller-defined");
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
                        JsonObject bitField = new JsonObject();
                        bitField.addProperty("base_type_id", bitfield.getBaseDataType().getPathName());
                        bitField.addProperty("declared_bit_size", bitfield.getDeclaredBitSize());
                        bitField.addProperty("component_type_lookup", typeLookupResult(bitfield));
                        bitField.addProperty("base_type_lookup", typeLookupResult(bitfield.getBaseDataType()));
                        field.add("bit_field", bitField);
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
        result.add("limitations", GSON.toJsonTree(List.of("Layouts are Ghidra data-type database observations; original debug/source authority and flexible-tail semantics are not inferred. Component type paths do not necessarily identify separately registered types; bit-field lookups report whether the manager resolves equivalent types.", "At most 20000 fields or enum members are serialized per type to bound provider output. total_fields and truncated report omissions. Enum values preserve Ghidra's signed long representation.")));
        if (type != null) {
            JsonObject metadata = analysisExtensions.inspectDataType(currentProgram, type, address, monitor);
            if (metadata != null) result.add("metadata_recovery", metadata);
        }
        return result;
    }

    private static String dataTypeKind(DataType type) {
        return type instanceof ghidra.program.model.data.Structure ? "struct" : type instanceof ghidra.program.model.data.Union ? "union" : type instanceof ghidra.program.model.data.Enum ? "enum" : type instanceof ghidra.program.model.data.Pointer ? "pointer" : type instanceof ghidra.program.model.data.Array ? "array" : type instanceof ghidra.program.model.data.TypeDef ? "typedef" : type instanceof ghidra.program.model.data.BuiltInDataType ? "scalar" : "unsupported";
    }

    private String typeLookupResult(DataType type) {
        DataType resolved = currentProgram.getDataTypeManager().getDataType(type.getPathName());
        return resolved == null ? "not-found" : resolved.isEquivalent(type) ? "equivalent" : "different";
    }

    private JsonObject instructionReference(Reference reference) {
        JsonObject item = new JsonObject();
        JsonObject kind = referenceKind(reference);
        item.addProperty("source_address", canonicalAddress(reference.getFromAddress()));
        item.addProperty("target_address", canonicalAddress(reference.getToAddress()));
        for (String field : List.of("type", "call", "jump", "indirect", "computed",
                "operand_index", "data", "read", "write", "primary", "provenance"))
            item.add(field, kind.get(field));
        item.addProperty("source", normalizedSource(reference.getSource()));
        return item;
    }

    private JsonObject inspectNativeInstruction(JsonObject params, boolean includeIncoming) throws Exception {
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
        if (currentProgram.getLanguageID().getIdAsString().startsWith("MIPS:") ||
            currentProgram.getLanguageID().getIdAsString().startsWith("ARM:")) {
            JsonArray decoderContext = new JsonArray();
            String regName = currentProgram.getLanguageID().getIdAsString().startsWith("MIPS:") ? "ISA_MODE" : "TMode";
            var modeRegister = currentProgram.getRegister(regName);
            if (modeRegister != null) {
                var modeValue = currentProgram.getProgramContext().getValue(modeRegister, address, false);
                JsonObject context = new JsonObject();
                context.addProperty("register", modeRegister.getName());
                context.add("value", modeValue == null ? JsonNull.INSTANCE : GSON.toJsonTree(modeValue.toString()));
                context.addProperty("source", "ghidra-program-context");
                decoderContext.add(context);
            }
            result.add("decoder_context", decoderContext);
        }
        JsonArray operands = new JsonArray();
        JsonArray references = new JsonArray();
        JsonArray destinations = new JsonArray();
        JsonArray flowEvidence = new JsonArray();
        JsonObject flow = new JsonObject();
        flow.addProperty("kind", "unavailable");
        flow.addProperty("conditional", false);
        flow.addProperty("computed", false);
        if (instruction == null) {
            Instruction containing = currentProgram.getListing().getInstructionContaining(address);
            boolean inMemory = currentProgram.getMemory().contains(address);
            Data containingData = inMemory && containing == null
                ? currentProgram.getListing().getDefinedDataContaining(address) : null;
            result.addProperty("status", !inMemory ? "outside-memory" : containing != null
                ? "not-instruction-boundary" : containingData != null ? "data" : "not-in-listing");
            if (inMemory && containing == null && containingData != null) {
                JsonObject parentData = new JsonObject();
                parentData.addProperty("address", canonicalAddress(containingData.getAddress()));
                parentData.addProperty("length", containingData.getLength());
                parentData.addProperty("type_id", containingData.getDataType().getPathName());
                parentData.addProperty("provenance", "ghidra-listing");
                result.add("containing_data", parentData);
            }
            if (containing != null && currentProgram.getMemory().contains(address)) {
                JsonObject containingInstruction = new JsonObject();
                containingInstruction.addProperty("address", canonicalAddress(containing.getAddress()));
                containingInstruction.addProperty("length", containing.getLength());
                containingInstruction.addProperty("mnemonic", containing.getMnemonicString());
                containingInstruction.addProperty("raw_disassembly", containing.toString());
                containingInstruction.addProperty("provenance", "ghidra-listing");
                result.add("containing_instruction", containingInstruction);
            }
            for (String key : List.of("bytes", "length", "mnemonic", "raw_disassembly")) result.add(key, JsonNull.INSTANCE);
        } else {
            result.addProperty("status", "decoded");
            result.addProperty("bytes", java.util.HexFormat.of().formatHex(instruction.getBytes()));
            result.addProperty("length", instruction.getLength());
            result.addProperty("mnemonic", instruction.getMnemonicString());
            result.addProperty("raw_disassembly", instruction.toString());
            RefType type = instruction.getFlowType();
            JsonObject listingFlow = new JsonObject();
            listingFlow.addProperty("source", "ghidra-listing-flow-type");
            listingFlow.addProperty("value", type.getName());
            flowEvidence.add(listingFlow);
            boolean decodedReturn = false;
            for (PcodeOp operation : instruction.getPcode()) {
                if (operation.getOpcode() != PcodeOp.RETURN) continue;
                decodedReturn = true;
                JsonObject returnEvidence = new JsonObject();
                returnEvidence.addProperty("source", "ghidra-instruction-pcode");
                returnEvidence.addProperty("value", operation.getMnemonic());
                flowEvidence.add(returnEvidence);
            }
            flow.addProperty("kind", type.isCall() ? "call" : type.isJump() ? "jump" : decodedReturn ? "return" : type.isTerminal() ? "terminal" : "fallthrough");
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
        flow.add("classification_evidence", flowEvidence);
        result.add("operands", operands);
        result.add("flow", flow);
        result.add("references", references);
        if (includeIncoming) {
            TreeMap<String, Reference> incoming = new TreeMap<>();
            visitObservedReferencesTo(address, reference -> addReference(incoming, reference));
            List<Reference> orderedIncoming = new ArrayList<>(incoming.values());
            orderedIncoming.sort(REFERENCE_ORDER);
            JsonArray incomingReferences = new JsonArray();
            for (Reference reference : orderedIncoming) incomingReferences.add(instructionReference(reference));
            result.add("incoming_references", incomingReferences);
        }
        List<String> limitations = new ArrayList<>(List.of("Operand components are Ghidra Listing decoder tokens; effective memory base/index/displacement roles and per-instruction context mode are unavailable. The mode field is the program language variant."));
        if (result.get("status").getAsString().equals("not-in-listing")) limitations.add("No listed instruction or defined data covers this in-memory address. REA did not attempt a decode; the memory may be uninitialized or contain valid instructions.");
        if (flow.get("kind").getAsString().equals("terminal")) limitations.add("No RETURN operation was observed in the provider's instruction p-code; terminal classification remains generic.");
        result.add("limitations", GSON.toJsonTree(limitations));
        return result;
    }

    private JsonObject resolveNativeCallTargets(JsonObject params) throws Exception {
        JsonObject instruction = inspectNativeInstruction(params, false);
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
        Set<Address> sources = new HashSet<>();
        visitObservedReferencesTo(address, reference -> sources.add(reference.getFromAddress()));
        List<Address> ordered = new ArrayList<>(sources);
        ordered.sort(Address::compareTo);
        JsonArray result = new JsonArray();
        for (Address source : ordered) {
            result.add(canonicalAddress(source));
        }
        return result;
    }

    // Renames and comments never mutate DefinedData string literals, so keep stringInventory intact.
    private void invalidateSymbolAndDecompilerCaches() {
        nameInventory = null;
        procedureInventory = null;
        procedureNameIndex = null;
        decompileResults.clear();
        disposeDecompileAhead();
        if (decompiler != null) decompiler.flushCache();
    }

    private JsonObject annotationReadback(Function function) {
        Address entry = function.getEntryPoint();
        JsonObject value = new JsonObject();
        value.addProperty("address", canonicalAddress(entry));
        value.addProperty("name", procedureName(function));
        value.addProperty("comment", currentProgram.getListing().getComment(CommentType.PRE, entry));
        value.addProperty("inline_comment", currentProgram.getListing().getComment(CommentType.EOL, entry));
        // The formal prototype omits storage-derived parameters. It reparses as a
        // signature edit when its function and type names are C identifiers.
        value.addProperty("signature", function.getSignature(true).getPrototypeString(false));
        value.addProperty("signature_source", normalizedSource(function.getSignatureSource()));
        value.addProperty("calling_convention", function.getCallingConventionName());
        return value;
    }

    private JsonObject annotateNativeFunction(JsonObject params) throws Exception {
        if (!Set.of("procedure", "name", "comment", "inline_comment", "signature", "signature_max_utf16",
                    "parenthesis_max_depth")
                .containsAll(params.keySet()))
            throw new RequestFailure("invalid_request", "Unknown function annotation field");
        if (!params.has("name") && !params.has("comment") && !params.has("inline_comment") && !params.has("signature"))
            throw new RequestFailure("invalid_request", "Supply at least one annotation change");
        Function function = resolveProcedure(requireString(params, "procedure"));
        Address entry = function.getEntryPoint();
        if (function.isExternal() || !currentProgram.getMemory().contains(entry))
            throw new RequestFailure("invalid_request", "Annotations require a local function entry: " + canonicalAddress(entry));
        for (String field : List.of("name", "comment", "inline_comment")) {
            if (params.has(field)) validateAnnotationText(requireText(params, field), field);
        }
        int signatureBound = callerCTextBound(
            params, "signature_max_utf16", DEFAULT_FUNCTION_SIGNATURE_UTF16, MAX_FUNCTION_SIGNATURE_UTF16);
        int parenthesisBound = callerParenthesisBound(params);
        int transaction = currentProgram.startTransaction("REA function annotations");
        boolean commit = false;
        try {
            // Ghidra's parser writes the database (see parseCallerC), so it runs inside this rollback.
            SignatureEdit signature = params.has("signature")
                ? parseFunctionSignature(function, requireText(params, "signature"), signatureBound, parenthesisBound)
                : null;
            FunctionDefinitionDataType prototype = signature == null ? null : signature.prototype();
            String leafName = params.has("name")
                ? symbolLeafName(function.getSymbol(), requireString(params, "name")) : null;
            // Validate edits through Ghidra's own setters, including name rules.
            // A later invalid name must roll back earlier comment writes.
            for (String field : List.of("comment", "inline_comment")) {
                if (params.has(field)) {
                    String text = requireText(params, field);
                    CommentType type = field.equals("comment") ? CommentType.PRE : CommentType.EOL;
                    currentProgram.getListing().setComment(entry, type, text.isEmpty() ? null : text);
                }
            }
            if (params.has("name"))
                function.setName(leafName, SourceType.USER_DEFINED);
            if (prototype != null) applyFunctionSignature(function, prototype);
            monitor.checkCancelled();
            invalidateSymbolAndDecompilerCaches();
            JsonObject readback = annotationReadback(function);
            for (String field : List.of("name", "comment", "inline_comment")) {
                if (!params.has(field)) continue;
                String requested = requireText(params, field);
                JsonElement measured = readback.get(field);
                String expected = field.equals("name") ? leafName : requested.isEmpty() ? null : requested;
                String observed = field.equals("name") ? function.getName() :
                    (measured.isJsonNull() ? null : measured.getAsString());
                if (!java.util.Objects.equals(expected, observed))
                    throw new RequestFailure("annotation_readback_mismatch", "Annotation readback differs for " + field + " at " + canonicalAddress(entry));
            }
            JsonObject query = new JsonObject();
            query.addProperty("procedure", canonicalAddress(entry));
            JsonObject result = new JsonObject();
            result.add("annotations", readback);
            result.add("dossier", analyzeFunction(query));
            if (signature != null && !signature.droppedQualifiers().isEmpty())
                result.add("dropped_qualifiers", signature.droppedQualifiers());
            JsonObject effects = new JsonObject();
            effects.addProperty("scope", "session-analysis-database");
            effects.addProperty("source_bytes_modified", false);
            effects.addProperty("persists_after_close", false);
            result.add("effects", effects);
            monitor.checkCancelled();
            commit = true;
            return result;
        }
        catch (ghidra.util.exception.InvalidInputException | ghidra.util.exception.DuplicateNameException exception) {
            throw new RequestFailure("invalid_function_name", "Invalid function name at " + canonicalAddress(entry) + ": " + safeMessage(exception));
        }
        finally {
            currentProgram.endTransaction(transaction, commit);
            // Rollback also invalidates inventory and decompiler views.
            invalidateSymbolAndDecompilerCaches();
        }
    }

    // Ghidra's C parser cannot be cancelled, so REA bounds the text it parses.
    // Measured on Ghidra 12.2 (arm64 macOS): the slowest shape per character is one
    // chain of pointer declarators, cubic in its length: 0.3 s at 2048 UTF-16 units,
    // 0.8 s at 4096, 6.8 s at 8192 and 100 s at 16384. The per-call length controls
    // (signature_max_utf16, declarations_max_utf16) stop at those maxima, keeping
    // the slowest admitted text under about 7 s; the TypeScript contract owns the
    // same defaults and ranges. Each level of nested parentheses in an expression
    // doubles parse time and the cost repeats per occurrence (8192 units filled at
    // depth 8 take 0.2 s, at depth 12 2.2 s), so parenthesis_max_depth stops at 12.
    private static final int MIN_C_TEXT_UTF16 = 16;
    private static final int DEFAULT_FUNCTION_SIGNATURE_UTF16 = 2048;
    private static final int MAX_FUNCTION_SIGNATURE_UTF16 = 4096;
    private static final int DEFAULT_TYPE_DECLARATIONS_UTF16 = 4096;
    private static final int MAX_TYPE_DECLARATIONS_UTF16 = 8192;
    private static final int MIN_C_PARENTHESIS_DEPTH = 1;
    private static final int DEFAULT_C_PARENTHESIS_DEPTH = 8;
    private static final int MAX_C_PARENTHESIS_DEPTH = 12;
    /** Accepted caller C and the qualifiers Ghidra's types cannot record. */
    private record ParsedCallerC(CParser parser, JsonArray droppedQualifiers) {}
    // Data types carry no SourceType; this category is the persisted mark of caller authorship.
    private static final CategoryPath CALLER_DEFINED_TYPES = new CategoryPath("/rea_caller_defined");
    /** A token Ghidra's C parser consumes without applying, and what REA does with it. */
    private record UnappliedCToken(Pattern spelling, String construct, String droppedQualifier) {
        boolean refused() { return droppedQualifier == null; }
    }

    private static UnappliedCToken refusedC(String spelling, String construct) {
        return new UnappliedCToken(Pattern.compile(spelling), construct, null);
    }

    private static UnappliedCToken droppedC(String spelling, String qualifier) {
        return new UnappliedCToken(Pattern.compile(spelling), null, qualifier);
    }

    /**
     * Every token Ghidra 12.2's C.jj grammar accepts and then ignores, in that
     * grammar's own spellings (its token regular expressions). REA refuses a
     * token whose meaning would be lost, such as a pointer width, an attribute
     * or a storage class, and reports a pure qualifier that changes neither
     * layout nor storage as dropped. Every other C.jj keyword is applied: base
     * types (including __int8..__int64, _Bool and _*signed), struct, union,
     * enum and typedef, calling conventions, _Noreturn, _Alignof and sizeof.
     * Types the parser invents for an undefined name are a parse result, not a
     * token; requireNoInventedTypes refuses those.
     */
    private static final List<UnappliedCToken> UNAPPLIED_C_TOKENS = List.of(
        // TypeQualifier: consumed without a Ghidra representation.
        droppedC("_*const", "const"),
        droppedC("_*volatile_*", "volatile"),
        droppedC("_+restrict", "restrict"),
        droppedC("__unaligned", "__unaligned"),
        droppedC("__w64", "__w64"),
        refusedC("__ptr32|__ptr64", "the pointer-width qualifier %s (Ghidra stores a native-width pointer)"),
        refusedC("__near|__far", "the pointer qualifier %s (Ghidra ignores it)"),
        // AttributeSpec, DeclSpec and AlignmentSpecifier: parsed and discarded.
        refusedC("__attribute_*|__declspec|__readableTo|_Alignas|alignas|__packed|__packed__|packed|_*asm_*|_+extension_*",
            "the attribute or extension %s"),
        refusedC("\\[\\[", "a [[...]] attribute"),
        // StorageClassSpecifier and function specifiers: no storage or linkage in a type.
        refusedC("static|extern|register|auto|_Thread_local|thread_local|_*(?:inline|forceinline)_*", "the specifier %s"),
        // Pragma operators, assertions and lexer states whose text is skipped.
        // Ghidra applies a pack through the operator but skips any other pragma; REA admits one spelling.
        refusedC("__pragma|_Pragma", "the pragma operator %s (write #pragma pack instead)"),
        refusedC("_Static_assert|static_assert", "the static assertion %s (Ghidra does not store it)"),
        refusedC("@", "an Objective-C @ directive (Ghidra skips its text)"),
        refusedC("\\\\", "a backslash (Ghidra's parser skips it)"));

    private static UnappliedCToken unappliedC(String token) {
        for (UnappliedCToken rule : UNAPPLIED_C_TOKENS)
            if (rule.spelling().matcher(token).matches()) return rule;
        return null;
    }

    private static boolean isCallerDefinedType(DataType type) {
        CategoryPath category = type.getCategoryPath();
        return category != null && category.isAncestorOrSelf(CALLER_DEFINED_TYPES);
    }

    private static RequestFailure refusedConstruct(String code, String field, String construct, int line, int column) {
        return new RequestFailure(code, field + " contains " + construct + " at line " + line + ", column " + column +
            "; Ghidra's C parser would not apply it as written, so nothing was changed");
    }

    /** One token of caller C text and where it starts in the caller's own lines. */
    private record CToken(String text, int line, int column) {
        boolean is(String expected) { return text.equals(expected); }
        boolean isIdentifier() { return isCIdentifierStart(text.charAt(0)); }
    }

    // C.jj's LETTER: identifiers may hold $, as in its IDENTIFIER token.
    private static boolean isCIdentifierStart(char character) {
        return Character.isLetter(character) || character == '_' || character == '$';
    }

    /**
     * The one reader of caller C text. Tokens are identifiers, numbers or
     * single characters; comments, and the byte-order mark C.jj skips, read as
     * whitespace. CR, LF and CRLF each
     * end one line, as in Ghidra's own C parser, so positions name the
     * caller's text. A string or character literal is refused here, so no
     * later check can mistake its contents for code.
     */
    private static final class CTokenizer {
        private final String text;
        private final String field;
        private final String code;
        private int index;
        private int line = 1;
        private int lineStart;
        /** The text ends inside a line comment, which would swallow anything appended on its line. */
        private boolean endsInLineComment;

        CTokenizer(String text, String field, String code) {
            this.text = text;
            this.field = field;
            this.code = code;
        }

        private static boolean isLineBreak(char character) {
            return character == '\n' || character == '\r';
        }

        /** Step over one UTF-16 unit, or one CRLF pair, counting line breaks. */
        private void advance() {
            char character = text.charAt(index++);
            if (character == '\r' && index < text.length() && text.charAt(index) == '\n') index++;
            if (isLineBreak(character)) {
                line++;
                lineStart = index;
            }
        }

        /**
         * Skip whitespace and comments up to the next token. Returns false at
         * the end of the text or, within a directive (lineEnds), at a line
         * break; a block comment that crosses one there is refused, since it
         * would carry the directive onto another line.
         */
        private boolean skipToToken(boolean lineEnds) {
            while (index < text.length()) {
                char character = text.charAt(index);
                int startLine = line, column = index - lineStart + 1;
                if (lineEnds && isLineBreak(character)) return false;
                if (Character.isWhitespace(character) || character == '\ufeff') {
                    advance();
                    continue;
                }
                if (text.startsWith("//", index)) {
                    while (index < text.length() && !isLineBreak(text.charAt(index))) index++;
                    endsInLineComment = index == text.length();
                    continue;
                }
                if (text.startsWith("/*", index)) {
                    int close = text.indexOf("*/", index + 2);
                    int stop = close < 0 ? text.length() : close + 2;
                    while (index < stop) advance();
                    if (lineEnds && line != startLine)
                        throw refusedConstruct(code, field,
                            "a block comment that continues a directive onto another line", startLine, column);
                    continue;
                }
                return true;
            }
            return false;
        }

        /**
         * The next token, or null at the end of the text or a directive's line.
         * Iterative throughout: caller text cannot deepen the stack.
         */
        CToken next(boolean lineEnds) {
            if (!skipToToken(lineEnds)) return null;
            char character = text.charAt(index);
            int tokenLine = line, column = index - lineStart + 1;
            if (character == '"' || character == '\'')
                throw refusedConstruct(code, field, "a string or character literal", tokenLine, column);
            int stop = index + 1;
            if (isCIdentifierStart(character) || Character.isDigit(character))
                while (stop < text.length() &&
                        (isCIdentifierStart(text.charAt(stop)) || Character.isDigit(text.charAt(stop)))) stop++;
            String token = text.substring(index, stop);
            index = stop;
            // C.jj reads "[" "[" as an attribute, with anything skippable between.
            if (token.equals("[")) {
                int savedIndex = index, savedLine = line, savedLineStart = lineStart;
                boolean savedEnds = endsInLineComment;
                if (skipToToken(lineEnds) && text.charAt(index) == '[') {
                    index++;
                    return new CToken("[[", tokenLine, column);
                }
                index = savedIndex;
                line = savedLine;
                lineStart = savedLineStart;
                endsInLineComment = savedEnds;
            }
            return new CToken(token, tokenLine, column);
        }
    }

    /** What the tokenizer observed in admitted caller C. */
    private record AdmittedCallerC(JsonArray droppedQualifiers, boolean terminated, boolean endsInLineComment) {}

    // Ghidra reads a pack value with Integer.parseInt and, on overflow, keeps the
    // packing already in effect. A decimal literal is admitted only when that parse accepts it.
    private static final Pattern PACK_VALUE = Pattern.compile("0|[1-9][0-9]*");

    private static boolean ghidraPackDecimal(String text) {
        if (!PACK_VALUE.matcher(text).matches()) return false;
        try {
            Integer.parseInt(text);
            return true;
        } catch (NumberFormatException overflow) {
            return false;
        }
    }

    /**
     * Whether Ghidra 12.2's PragmaSpecifier applies these #pragma pack operands
     * as C does, tracking the labels pushed so far. It ignores a bare (push),
     * so its pop would restore nothing; a pop with nothing pushed keeps the
     * current packing; and a plain pop keeps popping past labelled entries
     * until it finds an unlabelled one. Admitted: (), (n), (push, n),
     * (push, id), (push, id, n), (pop) over an unlabelled push and
     * (pop, id) over a push of id.
     */
    private static boolean appliedPackOperands(List<CToken> operands, ArrayDeque<String> labels) {
        List<String> texts = operands.stream().map(CToken::text).toList();
        java.util.function.Predicate<String> value = ReaGhidraBridge::ghidraPackDecimal;
        java.util.function.Predicate<String> label = text -> isCIdentifierStart(text.charAt(0)) &&
            !text.equals("push") && !text.equals("pop");
        boolean push = !texts.isEmpty() && texts.get(0).equals("push");
        boolean pop = !texts.isEmpty() && texts.get(0).equals("pop");
        switch (texts.size()) {
            case 0:
                return true;
            case 1:
                if (value.test(texts.get(0))) return true;
                if (!pop || !"".equals(labels.peek())) return false;
                labels.pop();
                return true;
            case 3:
                if (!texts.get(1).equals(",")) return false;
                if (push && (value.test(texts.get(2)) || label.test(texts.get(2)))) {
                    labels.push(value.test(texts.get(2)) ? "" : texts.get(2));
                    return true;
                }
                if (!pop || !label.test(texts.get(2)) || !labels.contains(texts.get(2))) return false;
                while (!labels.pop().equals(texts.get(2))) { }
                return true;
            case 5:
                if (!push || !texts.get(1).equals(",") || !label.test(texts.get(2)) ||
                        !texts.get(3).equals(",") || !value.test(texts.get(4))) return false;
                labels.push(texts.get(2));
                return true;
            default:
                return false;
        }
    }

    /**
     * Admit one directive from the tokens after its #. Only a declarations
     * text's #pragma pack in a form Ghidra applies is admitted. C.jj reads
     * "#pragma" as one token and "#" followed by a space as a line marker
     * whose text it skips, so the name must follow # directly.
     */
    private static void admitCallerCDirective(
            CTokenizer tokens, CToken hash, String field, boolean declarations, String code, ArrayDeque<String> packLabels) {
        CToken first = tokens.next(true);
        String name = first == null ? "" : first.text();
        boolean adjacent = first != null && first.line() == hash.line() && first.column() == hash.column() + 1;
        // Any other directive is refused by its name, before its operands are read.
        List<CToken> directive = new ArrayList<>();
        if (declarations && adjacent && name.equals("pragma"))
            for (CToken token = tokens.next(true); token != null; token = tokens.next(true)) directive.add(token);
        boolean pack = directive.size() >= 3 && directive.get(0).is("pack") && directive.get(1).is("(") &&
            directive.get(directive.size() - 1).is(")") &&
            appliedPackOperands(directive.subList(2, directive.size() - 1), packLabels);
        if (!adjacent && first != null)
            throw refusedConstruct(code, field, "# separated from its directive name (Ghidra reads it as a line marker)",
                hash.line(), hash.column());
        if (!pack && !directive.isEmpty() && directive.get(0).is("pack"))
            throw refusedConstruct(code, field, "#pragma pack with operands Ghidra ignores or reads differently " +
                "(it applies (), (n), (push, n), (push, id), (push, id, n) with a decimal n from 0 through 2147483647, (pop) over an unlabelled push and (pop, id) over a push of id)",
                hash.line(), hash.column());
        if (!pack)
            throw refusedConstruct(code, field, "the directive #" + name +
                (name.equals("pragma") ? " (only #pragma pack is applied)" : ""), hash.line(), hash.column());
    }

    // One decimal or hex integer literal with no suffix, read the same way by C and by Ghidra.
    private static final Pattern C_PLAIN_INTEGER = Pattern.compile("0|[1-9][0-9]*|0[xX][0-9a-fA-F]+");

    /**
     * The value of one constant expression (an enum value, array size or
     * bit-field width), admitted only as a single decimal or hex integer
     * literal within int, optionally negated. Ghidra 12.2 evaluates C constant
     * expressions with its own rules: names, casts and sizeof stay unevaluated
     * and default, values outside int are truncated, and comparisons and
     * unsigned arithmetic differ from C (~0U >> 1 is -1). Emulating C against
     * that evaluator is an open-ended set of mismatches, so anything but one
     * literal is refused at its position and the caller writes the value.
     */
    /** Admit the next token of a constant expression as it is read, so a refusal names the first token that leaves the form. */
    private static void admitConstantToken(List<CToken> expression, CToken token, String field, String code) {
        boolean admitted = expression.isEmpty()
            ? token.is("-") || C_PLAIN_INTEGER.matcher(token.text()).matches()
            : expression.size() == 1 && expression.get(0).is("-") && C_PLAIN_INTEGER.matcher(token.text()).matches();
        if (!admitted)
            throw refusedConstruct(code, field, "the constant expression token " + token.text() +
                " (Ghidra evaluates C constant expressions differently from C; write the computed value as one " +
                "decimal or hex integer literal, optionally negated, without suffixes)", token.line(), token.column());
    }

    /** The value of an admitted constant expression; a value outside int, which Ghidra would truncate, is refused. */
    private static long admitConstantExpression(List<CToken> tokens, String field, String code) {
        CToken literal = tokens.get(tokens.size() - 1);
        if (literal.is("-"))
            throw refusedConstruct(code, field, "a lone - as a constant expression", literal.line(), literal.column());
        boolean negative = tokens.size() == 2;
        String digits = literal.text();
        java.math.BigInteger value = digits.startsWith("0x") || digits.startsWith("0X")
            ? new java.math.BigInteger(digits.substring(2), 16) : new java.math.BigInteger(digits);
        if (negative) value = value.negate();
        if (value.compareTo(java.math.BigInteger.valueOf(Integer.MIN_VALUE)) < 0 ||
                value.compareTo(java.math.BigInteger.valueOf(Integer.MAX_VALUE)) > 0)
            throw refusedConstruct(code, field, "the literal " + (negative ? "-" : "") + digits +
                ", outside int (Ghidra truncates it; write a value within int)", literal.line(), literal.column());
        return value.longValue();
    }

    /**
     * Tokenize caller C once, before the parser sees it: bound parenthesis
     * nesting and refuse every construct Ghidra's parser accepts and drops.
     * A declarations text may hold only struct, union, enum and typedef
     * definitions and #pragma pack; a signature holds one prototype.
     */
    private static AdmittedCallerC admitCallerC(
            String text, String field, boolean declarations, String code, int maxParenthesisDepth) {
        final int start = 0, tag = 1, named = 2, body = 3, afterBody = 4, typedef = 5;
        int state = start;
        int parentheses = 0, braces = 0;
        // The deepest nesting in the whole text, so a refusal reports the depth to admit.
        int deepest = 0, beyondLine = 0, beyondColumn = 0;
        // A signature's parameter index: -1 before its parameter list opens, the return type.
        int parameter = -1;
        boolean parametersClosed = false;
        JsonArray dropped = new JsonArray();
        String previous = "";
        String definition = "";
        boolean ended = false;
        CTokenizer tokens = new CTokenizer(text, field, code);
        // Labels of the #pragma pack pushes admitted so far, innermost first.
        ArrayDeque<String> packLabels = new ArrayDeque<>();
        // Declarations: whether each open brace is an enum body, the constant
        // expression being read, and the next implicit enumerator value.
        ArrayDeque<Boolean> enumBodies = new ArrayDeque<>();
        boolean enumPending = false;
        List<CToken> expression = null;
        Set<String> expressionEnds = Set.of();
        boolean enumExpression = false;
        Long explicitEnumValue = null;
        CToken enumerator = null;
        long nextEnumValue = 0;
        for (CToken next = tokens.next(false); next != null; next = tokens.next(false)) {
            String token = next.text();
            int line = next.line(), column = next.column();
            if (next.is("#")) {
                admitCallerCDirective(tokens, next, field, declarations, code, packLabels);
                continue;
            }
            if (!declarations && token.equals("typedef"))
                throw refusedConstruct(code, field, "the specifier typedef", line, column);
            UnappliedCToken unapplied = unappliedC(token);
            if (unapplied != null && unapplied.refused())
                throw refusedConstruct(code, field, String.format(unapplied.construct(), token) +
                    (declarations && unapplied.construct().startsWith("the attribute") ? " (use #pragma pack for packing)" : ""),
                    line, column);
            if (unapplied != null) {
                JsonObject qualifier = new JsonObject();
                qualifier.addProperty("qualifier", unapplied.droppedQualifier());
                qualifier.addProperty("line", line);
                qualifier.addProperty("column", column);
                if (!declarations)
                    qualifier.add("parameter_index", parameter < 0 || parametersClosed
                        ? JsonNull.INSTANCE : GSON.toJsonTree(parameter));
                dropped.add(qualifier);
            }
            if (ended && !token.equals(";"))
                throw refusedConstruct(code, field, "a second declaration", line, column);
            if (next.is("(") && ++parentheses > deepest) {
                deepest = parentheses;
                if (deepest == maxParenthesisDepth + 1) {
                    beyondLine = line;
                    beyondColumn = column;
                }
            }
            if (!declarations && parentheses == 1 && !parametersClosed) {
                if (token.equals("(") && parameter < 0) parameter = 0;
                else if (token.equals(",")) parameter++;
            }
            if (token.equals(")")) {
                if (!declarations && parentheses == 1 && parameter >= 0) parametersClosed = true;
                parentheses = Math.max(0, parentheses - 1);
            }
            if (previous.equals("enum") && token.equals("{"))
                throw refusedConstruct(code, field, "an unnamed enum, which Ghidra would store under a generated name", line, column);
            if (!declarations) {
                if (token.equals("{"))
                    throw refusedConstruct(code, field, "a function body", line, column);
                if (token.equals("="))
                    throw refusedConstruct(code, field, "a default argument or initializer", line, column);
                if (previous.equals("(") && token.equals("*"))
                    throw refusedConstruct(code, field, "a function-pointer declarator", line, column);
                if (token.equals(";")) ended = true;
                previous = token;
                continue;
            }
            boolean top = braces == 0 && parentheses == 0;
            // Enum values, array sizes and bit-field widths are constant expressions
            // Ghidra evaluates itself; admitConstantExpression owns which ones it gets right.
            if (expression != null) {
                if (!expressionEnds.contains(token)) {
                    admitConstantToken(expression, next, field, code);
                    expression.add(next);
                } else {
                    Long value = expression.isEmpty() ? null : admitConstantExpression(expression, field, code);
                    if (enumExpression) explicitEnumValue = value;
                    expression = null;
                }
            } else if (token.equals("(")) {
                // Ghidra applies no parenthesis in a definition as written: function
                // declarators, attributes, casts, sizeof and grouped declarators are
                // each refused or reported by its parser, so refuse the first one here.
                throw refusedConstruct(code, field, "a parenthesis (a struct, union, enum or typedef definition " +
                    "admits none: Ghidra does not store function declarators, attributes or grouped declarators as written)",
                    line, column);
            } else if (token.equals("[") || (token.equals("=") && Boolean.TRUE.equals(enumBodies.peek())) ||
                    (token.equals(":") && Boolean.FALSE.equals(enumBodies.peek()) && !enumPending)) {
                expression = new ArrayList<>();
                enumExpression = token.equals("=");
                expressionEnds = token.equals("[") ? Set.of("]") : enumExpression ? Set.of(",", "}") : Set.of(";", ",");
            }
            boolean inEnum = Boolean.TRUE.equals(enumBodies.peek());
            if (inEnum && expression == null && next.isIdentifier() && (previous.equals("{") || previous.equals(",")))
                enumerator = next;
            // Ghidra numbers an enumerator without a value one past the previous, in int.
            if (inEnum && expression == null && enumerator != null && (token.equals(",") || token.equals("}"))) {
                long value = explicitEnumValue != null ? explicitEnumValue : nextEnumValue;
                if (value > Integer.MAX_VALUE)
                    throw refusedConstruct(code, field, "the enumerator " + enumerator.text() +
                        ", whose implicit value leaves int (Ghidra truncates it)", enumerator.line(), enumerator.column());
                nextEnumValue = value + 1;
                explicitEnumValue = null;
                enumerator = null;
            }
            if (token.equals("enum")) enumPending = true;
            if (token.equals(";")) enumPending = false;
            if (token.equals("{")) {
                enumBodies.push(enumPending);
                if (enumPending) nextEnumValue = 0;
                enumPending = false;
            }
            if (token.equals("}") && !enumBodies.isEmpty()) enumBodies.pop();
            if (token.equals("{")) braces++;
            if (token.equals("}")) braces = Math.max(0, braces - 1);
            switch (state) {
                case start -> {
                    if (token.equals("typedef")) state = typedef;
                    else if (token.equals("struct") || token.equals("union") || token.equals("enum")) state = tag;
                    else if (!token.equals(";"))
                        throw refusedConstruct(code, field,
                            "a declaration that is not a struct, union, enum or typedef definition (" + token + ")", line, column);
                }
                case tag -> {
                    if (!next.isIdentifier())
                        throw refusedConstruct(code, field, "an unnamed struct or union definition", line, column);
                    definition = token;
                    state = named;
                }
                case named -> {
                    if (token.equals("{")) state = body;
                    else if (token.equals(";")) state = start;
                    else throw refusedConstruct(code, field, "a variable declaration (" + token + ")", line, column);
                }
                case body -> {
                    if (braces == 0) state = afterBody;
                }
                case afterBody -> {
                    if (!token.equals(";"))
                        throw refusedConstruct(code, field,
                            "a variable or declarator (" + token + ") after the definition of " + definition, line, column);
                    state = start;
                }
                default -> {
                    if (top && token.equals(";")) state = start;
                    if (top && token.equals("="))
                        throw refusedConstruct(code, field, "an initializer", line, column);
                }
            }
            previous = token;
        }
        // Measured over the whole text, so the refusal names the depth that admits it.
        if (deepest > maxParenthesisDepth)
            throw new RequestFailure("parenthesis_depth_limit", field + " nests parentheses " + deepest +
                " levels deep, first beyond " + maxParenthesisDepth + " at line " + beyondLine + ", column " + beyondColumn,
                null, deepest);
        return new AdmittedCallerC(dropped, ended, tokens.endsInLineComment);
    }

    /**
     * Ghidra 12.2 stores, names and compares a data type recursively through
     * its pointer, array, typedef and member chain. Measured on Ghidra 12.2
     * (macOS arm64): 1024 levels resolve, 2048 exhaust the stack inside
     * addDataType while its database lock is held, which leaves that lock held
     * and the Program unusable. REA refuses a type deeper than this, a
     * quarter of the last measured safe depth, before Ghidra walks it.
     */
    private static final int MAX_C_TYPE_DEPTH = 256;

    /**
     * Refuse a parsed type whose longest pointer, array, typedef, bit-field
     * or member chain, including chains through existing database types,
     * exceeds MAX_C_TYPE_DEPTH. Iterative with memoized depths; a chain back
     * into a type still being walked (a self-referential pointer) adds no
     * depth, because Ghidra resolves that reference without recursing.
     */
    private static void requireBoundedTypeDepth(DataType root, String name, String field) {
        Map<DataType, Integer> depths = new IdentityHashMap<>();
        Set<DataType> open = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
        ArrayDeque<DataType> stack = new ArrayDeque<>();
        stack.push(root);
        while (!stack.isEmpty()) {
            DataType type = stack.peek();
            if (depths.containsKey(type)) {
                stack.pop();
                continue;
            }
            List<DataType> children = cTypeChildren(type);
            boolean ready = true;
            if (open.add(type)) {
                for (DataType child : children)
                    if (child != null && !depths.containsKey(child) && !open.contains(child)) {
                        stack.push(child);
                        ready = false;
                    }
                if (!ready) continue;
            }
            int depth = 1;
            for (DataType child : children)
                if (child != null && depths.containsKey(child)) depth = Math.max(depth, depths.get(child) + 1);
            depths.put(type, depth);
            open.remove(type);
            stack.pop();
        }
        // The whole chain is measured, so the reported depth is the one compared with the limit.
        int depth = depths.get(root);
        if (depth > MAX_C_TYPE_DEPTH)
            throw new RequestFailure("type_depth_limit", field + " defines " + name + ", chained " + depth +
                " levels deep through pointers, arrays, typedefs, members or existing database types");
    }

    private static List<DataType> cTypeChildren(DataType type) {
        if (type instanceof ghidra.program.model.data.Pointer pointer) return java.util.Collections.singletonList(pointer.getDataType());
        if (type instanceof ghidra.program.model.data.Array array) return List.of(array.getDataType());
        if (type instanceof ghidra.program.model.data.BitFieldDataType bitField) return List.of(bitField.getBaseDataType());
        if (type instanceof ghidra.program.model.data.TypeDef alias) return List.of(alias.getDataType());
        if (type instanceof ghidra.program.model.data.FunctionDefinition function) {
            List<DataType> children = new ArrayList<>();
            children.add(function.getReturnType());
            for (ghidra.program.model.data.ParameterDefinition argument : function.getArguments())
                children.add(argument.getDataType());
            return children;
        }
        if (type instanceof ghidra.program.model.data.Composite composite) {
            List<DataType> children = new ArrayList<>();
            for (ghidra.program.model.data.DataTypeComponent component : composite.getComponents())
                children.add(component.getDataType());
            return children;
        }
        return List.of();
    }

    /** The caller's per-call bound, or its default; the contract owns the range. */
    private static int callerBound(JsonObject params, String name, int minimum, int defaultValue, int maximum) {
        if (!params.has(name)) return defaultValue;
        int bound = requireInteger(params, name);
        if (bound < minimum || bound > maximum)
            throw new RequestFailure("invalid_request", name + " must be from " + minimum + " to " + maximum);
        return bound;
    }

    private static int callerCTextBound(JsonObject params, String name, int defaultValue, int maximum) {
        return callerBound(params, name, MIN_C_TEXT_UTF16, defaultValue, maximum);
    }

    private static int callerParenthesisBound(JsonObject params) {
        return callerBound(params, "parenthesis_max_depth",
            MIN_C_PARENTHESIS_DEPTH, DEFAULT_C_PARENTHESIS_DEPTH, MAX_C_PARENTHESIS_DEPTH);
    }

    /**
     * Parse caller C text against the type database. Even with storeDataType
     * false, Ghidra's parser writes the database: a definition whose name
     * matches an existing empty composite fills that type in place, in the
     * parser's own nested transaction. The caller's open transaction is
     * therefore the only rollback for a refused or failed edit.
     */
    private ParsedCallerC parseCallerC(
            String text, String field, boolean declarations, String code, int maximum, int maxParenthesisDepth) {
        if (currentProgram.getCurrentTransactionInfo() == null)
            throw new IllegalStateException("Caller C must be parsed inside the edit's transaction");
        validateAnnotationText(text, field);
        if (text.length() > maximum)
            throw new RequestFailure(declarations ? "declarations_length_limit" : "signature_length_limit",
                field + " has " + text.length() + " UTF-16 code units", null, text.length());
        AdmittedCallerC admitted = admitCallerC(text, field, declarations, code, maxParenthesisDepth);
        DataTypeManager types = currentProgram.getDataTypeManager();
        CParser parser = new CParser(types, false, new DataTypeManager[] { types });
        try {
            // The parser needs a terminated prototype, and its // skip token
            // requires a line break. Nothing precedes the caller's text, so the
            // parser's positions name the caller's own lines. A line comment at
            // the end gets a newline first, so a semicolon added for an
            // unterminated prototype is not swallowed.
            String source = admitted.endsInLineComment() ? text + "\n" : text;
            parser.parse(declarations || admitted.terminated() ? source : source + ";");
        }
        catch (ghidra.app.util.cparser.C.ParseException | ghidra.app.util.cparser.C.TokenMgrError rejected) {
            throw new RequestFailure(code, "Ghidra's C parser rejected " + field + ": " + cParserReason(rejected.getMessage()));
        }
        if (!parser.didParseSucceed())
            throw new RequestFailure(code, "Ghidra's C parser rejected " + field + ": " + cParserReason(parser.getParseMessages()));
        // The parser records what it could not apply, such as a repeated
        // enumerator it drops, and still reports success.
        String diagnostics = cParserDiagnostics(parser.getParseMessages());
        if (!diagnostics.isEmpty())
            throw new RequestFailure(code, "Ghidra's C parser reported " + field + ": " + diagnostics +
                "; it would not apply the text as written, so nothing was changed");
        // Before anything walks the parsed types recursively (naming, comparing, storing).
        for (Map<String, DataType> parsedTypes : List.of(
                parser.getComposites(), parser.getEnums(), parser.getTypes(), parser.getFunctions()))
            for (Map.Entry<String, DataType> parsedType : parsedTypes.entrySet())
                requireBoundedTypeDepth(parsedType.getValue(), parsedType.getKey(), field);
        return new ParsedCallerC(parser, admitted.droppedQualifiers());
    }

    /**
     * The parser picks one type for a name. When the database holds another,
     * different type under the same name, the caller cannot select between them.
     */
    private void requireUnambiguousType(DataType type) {
        DataType named = type;
        while (named instanceof ghidra.program.model.data.Pointer || named instanceof ghidra.program.model.data.Array)
            named = named instanceof ghidra.program.model.data.Pointer pointer
                ? pointer.getDataType() : ((ghidra.program.model.data.Array) named).getDataType();
        if (named == null || named instanceof ghidra.program.model.data.BuiltInDataType) return;
        List<DataType> sameName = new ArrayList<>();
        currentProgram.getDataTypeManager().findDataTypes(named.getName(), sameName);
        Set<String> candidates = new TreeSet<>();
        for (DataType other : sameName)
            if (!other.getPathName().equals(named.getPathName()) && !other.isEquivalent(named))
                candidates.add(other.getPathName());
        if (candidates.isEmpty()) return;
        candidates.add(named.getPathName());
        throw new RequestFailure("ambiguous_data_type", "The type name " + named.getName() +
            " names different types in the database: " + String.join(", ", candidates));
    }


    /** Keep the location and offending token; drop the generated expected-token list. */
    /**
     * Ghidra's own diagnostic lines. Without a header file the parser has no
     * position to give; it names the nearest type when it has one.
     */
    private static String cParserDiagnostics(String messages) {
        if (messages == null) return "";
        List<String> lines = new ArrayList<>();
        for (String line : messages.split("\\R")) {
            String stripped = line.strip();
            if (stripped.isEmpty() || stripped.startsWith("In file ") ||
                    stripped.equals("Near datatype: undefined") || stripped.equals("Near datatype: - none -")) continue;
            lines.add(stripped);
        }
        return lines.isEmpty() ? "" : cParserReason(String.join("; ", lines));
    }

    private static String cParserReason(String message) {
        if (message == null || message.isBlank()) return "no reason reported";
        int expected = message.indexOf("Was expecting");
        String reason = WHITESPACE_RUN.matcher(expected < 0 ? message : message.substring(0, expected)).replaceAll(" ").strip();
        return reason.length() > 240 ? reason.substring(0, 240) : reason;
    }

    /** A parsed prototype and the qualifiers in its text that Ghidra does not record. */
    private record SignatureEdit(FunctionDefinitionDataType prototype, JsonArray droppedQualifiers) {}

    private SignatureEdit parseFunctionSignature(Function function, String text, int maximum, int maxParenthesisDepth) {
        String code = "invalid_function_signature";
        String entry = canonicalAddress(function.getEntryPoint());
        // Ghidra redirects a thunk's prototype to the thunked function, which may be external.
        if (function.isThunk())
            throw new RequestFailure(code, "Function at " + entry + " is a thunk; its prototype belongs to the function it forwards to");
        ParsedCallerC parsed = parseCallerC(text, "signature", false, code, maximum, maxParenthesisDepth);
        CParser parser = parsed.parser();
        // The parser invents an empty composite or enum for an undefined tag, and a
        // prototype defines no types, so every type it reports was invented.
        Set<String> undefined = new TreeSet<>(parser.getComposites().keySet());
        undefined.addAll(parser.getEnums().keySet());
        undefined.addAll(parser.getTypes().keySet());
        if (!undefined.isEmpty())
            throw new RequestFailure("unknown_data_type", "signature uses types the database does not define: " +
                String.join(", ", undefined));
        Map<String, DataType> functions = parser.getFunctions();
        if (functions.size() != 1 ||
            !(functions.values().iterator().next() instanceof FunctionDefinitionDataType prototype))
            throw new RequestFailure(code, "signature must be one C function prototype without function-pointer parameters; found " +
                functions.size() + " function declarators");
        Set<String> names = new HashSet<>();
        for (ParameterDefinition parameter : prototype.getArguments()) {
            String name = parameter.getName();
            if (name != null && !name.isEmpty() && !names.add(name))
                throw new RequestFailure(code, "signature repeats parameter name " + name);
            requireUnambiguousType(parameter.getDataType());
        }
        requireUnambiguousType(prototype.getReturnType());
        return new SignatureEdit(prototype, parsed.droppedQualifiers());
    }

    private void applyFunctionSignature(Function function, FunctionDefinitionDataType prototype) throws Exception {
        String code = "invalid_function_signature";
        String entry = canonicalAddress(function.getEntryPoint());
        // Ghidra assigns the locked parameter storage with the compiler specification's
        // default convention when the function has none. Recording that convention keeps
        // the decompiler from reporting locked storage under an unknown convention.
        if (function.getCallingConvention() == null && prototype.hasUnknownCallingConventionName())
            prototype.setCallingConvention(currentProgram.getCompilerSpec().getDefaultCallingConvention().getName());
        // The prototype's own name is never applied; the name field owns renames.
        ApplyFunctionSignatureCmd command = new ApplyFunctionSignatureCmd(
            function.getEntryPoint(), prototype, SourceType.USER_DEFINED, false, false,
            DataTypeConflictHandler.DEFAULT_HANDLER, FunctionRenameOption.NO_CHANGE);
        if (!command.applyTo(currentProgram, monitor))
            throw new RequestFailure(code, "Ghidra refused the signature at " + entry + ": " +
                (command.getStatusMsg() == null ? "no reason reported" : command.getStatusMsg()));
        FunctionSignature applied = function.getSignature(true);
        ParameterDefinition[] requested = prototype.getArguments();
        ParameterDefinition[] observed = applied.getArguments();
        boolean matches = function.getSignatureSource() == SourceType.USER_DEFINED &&
            applied.getReturnType().isEquivalent(prototype.getReturnType()) &&
            applied.hasVarArgs() == prototype.hasVarArgs() &&
            (!prototype.hasNoReturn() || function.hasNoReturn()) &&
            observed.length == requested.length &&
            (prototype.hasUnknownCallingConventionName() ||
                prototype.getCallingConventionName().equals(function.getCallingConventionName()));
        for (int index = 0; matches && index < requested.length; index++) {
            String name = requested[index].getName();
            matches = observed[index].getDataType().isEquivalent(requested[index].getDataType()) &&
                (name == null || name.isEmpty() || name.equals(observed[index].getName()));
        }
        // Ghidra settles array parameters, renames parameters that collide with
        // other symbols and ignores conventions the compiler specification lacks.
        if (!matches)
            throw new RequestFailure(code, "Ghidra applied a different prototype at " + entry + " than requested: " +
                applied.getPrototypeString(false) + "; requested " + prototype.getPrototypeString(false));
    }

    /**
     * Ghidra keeps typedefs, enum tags and struct or union tags in separate
     * maps and stores one type per name. A typedef of its own struct or enum
     * (`typedef struct s { ... } s`) is that tag, recorded once. Overlapping
     * names stay one stored type only when the definitions are equivalent;
     * any other overlap is refused so the call stores every definition or none.
     */
    private static Map<String, DataType> mergeCallerTypeMaps(
            Map<String, DataType> typedefs,
            Map<String, DataType> enumerations,
            Map<String, DataType> composites) {
        Map<String, DataType> defined = new TreeMap<>();
        Set<String> collisions = new TreeSet<>();
        absorbCallerTypes(defined, collisions, typedefs);
        absorbCallerTypes(defined, collisions, enumerations);
        absorbCallerTypes(defined, collisions, composites);
        if (!collisions.isEmpty())
            throw new RequestFailure("conflicting_type_definitions",
                "declarations define different types under one name: " + String.join(", ", collisions) +
                "; nothing was changed");
        return defined;
    }

    private static void absorbCallerTypes(
            Map<String, DataType> defined, Set<String> collisions, Map<String, DataType> incoming) {
        for (Map.Entry<String, DataType> entry : incoming.entrySet()) {
            String name = entry.getKey();
            DataType type = entry.getValue();
            DataType existing = defined.get(name);
            if (existing == null) {
                defined.put(name, type);
                continue;
            }
            if (!sameCallerType(existing, type)) {
                collisions.add(name);
                continue;
            }
            // The tag is the type a matching typedef names.
            if (callerTag(type) && !callerTag(existing)) defined.put(name, type);
        }
    }

    private static boolean sameCallerType(DataType left, DataType right) {
        return left == right || left.isEquivalent(right) || right.isEquivalent(left);
    }

    private static boolean callerTag(DataType type) {
        return type instanceof ghidra.program.model.data.Composite ||
            type instanceof ghidra.program.model.data.Enum;
    }

    /**
     * Composites with no defined components, keyed by identity to the length
     * they had before parsing. Ghidra's parser fills such a composite in place
     * when storeDataType is false, and that object is the definition it returns.
     */
    private Map<DataType, Integer> emptyCompositeLengths() {
        Map<DataType, Integer> lengths = new IdentityHashMap<>();
        Iterator<DataType> all = currentProgram.getDataTypeManager().getAllDataTypes();
        while (all.hasNext()) {
            DataType type = all.next();
            if (type instanceof ghidra.program.model.data.Composite composite &&
                    composite.getNumDefinedComponents() == 0)
                lengths.put(type, composite.getLength());
        }
        return lengths;
    }

    /** A filled empty composite is a replacement of a database type, so the call stores nothing. */
    private void requireUnfilledComposites(Map<DataType, Integer> before) {
        DataTypeManager types = currentProgram.getDataTypeManager();
        Set<String> replaced = new TreeSet<>();
        for (Map.Entry<DataType, Integer> entry : before.entrySet()) {
            DataType type = entry.getKey();
            if (!(type instanceof ghidra.program.model.data.Composite composite) || !types.contains(type)) {
                replaced.add(type.getPathName());
                continue;
            }
            if (composite.getNumDefinedComponents() != 0 || composite.getLength() != entry.getValue())
                replaced.add(composite.getPathName());
        }
        if (replaced.isEmpty()) return;
        throw new RequestFailure("data_type_conflict",
            "Parsing would replace an empty type already in the database: " + String.join(", ", replaced) +
            "; nothing was changed");
    }

    private JsonObject defineNativeDataTypes(JsonObject params) throws Exception {
        if (!Set.of("declarations", "declarations_max_utf16").containsAll(params.keySet()) || !params.has("declarations"))
            throw new RequestFailure("invalid_request", "Bridge request fields are invalid");
        String code = "invalid_type_declarations";
        String declarations = requireText(params, "declarations");
        int lengthBound = callerCTextBound(
            params, "declarations_max_utf16", DEFAULT_TYPE_DECLARATIONS_UTF16, MAX_TYPE_DECLARATIONS_UTF16);
        // Ghidra's parser writes the database (see parseCallerC), so parsing,
        // validation and storage share one rollback: a refusal changes nothing.
        int transaction = currentProgram.startTransaction("REA data type definitions");
        boolean commit = false;
        try {
            // An empty composite is filled in place by the parser. Remember those
            // shapes so a fill is not later mistaken for an unchanged definition.
            Map<DataType, Integer> emptyComposites = emptyCompositeLengths();
            ParsedCallerC parsedDeclarations =
                // Declarations admit no parentheses (see admitCallerC), so no nesting bound applies.
                parseCallerC(declarations, "declarations", true, code, lengthBound, MAX_C_PARENTHESIS_DEPTH);
            requireUnfilledComposites(emptyComposites);
            CParser parser = parsedDeclarations.parser();
            if (!parser.getFunctions().isEmpty())
                throw new RequestFailure(code, "declarations must not declare functions or function-pointer members: " +
                    String.join(", ", new TreeSet<>(parser.getFunctions().keySet())));
            Map<String, DataType> defined = mergeCallerTypeMaps(
                parser.getTypes(), parser.getEnums(), parser.getComposites());
            if (defined.isEmpty())
                throw new RequestFailure(code, "declarations define no struct, union, enum or typedef");
            DataTypeManager types = currentProgram.getDataTypeManager();
            Set<DataType> parsed = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
            parsed.addAll(defined.values());
            List<String> conflicts = new ArrayList<>();
            Set<String> existing = new HashSet<>();
            for (Map.Entry<String, DataType> entry : defined.entrySet()) {
                monitor.checkCancelled();
                String name = entry.getKey();
                DataType type = entry.getValue();
                // Ghidra's parser invents an empty type for a struct, union or enum
                // tag that neither the text nor the database defines, and reports nothing.
                if (type instanceof ghidra.program.model.data.Enum enumeration && enumeration.getCount() == 0)
                    throw new RequestFailure(code, "declarations leave enum " + name + " without members; define every enum they use");
                if (type instanceof ghidra.program.model.data.Composite composite) {
                    if (composite.getNumComponents() == 0)
                        throw new RequestFailure(code, "declarations leave " + name + " without members; define every struct or union they use");
                    Set<String> members = new HashSet<>();
                    for (ghidra.program.model.data.DataTypeComponent component : composite.getComponents())
                        if (component.getFieldName() != null && !members.add(component.getFieldName()))
                            throw new RequestFailure(code, name + " repeats member name " + component.getFieldName());
                }
                requireStoredDependencies(name, type, parsed, types,
                    java.util.Collections.newSetFromMap(new IdentityHashMap<>()));
                String path = CALLER_DEFINED_TYPES.getPath() + "/" + name;
                List<DataType> sameName = new ArrayList<>();
                types.findDataTypes(name, sameName);
                for (DataType other : sameName) {
                    if (other.getPathName().equals(path)) existing.add(name);
                    else conflicts.add(name + " (existing " + other.getPathName() + ")");
                }
            }
            if (!conflicts.isEmpty())
                throw new RequestFailure("data_type_conflict", "The database already holds types with these names: " + String.join(", ", conflicts));
            for (DataType type : defined.values()) type.setCategoryPath(CALLER_DEFINED_TYPES);
            JsonArray rows = new JsonArray();
            for (Map.Entry<String, DataType> entry : defined.entrySet()) {
                monitor.checkCancelled();
                String name = entry.getKey();
                String path = CALLER_DEFINED_TYPES.getPath() + "/" + name;
                DataType stored = types.addDataType(entry.getValue(), DataTypeConflictHandler.DEFAULT_HANDLER);
                // The default handler keeps a differing existing type and stores the new one under a conflict name.
                if (!stored.getPathName().equals(path))
                    throw new RequestFailure("data_type_conflict", name + " is already defined differently as " + path);
                DataType readback = types.getDataType(path);
                if (readback == null || !readback.isEquivalent(entry.getValue()))
                    throw new RequestFailure("data_type_readback_mismatch", "Data type readback differs for " + path);
                JsonObject row = new JsonObject();
                row.addProperty("id", path);
                row.addProperty("name", name);
                row.addProperty("kind", dataTypeKind(readback));
                row.add("size_bytes", readback.getLength() < 0 ? JsonNull.INSTANCE : GSON.toJsonTree(readback.getLength()));
                row.addProperty("status", existing.contains(name) ? "unchanged" : "defined");
                rows.add(row);
            }
            JsonObject result = new JsonObject();
            result.add("types", rows);
            if (!parsedDeclarations.droppedQualifiers().isEmpty())
                result.add("dropped_qualifiers", parsedDeclarations.droppedQualifiers());
            JsonObject effects = new JsonObject();
            effects.addProperty("scope", "session-analysis-database");
            effects.addProperty("source_bytes_modified", false);
            result.add("effects", effects);
            monitor.checkCancelled();
            commit = true;
            return result;
        }
        catch (ghidra.util.exception.DuplicateNameException | IllegalArgumentException exception) {
            throw new RequestFailure(code, "Ghidra refused the declarations: " + safeMessage(exception));
        }
        finally {
            currentProgram.endTransaction(transaction, commit);
        }
    }

    /** Every named type a definition reaches must be defined here or already stored. */
    private void requireStoredDependencies(
            String owner, DataType root, Set<DataType> parsed, DataTypeManager types, Set<DataType> visited) {
        // A worklist, not recursion: caller text sets how deep pointer, array and member chains go.
        // ArrayDeque admits no null, and a generic pointer has no pointed-to type.
        ArrayDeque<DataType> pending = new ArrayDeque<>();
        pending.push(root);
        while (!pending.isEmpty()) {
            DataType type = pending.pop();
            if (!visited.add(type)) continue;
            // Pointer, array and bit-field types are built-in classes; look through them first.
            if (type instanceof ghidra.program.model.data.Pointer || type instanceof ghidra.program.model.data.Array ||
                    type instanceof ghidra.program.model.data.BitFieldDataType) {
                for (DataType child : cTypeChildren(type)) if (child != null) pending.push(child);
                continue;
            }
            if (type instanceof ghidra.program.model.data.BuiltInDataType) continue;
            if (!parsed.contains(type)) {
                if (types.contains(type)) {
                    requireUnambiguousType(type);
                    continue;
                }
                throw new RequestFailure("invalid_type_declarations", owner +
                    " embeds an unnamed or undeclared type (" + type.getName() + "); declare it by name in the same declarations");
            }
            if (type instanceof ghidra.program.model.data.TypeDef || type instanceof ghidra.program.model.data.Composite)
                for (DataType child : cTypeChildren(type)) if (child != null) pending.push(child);
        }
    }

    private String symbolLeafName(Symbol symbol, String requested) throws ghidra.util.exception.InvalidInputException {
        // Fully qualified readback must be usable as an idempotent rename input.
        if (requested.equals(symbol.getName(true))) return symbol.getName();
        String namespace = symbol.getParentNamespace().isGlobal()
            ? "" : symbol.getParentNamespace().getName(true);
        String prefix = namespace + "::";
        if (!namespace.isEmpty() && requested.startsWith(prefix)) {
            String leaf = requested.substring(prefix.length());
            if (!leaf.isEmpty()) return leaf;
            throw new ghidra.util.exception.InvalidInputException(
                "Symbol name has an empty leaf within namespace " + namespace + " at " +
                canonicalAddress(symbol.getAddress()) + ": " + requested);
        }
        return requested;
    }

    private static String requireText(JsonObject params, String field) {
        JsonElement value = params.get(field);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())
            throw new RequestFailure("invalid_request", "Annotation " + field + " must be text");
        return value.getAsString();
    }

    private static void validateAnnotationText(String text, String field) {
        for (int index = 0; index < text.length(); index++) {
            char character = text.charAt(index);
            if (character == 0)
                throw new RequestFailure("invalid_request", "Annotation " + field + " contains NUL at UTF-16 index " + index + "; Ghidra's decompiler cannot marshal NUL text");
            if (Character.isHighSurrogate(character) && index + 1 < text.length() &&
                Character.isLowSurrogate(text.charAt(index + 1))) {
                index++;
                continue;
            }
            if (Character.isSurrogate(character))
                throw new RequestFailure("invalid_request", "Annotation " + field + " contains an unpaired Unicode surrogate at UTF-16 index " + index + "; Ghidra cannot preserve it as annotation text");
        }
    }

    private JsonObject analyzeFunction(JsonObject params) throws Exception {
        return analyzeFunctionObservation(params).dossier();
    }

    private FunctionAnalysisObservation analyzeFunctionObservation(JsonObject params) throws Exception {
        requireKeys(params, Set.of("procedure"));
        Function function = resolveProcedure(requireString(params, "procedure"));
        InstructionScan scan = scanInstructions(function, Integer.MAX_VALUE);
        DecompileResults decompilation;
        String decompilerFailure = null;
        try {
            decompilation = decompile(function);
        } catch (RequestFailure failure) {
            // The listing, reference and CFG facts below do not depend on the
            // native decompiler. Cancellation still ends the request.
            if (!failure.code.equals("decompile_failed") &&
                !failure.code.equals("decompile_timed_out")) throw failure;
            decompilation = null;
            decompilerFailure = failure.getMessage().strip();
        }
        String pseudocode = decompiledText(decompilation);
        JsonObject availability = new JsonObject();
        availability.add("pseudocode", facetAvailability(
            pseudocode != null,
            decompilerFailure != null ? decompilerFailure
                : function.isExternal() ? "Ghidra does not decompile external functions."
                : function.getBody().isEmpty() ? "Ghidra has no function body to decompile."
                : "Ghidra completed decompilation without returning pseudocode."
        ));
        if (pseudocode == null) {
            pseudocode = "";
        }
        List<Reference> bodyIncoming = collectReferences(function, "incoming");
        List<Reference> incomingReferences = bodyIncoming.stream()
            .filter(reference -> !function.getBody().contains(reference.getFromAddress()))
            .toList();
        List<Reference> outgoingReferences = collectReferences(function, "outgoing");
        Map<Address, Function> resolvedFunctions = new HashMap<>();
        Map<Address, JsonObject> procedureIdentities = new HashMap<>();
        JsonArray incoming = referenceEdges(incomingReferences, resolvedFunctions, procedureIdentities);
        JsonArray outgoing = referenceEdges(outgoingReferences, resolvedFunctions, procedureIdentities);
        JsonArray comments = comments(function);
        Set<Function> callerFunctions = function.getCallingFunctions(monitor);
        JsonArray callers = procedureIdentities(callerFunctions);
        Set<Function> calleeFunctions = function.getCalledFunctions(monitor);
        JsonArray callees = procedureIdentities(calleeFunctions);
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
        boolean swift = swiftProgram();
        boolean aarch64 = currentProgram.getLanguageID().getIdAsString().startsWith("AARCH64:");
        SwiftStringLiteralDecode swiftLiterals = swift && aarch64 ? swiftStringLiterals(function) : null;
        if (swiftLiterals != null) {
            result.add("swift_string_literals", swiftLiterals.literals());
            result.add("swift_string_literal_omissions", swiftLiterals.omissions());
        }
        result.add("basic_blocks", blocks);
        result.add(
            "native_api",
            decompilerFailure == null
                ? nativeApiBoundary(function, decompilation, scan.instructions)
                : unavailableNativeApiBoundary(decompilerFailure)
        );
        result.add(
            "native_value_flow",
            decompilerFailure == null
                ? nativeValueFlow(decompilation)
                : unavailableNativeValueFlow(decompilerFailure)
        );
        // Successful full queries distinguish collected empty sets from missing facts.
        // Availability does not claim that Ghidra resolved every runtime relationship.
        for (String facet : List.of("comments", "callers", "callees", "references", "strings_names", "cfg")) {
            availability.add(facet, facetAvailability(true, null));
        }
        availability.add("assembly", facetAvailability(
            !scan.truncated(), "The function instruction scan was truncated."
        ));
        result.add("facet_availability", availability);
        JsonArray limitationCodes = new JsonArray();
        limitationCodes.add("unresolved_computed_or_indirect_flows");
        limitationCodes.add("provider_specific_representations");
        result.add("limitation_codes", limitationCodes);
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
        if (swift && aarch64) {
            limitations.add(
                "Swift String literals are decoded from constant register pairs at calls, returns and paired stores. Literals stored one word at a time, chosen by conditional selects, or built at runtime are not reported; candidate pairs at unresolved jumps are retained as unknown omissions."
            );
            if (swiftLiterals.omissions().size() > 0) {
                limitations.add(
                    "Swift String literal records listed in swift_string_literal_omissions could not be retained or decoded within this dossier's remaining heap budget; later symbolic flows remain unexamined."
                );
            }
        } else if (swift) {
            limitations.add(
                "Swift String literal decoding is implemented for AArch64 register pairs only; no Swift literals were decoded for this architecture."
            );
        }
        CallBoundaryObservation calls = callBoundaryObservation(
            function, scan.instructions, calleeFunctions, true, outgoingReferences);
        result.add("unresolved_calls", calls.unresolvedCalls());
        for (String limitation : calls.limitations()) {
            limitations.add(limitation);
        }
        if (decompilation != null && decompilation.getErrorMessage() != null &&
            !decompilation.getErrorMessage().isBlank()) {
            limitations.add("Ghidra decompiler diagnostic: " + decompilation.getErrorMessage());
        }
        if (decompilerFailure != null) {
            limitations.add(
                decompilerFailure + (decompilerFailure.endsWith(".") ? " " : ". ") +
                "Pseudocode, the native API boundary and p-code value flow are unavailable for this procedure; assembly, comments, callers, callees, references, strings, names and basic blocks come from the Ghidra program listing and were still collected."
            );
        }
        result.add("limitations", limitations);
        monitor.checkCancelled();
        int missingCallers = 0;
        for (Reference reference : bodyIncoming) {
            monitor.checkCancelled();
            if (unrepresentedCaller(reference, callerFunctions)) missingCallers++;
        }
        return new FunctionAnalysisObservation(result, calls.limitations(),
            callRelationshipCoverage(calls, missingCallers), decompilerFailure != null);
    }

    private JsonObject nativeValueFlow(DecompileResults decompilation) throws Exception {
        HighFunction highFunction =
            decompilation == null ? null : decompilation.getHighFunction();
        if (highFunction == null) {
            return unavailableNativeValueFlow(
                "Ghidra has no HighFunction p-code model for this procedure"
            );
        }

        List<PcodeOpAST> selected = new ArrayList<>();
        int omittedOperationsLowerBound = 0;
        Iterator<PcodeOpAST> operations = highFunction.getPcodeOps();
        while (operations.hasNext()) {
            monitor.checkCancelled();
            PcodeOpAST operation = operations.next();
            if (selected.size() >= valueFlowLimits.maxOperations()) {
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
        boolean edgeLimitReached = false;
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
            int capturedInputs = Math.min(inputCount, valueFlowLimits.maxInputsPerOperation());
            for (int inputIndex = 0; inputIndex < capturedInputs; inputIndex += 1) {
                Varnode input = operation.getInput(inputIndex);
                inputs.add(varnodeValue(input));
                if (input instanceof VarnodeAST astInput) {
                    if (astInput.getHigh() instanceof HighParam parameter) {
                        if (parameterUses.size() >= valueFlowLimits.maxEdges()) {
                            edgeLimitReached = true;
                            omittedEdges++;
                        } else {
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
                        if (definitionId == null || defUse.size() >= valueFlowLimits.maxEdges()) {
                            if (defUse.size() >= valueFlowLimits.maxEdges()) edgeLimitReached = true;
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
        JsonObject limits = new JsonObject();
        limits.addProperty("max_operations", valueFlowLimits.maxOperations());
        limits.addProperty("max_inputs_per_operation", valueFlowLimits.maxInputsPerOperation());
        limits.addProperty("max_edges", valueFlowLimits.maxEdges());
        result.add("limits", limits);
        JsonArray limitsReached = new JsonArray();
        if (omittedOperationsLowerBound > 0) limitsReached.add("max_operations");
        if (omittedInputs > 0) limitsReached.add("max_inputs_per_operation");
        if (edgeLimitReached) limitsReached.add("max_edges");
        result.add("limits_reached", limitsReached);
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
            "Memory read/write effects cover high-p-code LOAD and STORE operations only; direct memory address varnodes in other operations are not included. An empty effect list does not establish that no memory is accessed. Recorded instruction references may provide complementary evidence."
        );
        limitations.add(
            "Memory read/write effects include stack and temporary memory operations; they do not identify persistent state or business meaning."
        );
        limitations.add(
            "Operation, input, and def-use limits can truncate large functions; inspect the effective limits, limits_reached and omitted counts before drawing conclusions."
        );
        limitations.add(
            "Known omitted-edge counts cover links omitted from retained operations; omitted operations may contain additional uncounted links."
        );
        if (omittedOperationsLowerBound > 0)
            limitations.add(valueFlowLimitRecovery("max_operations", valueFlowLimits.maxOperations()));
        if (omittedInputs > 0)
            limitations.add(valueFlowLimitRecovery("max_inputs_per_operation", valueFlowLimits.maxInputsPerOperation()));
        if (edgeLimitReached)
            limitations.add(valueFlowLimitRecovery("max_edges", valueFlowLimits.maxEdges()));
        result.add("limitations", limitations);
        return result;
    }

    private static String valueFlowLimitRecovery(String field, int effective) {
        String setting = "ghidra.value_flow_" + field;
        String environment = "REA_GHIDRA_VALUE_FLOW_" + field.toUpperCase(Locale.ROOT);
        String adjustment = effective < Integer.MAX_VALUE
            ? "In MCP, use update_analysis_settings with setting " + setting +
                ", action set and a larger integer value from 1 to " + Integer.MAX_VALUE +
                ", then repeat the selected function analysis on this Program without restarting REA. " +
                "For a one-shot CLI retry, set " + environment +
                " to a larger count in the environment that starts the next rea invocation, then repeat the selected analysis; the previous invocation's Program is no longer active."
            : "The setting is at its Java integer maximum; select a smaller function for this projection.";
        return setting + " reached its effective value of " + effective + ". " + adjustment +
            " These controls do not raise the decompile deadline, bridge transport or MCP client limits.";
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

    // Analyst naming: a function entry renames the function; another mapped
    // address renames its non-dynamic primary label or receives a new global
    // label. Resolve that destination without editing the program.
    private AddressNameTarget addressNameTarget(Address address, String name)
        throws ghidra.util.exception.InvalidInputException {
        if (!currentProgram.getMemory().contains(address))
            throw new RequestFailure("invalid_request", "Address is not mapped: " + canonicalAddress(address));
        validateAnnotationText(name, "name");
        Symbol edited = editedNameSymbol(address);
        return edited == null
            ? new AddressNameTarget(address, currentProgram.getGlobalNamespace(), name)
            : new AddressNameTarget(address, edited.getParentNamespace(), symbolLeafName(edited, name));
    }

    private Symbol editedNameSymbol(Address address) {
        Function function = currentProgram.getFunctionManager().getFunctionAt(address);
        if (function != null) return function.getSymbol();
        Symbol primary = currentProgram.getSymbolTable().getPrimarySymbol(address);
        return primary == null || primary.isDynamic() ? null : primary;
    }

    // Every address whose label or function symbol holds the destination.
    private List<Address> addressNameHolders(AddressNameTarget target) {
        Set<Address> holders = new TreeSet<>();
        for (Symbol symbol : currentProgram.getSymbolTable().getLabelOrFunctionSymbols(target.leaf(), target.namespace()))
            holders.add(symbol.getAddress());
        return List.copyOf(holders);
    }

    // Apply one planned destination in its own transaction. Null means the
    // edit committed with matching primary-symbol readback.
    private String applyAddressName(AddressNameTarget target) {
        Address address = target.address();
        int transaction = currentProgram.startTransaction("REA address name");
        boolean commit = false;
        try {
            Function function = currentProgram.getFunctionManager().getFunctionAt(address);
            Symbol edited = editedNameSymbol(address);
            if (function != null) {
                function.setName(target.leaf(), SourceType.USER_DEFINED);
            } else if (edited != null) {
                edited.setName(target.leaf(), SourceType.USER_DEFINED);
            } else {
                Symbol created = currentProgram.getSymbolTable().createLabel(address, target.leaf(), SourceType.USER_DEFINED);
                created.setPrimary();
            }
            Symbol readback = currentProgram.getSymbolTable().getPrimarySymbol(address);
            commit = readback != null && target.leaf().equals(readback.getName());
            return commit ? null : "readback_mismatch";
        }
        catch (ghidra.util.exception.InvalidInputException exception) {
            return "invalid_name";
        }
        catch (ghidra.util.exception.DuplicateNameException exception) {
            return "duplicate_name";
        }
        finally {
            currentProgram.endTransaction(transaction, commit);
        }
    }

    private JsonElement setAddressName(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "address", "name"));
        requireDocument(params);
        String key = requireString(params, "address");
        Address address = requireAddress(params, "address");
        String name = requireString(params, "name");
        // A single edit keeps request errors for unmapped addresses and
        // unrepresentable text; other outcomes share the batch representation.
        if (!currentProgram.getMemory().contains(address))
            throw new RequestFailure("invalid_request", "Address is not mapped: " + canonicalAddress(address));
        validateAnnotationText(name, "name");
        Map<String, String> requested = new LinkedHashMap<>();
        requested.put(key, name);
        return applyAddressNames(requested);
    }

    private JsonElement setAddressesNames(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "names"));
        requireDocument(params);
        if (!params.has("names") || !params.get("names").isJsonObject())
            throw new RequestFailure("invalid_request", "names must be an object of address -> name");
        Map<String, String> requested = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> entry : params.getAsJsonObject("names").entrySet())
            requested.put(entry.getKey(), entry.getValue().getAsString());
        return applyAddressNames(requested);
    }

    // Decide every request from the names held before any edit, so object
    // member order never selects which address receives a name. Reply with
    // per-key results and reasons; a contested destination is listed once in
    // conflicts and failures refer to it by index.
    private JsonObject applyAddressNames(Map<String, String> requested) {
        Map<String, Address> addressesByKey = new LinkedHashMap<>();
        Map<Address, List<AddressNameRequest>> requestsByAddress = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : requested.entrySet()) {
            Address address = null;
            try {
                address = parseReaAddress(entry.getKey());
                requestsByAddress.computeIfAbsent(address, ignored -> new ArrayList<>())
                    .add(new AddressNameRequest(entry.getKey(), address, entry.getValue()));
            }
            catch (RequestFailure failure) {
                // The key keeps its own invalid_address outcome below.
            }
            addressesByKey.put(entry.getKey(), address);
        }
        Map<Address, AddressNameFailure> failures = new HashMap<>();
        Map<AddressNameDestination, List<AddressNameTarget>> destinations = new LinkedHashMap<>();
        for (Map.Entry<Address, List<AddressNameRequest>> selected : requestsByAddress.entrySet()) {
            Address address = selected.getKey();
            String name = selected.getValue().get(0).name;
            if (selected.getValue().stream().anyMatch(request -> !request.name.equals(name))) {
                failures.put(address, new AddressNameFailure("conflicting_alias_names", null));
                continue;
            }
            if (!currentProgram.getMemory().contains(address)) {
                failures.put(address, new AddressNameFailure("unmapped_address", null));
                continue;
            }
            try {
                AddressNameTarget target = addressNameTarget(address, name);
                destinations.computeIfAbsent(target.destination(), ignored -> new ArrayList<>()).add(target);
            }
            catch (RequestFailure | ghidra.util.exception.InvalidInputException exception) {
                failures.put(address, new AddressNameFailure("invalid_name", null));
            }
        }
        // Reject a destination that several selected addresses request, or
        // that another address holds, instead of letting order pick a winner.
        List<AddressNameConflict> conflicts = new ArrayList<>();
        List<AddressNameTarget> independent = new ArrayList<>();
        for (List<AddressNameTarget> requesters : destinations.values()) {
            AddressNameTarget first = requesters.get(0);
            List<Address> holders = addressNameHolders(first);
            String reason;
            if (requesters.size() > 1) {
                reason = "duplicate_requested_name";
            } else if (holders.stream().allMatch(first.address()::equals)) {
                independent.add(first);
                continue;
            } else if (holders.stream().anyMatch(holder ->
                !holder.equals(first.address()) && !requestsByAddress.containsKey(holder))) {
                reason = "name_held_by_unselected_address";
            } else {
                reason = "name_held_by_selected_address";
            }
            AddressNameConflict conflict = new AddressNameConflict(
                first.namespace(),
                first.leaf(),
                requesters.stream().map(AddressNameTarget::address).sorted().toList(),
                holders
            );
            conflicts.add(conflict);
            for (AddressNameTarget target : requesters)
                failures.put(target.address(), new AddressNameFailure(reason, conflict));
        }
        // Independent edits have distinct destinations that no other address
        // holds, so their results do not depend on application order.
        try {
            for (AddressNameTarget target : independent) {
                String reason = applyAddressName(target);
                if (reason != null) failures.put(target.address(), new AddressNameFailure(reason, null));
            }
        }
        finally {
            if (!independent.isEmpty()) {
                invalidateSymbolAndDecompilerCaches();
            }
        }
        // Requesters belong to exactly one destination, so ordering conflicts
        // by their first requester gives indexes independent of member order.
        conflicts.sort(Comparator.comparing((AddressNameConflict conflict) -> conflict.requesters().get(0)));
        Map<AddressNameConflict, Integer> indexes = new IdentityHashMap<>();
        JsonArray contested = new JsonArray();
        for (AddressNameConflict conflict : conflicts) {
            indexes.put(conflict, contested.size());
            JsonObject value = new JsonObject();
            if (conflict.namespace().isGlobal()) value.add("namespace", JsonNull.INSTANCE);
            else value.addProperty("namespace", conflict.namespace().getName(true));
            value.addProperty("name", conflict.leaf());
            value.add("requested_by", canonicalAddresses(conflict.requesters()));
            value.add("held_by", canonicalAddresses(conflict.holders()));
            contested.add(value);
        }
        JsonObject results = new JsonObject();
        JsonObject failed = new JsonObject();
        for (Map.Entry<String, Address> entry : addressesByKey.entrySet()) {
            Address address = entry.getValue();
            AddressNameFailure failure = address == null
                ? new AddressNameFailure("invalid_address", null)
                : failures.get(address);
            results.addProperty(entry.getKey(), failure == null);
            if (failure == null) continue;
            JsonObject value = new JsonObject();
            if (address == null) value.add("address", JsonNull.INSTANCE);
            else value.addProperty("address", canonicalAddress(address));
            value.addProperty("reason", failure.reason());
            if (failure.conflict() == null) value.add("conflict", JsonNull.INSTANCE);
            else value.addProperty("conflict", indexes.get(failure.conflict()));
            failed.add(entry.getKey(), value);
        }
        JsonObject result = new JsonObject();
        result.add("results", results);
        result.add("failures", failed);
        result.add("conflicts", contested);
        return result;
    }

    private static JsonArray canonicalAddresses(List<Address> addresses) {
        JsonArray result = new JsonArray();
        for (Address address : addresses) result.add(canonicalAddress(address));
        return result;
    }

    private JsonArray listDocuments(JsonObject params) {
        requireKeys(params, Set.of());
        JsonArray result = new JsonArray();
        result.add(currentProgram.getName());
        return result;
    }

    private JsonObject binaryInventorySummary(JsonObject params) throws Exception {
        requireKeys(params, Set.of());
        JsonObject result = new JsonObject();
        result.addProperty("document", currentProgram.getName());
        result.add("segments", segments());
        // Preserve exact discovery deduplication and non-null string rules
        // without materializing unrequested inventories in memory.
        result.addProperty("procedure_count", countProcedures());
        result.addProperty("string_count", countStrings());
        return result;
    }

    private int countProcedures() throws Exception {
        if (procedureInventory != null) {
            return procedureInventory.size();
        }
        Set<Address> seen = new HashSet<>();
        countUniqueFunctions(seen, currentProgram.getFunctionManager().getFunctions(true));
        countUniqueFunctions(seen, currentProgram.getFunctionManager().getExternalFunctions());
        return seen.size();
    }

    private void countUniqueFunctions(Set<Address> seen, FunctionIterator functions) throws Exception {
        while (functions.hasNext()) {
            monitor.checkCancelled();
            seen.add(functions.next().getEntryPoint());
        }
    }

    private int countStrings() throws Exception {
        if (stringInventory != null) {
            return stringInventory.size();
        }
        int count = 0;
        DataIterator dataItems = currentProgram.getListing().getDefinedData(true);
        while (dataItems.hasNext()) {
            monitor.checkCancelled();
            Data data = dataItems.next();
            if (!data.hasStringValue()) {
                continue;
            }
            if (StringDataInstance.getStringDataInstance(data).getStringValue() == null) {
                continue;
            }
            count++;
        }
        return count;
    }

    private StreamingResult listNames(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "address"));
        requireDocument(params);
        String requested = optionalString(params, "address");
        List<NameEntry> entries;
        if (requested != null) {
            Address address = parseReaAddress(requested);
            if (nameInventory != null) {
                entries = sliceAtAddress(nameInventory, NameEntry::address, address);
            } else if (!address.isMemoryAddress() && !address.isExternalAddress()) {
                entries = List.of();
            } else {
                List<NameEntry> found = new ArrayList<>();
                for (Symbol symbol : currentProgram.getSymbolTable().getSymbols(address)) {
                    monitor.checkCancelled();
                    Address symbolAddress = symbol.getAddress();
                    if (!symbolAddress.isMemoryAddress() && !symbolAddress.isExternalAddress()) {
                        continue;
                    }
                    found.add(new NameEntry(symbolAddress, symbol.getName(true), symbolFacts(symbol)));
                }
                found.sort(NAME_ORDER);
                entries = found;
            }
        } else {
            entries = names();
        }
        monitor.checkCancelled();
        return out -> writeNameEntries(out, entries);
    }

    private StreamingResult listProcedures(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document"));
        requireDocument(params);
        List<ProcedureEntry> entries = procedures();
        monitor.checkCancelled();
        return out -> writeProcedureEntries(out, entries);
    }

    private JsonArray listSegments(JsonObject params) {
        requireKeys(params, Set.of("document"));
        requireDocument(params);
        return segments();
    }

    private JsonArray segments() {
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

    private StreamingResult listStrings(JsonObject params) throws Exception {
        requireKeys(params, Set.of("document", "address"));
        requireDocument(params);
        String requested = optionalString(params, "address");
        List<StringEntry> entries;
        if (requested != null) {
            Address address = parseReaAddress(requested);
            if (stringInventory != null) {
                entries = sliceAtAddress(stringInventory, StringEntry::address, address);
            } else {
                Data data = currentProgram.getListing().getDefinedDataAt(address);
                StringEntry entry = data == null ? null : stringEntry(data);
                entries = entry == null ? List.of() : List.of(entry);
            }
        } else {
            entries = strings();
        }
        monitor.checkCancelled();
        return out -> writeStringEntries(out, entries);
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
        Function function = functionAtOrContaining(query);
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

    private StreamingResult search(JsonObject params, boolean procedureSearch) throws Exception {
        Set<String> keys = new HashSet<>(Set.of("pattern", "mode", "case_sensitive", "document"));
        if (params.has("literal_ascii_candidate")) keys.add("literal_ascii_candidate");
        if (params.has("literal_ascii_substring")) keys.add("literal_ascii_substring");
        requireKeys(params, keys);
        requireDocument(params);
        String expression = requireString(params, "pattern");
        String mode = requireString(params, "mode");
        if (!mode.equals("literal") && !mode.equals("regex")) {
            throw new RequestFailure("invalid_request", "mode must be literal or regex");
        }
        boolean caseSensitive = requireBoolean(params, "case_sensitive");
        ValueMatcher matcher;
        if (mode.equals("literal") && !caseSensitive) {
            if (!params.has("literal_ascii_candidate"))
                throw new RequestFailure("invalid_request", "Insensitive literal search requires an ASCII candidate");
            matcher = literalCandidateMatcher(
                optionalString(params, "literal_ascii_candidate"),
                optionalString(params, "literal_ascii_substring")
            );
        } else {
            if (params.has("literal_ascii_candidate") || params.has("literal_ascii_substring"))
                throw new RequestFailure("invalid_request", "ASCII candidate applies only to insensitive literals");
            matcher = mode.equals("literal")
                ? literalMatcher(expression)
                : regexMatcher(expression, caseSensitive);
        }
        if (procedureSearch) {
            // Search the names exact lookup accepts, keeping one row per
            // procedure under its primary name. An unbuilt inventory is
            // scanned without retaining it for one ad-hoc search.
            List<ProcedureEntry> entries =
                procedureInventory != null ? procedureInventory : buildProcedures();
            List<MatchedProcedure> matches = new ArrayList<>();
            for (ProcedureEntry entry : entries) {
                monitor.checkCancelled();
                ProcedureNameMatch match = matchProcedureNames(entry, matcher);
                if (!match.matched()) {
                    continue;
                }
                matches.add(new MatchedProcedure(entry, match.aliases()));
            }
            return out -> writeMatchedProcedures(out, matches);
        }
        List<StringEntry> matches = new ArrayList<>();
        if (stringInventory != null) {
            for (StringEntry entry : stringInventory) {
                monitor.checkCancelled();
                if (matcher.matches(entry.value())) {
                    matches.add(entry);
                }
            }
        } else {
            // A selective search must not materialize and retain the full
            // string inventory for one ad-hoc query; scan defined data and
            // keep only matches, in the inventory's deterministic order.
            DataIterator dataItems = currentProgram.getListing().getDefinedData(true);
            while (dataItems.hasNext()) {
                monitor.checkCancelled();
                StringEntry entry = matchedStringEntry(dataItems.next(), matcher);
                if (entry != null) {
                    matches.add(entry);
                }
            }
            matches.sort(STRING_ORDER);
        }
        return out -> writeStringEntries(out, matches);
    }

    /**
     * The one definition of the names that select a procedure, shared by exact
     * lookup and search: its primary name and every other symbol at its exact
     * entry, each in leaf or namespace-qualified spelling. A label inside the
     * body never names the procedure. Matching secondary symbols are reported
     * by their qualified names, sorted.
     */
    private static ProcedureNameMatch matchProcedureNames(ProcedureEntry entry, ValueMatcher matcher) {
        boolean primary = spellingMatches(entry.leafName(), entry.value(), entry.leafIsSuffix(), matcher);
        if (entry.aliases().isEmpty()) {
            return new ProcedureNameMatch(primary, List.of());
        }
        List<String> matchedAliases = null;
        for (ProcedureAlias alias : entry.aliases()) {
            if (!spellingMatches(alias.leaf(), alias.qualified(), alias.leafIsSuffix(), matcher)) continue;
            if (alias.qualified().equals(entry.value())) {
                primary = true;
                continue;
            }
            if (matchedAliases == null) matchedAliases = new ArrayList<>(2);
            if (matchedAliases.isEmpty() || !matchedAliases.get(matchedAliases.size() - 1).equals(alias.qualified())) {
                matchedAliases.add(alias.qualified());
            }
        }
        return new ProcedureNameMatch(primary, matchedAliases == null ? List.of() : matchedAliases);
    }

    /** When a leaf ends its qualified spelling, substring matching on qualified already implies leaf coverage. */
    private static boolean spellingMatches(
            String leaf,
            String qualified,
            boolean leafIsSuffix,
            ValueMatcher matcher) {
        if (matcher.matches(qualified)) {
            return true;
        }
        if (leaf.equals(qualified) || (!matcher.requiresLeafCheck() && leafIsSuffix)) {
            return false;
        }
        return matcher.matches(leaf);
    }

    private List<NameEntry> names() throws Exception {
        if (nameInventory != null) {
            return nameInventory;
        }
        List<NameEntry> result = new ArrayList<>();
        SymbolIterator symbols = currentProgram.getSymbolTable().getAllSymbols(true);
        while (symbols.hasNext()) {
            monitor.checkCancelled();
            Symbol symbol = symbols.next();
            Address address = symbol.getAddress();
            if (!address.isMemoryAddress() && !address.isExternalAddress()) {
                continue;
            }
            result.add(new NameEntry(address, symbol.getName(true), symbolFacts(symbol)));
        }
        result.sort(NAME_ORDER);
        nameInventory = List.copyOf(result);
        return nameInventory;
    }

    private List<ProcedureEntry> procedures() throws Exception {
        if (procedureInventory != null) {
            return procedureInventory;
        }
        procedureInventory = List.copyOf(buildProcedures());
        return procedureInventory;
    }

    private List<ProcedureEntry> buildProcedures() throws Exception {
        List<ProcedureEntry> result = new ArrayList<>();
        Set<Address> seen = new HashSet<>();
        appendFunctions(result, seen, currentProgram.getFunctionManager().getFunctions(true));
        appendFunctions(result, seen, currentProgram.getFunctionManager().getExternalFunctions());
        result.sort(PROCEDURE_ORDER);
        return result;
    }

    private void appendFunctions(
            List<ProcedureEntry> destination,
            Set<Address> seen,
            FunctionIterator functions) throws Exception {
        SymbolTable symbolTable = currentProgram.getSymbolTable();
        while (functions.hasNext()) {
            monitor.checkCancelled();
            Function function = functions.next();
            Address entryPoint = function.getEntryPoint();
            if (!seen.add(entryPoint)) {
                continue;
            }
            Function target = function.isThunk() ? function.getThunkedFunction(false) : null;
            ProcedureFacts facts = new ProcedureFacts(
                function.isExternal(),
                function.isThunk(),
                target == null ? null : target.getEntryPoint()
            );
            Symbol symbol = function.getSymbol();
            String leafName = function.getName();
            String value = symbol == null ? leafName : symbol.getName(true);
            List<ProcedureAlias> aliases = List.of();
            for (Symbol candidate : symbolTable.getSymbols(entryPoint)) {
                monitor.checkCancelled();
                String qualified = candidate.getName(true);
                String candidateLeaf = candidate.getName();
                if (qualified.equals(value) && candidateLeaf.equals(leafName)) {
                    continue;
                }
                if (aliases.isEmpty()) {
                    aliases = new ArrayList<>(2);
                }
                aliases.add(new ProcedureAlias(
                    candidateLeaf.equals(qualified) ? qualified : candidateLeaf,
                    qualified
                ));
            }
            if (aliases.size() > 1) {
                aliases.sort(Comparator.comparing(ProcedureAlias::qualified));
            }
            if (!aliases.isEmpty()) {
                aliases = List.copyOf(aliases);
            }
            destination.add(new ProcedureEntry(
                function,
                entryPoint,
                value,
                leafName.equals(value) ? value : leafName,
                aliases,
                facts,
                symbol == null ? null : symbolFacts(symbol)
            ));
        }
    }

    private List<StringEntry> strings() throws Exception {
        if (stringInventory != null) {
            return stringInventory;
        }
        List<StringEntry> result = new ArrayList<>();
        DataIterator dataItems = currentProgram.getListing().getDefinedData(true);
        while (dataItems.hasNext()) {
            monitor.checkCancelled();
            StringEntry entry = stringEntry(dataItems.next());
            if (entry != null) {
                result.add(entry);
            }
        }
        result.sort(STRING_ORDER);
        stringInventory = List.copyOf(result);
        return stringInventory;
    }

    private static StringFacts stringFacts(Data data, StringDataInstance instance) {
        String charset = instance.getCharsetName();
        return new StringFacts(
            charset == null || charset.isEmpty() ? "unknown" : charset,
            instance.isMissingNullTerminator(),
            Math.max(0, data.getLength())
        );
    }

    private static StringEntry stringEntry(Data data) {
        if (!data.hasStringValue()) {
            return null;
        }
        StringDataInstance instance = StringDataInstance.getStringDataInstance(data);
        String value = instance.getStringValue();
        if (value == null) {
            return null;
        }
        return new StringEntry(data.getAddress(), value, stringFacts(data, instance));
    }

    /** Match before allocating facts, so a selective search retains only its matches. */
    private static StringEntry matchedStringEntry(Data data, ValueMatcher matcher) {
        if (!data.hasStringValue()) {
            return null;
        }
        StringDataInstance instance = StringDataInstance.getStringDataInstance(data);
        String value = instance.getStringValue();
        if (value == null || !matcher.matches(value)) {
            return null;
        }
        return new StringEntry(data.getAddress(), value, stringFacts(data, instance));
    }

    private Map<String, Object> procedureIndex() {
        if (procedureNameIndex != null) {
            return procedureNameIndex;
        }
        Map<String, Object> index = new HashMap<>(procedureInventory.size() * 2);
        for (ProcedureEntry entry : procedureInventory) {
            Function function = entry.function();
            indexProcedureName(index, entry.value(), function);
            if (!entry.leafName().equals(entry.value())) {
                indexProcedureName(index, entry.leafName(), function);
            }
            for (ProcedureAlias alias : entry.aliases()) {
                indexProcedureName(index, alias.qualified(), function);
                if (!alias.leaf().equals(alias.qualified())) {
                    indexProcedureName(index, alias.leaf(), function);
                }
            }
        }
        procedureNameIndex = index;
        return index;
    }

    private static void indexProcedureName(Map<String, Object> index, String name, Function function) {
        Object existing = index.get(name);
        if (existing == null) {
            index.put(name, function);
            return;
        }
        if (existing instanceof Function single) {
            if (!single.getEntryPoint().equals(function.getEntryPoint())) {
                List<Function> list = new ArrayList<>(2);
                list.add(single);
                list.add(function);
                index.put(name, list);
            }
            return;
        }
        @SuppressWarnings("unchecked")
        List<Function> list = (List<Function>) existing;
        if (!list.get(list.size() - 1).getEntryPoint().equals(function.getEntryPoint())) {
            list.add(function);
        }
    }

    private Function resolveProcedureByName(String value) throws Exception {
        if (procedureInventory != null) {
            Object hit = procedureIndex().get(value);
            if (hit == null) return null;
            if (hit instanceof Function function) return function;
            @SuppressWarnings("unchecked")
            List<Function> matches = (List<Function>) hit;
            throw ambiguousProcedureFailure(value, matches);
        }
        List<Function> matches = resolveProcedureCandidatesDirect(value);
        if (matches.size() > 1) {
            throw ambiguousProcedureFailure(value, matches);
        }
        return matches.size() == 1 ? matches.get(0) : null;
    }

    private List<Function> resolveProcedureCandidatesDirect(String value) throws Exception {
        SymbolTable symbolTable = currentProgram.getSymbolTable();
        FunctionManager functionManager = currentProgram.getFunctionManager();
        AddressFactory addressFactory = currentProgram.getAddressFactory();
        TreeMap<Address, Function> candidates = new TreeMap<>();

        // Ghidra leaf names can contain "::" (for example namespace "ns" + leaf
        // "other::work" -> "ns::other::work"). Try every "::" suffix because
        // SymbolTable.getSymbols(name) indexes leaf spellings rather than full paths.
        Set<String> candidateLeafNames = new LinkedHashSet<>();
        addProcedureLookupCandidate(candidateLeafNames, value);
        int separator = value.indexOf("::");
        while (separator >= 0 && separator + 2 < value.length()) {
            addProcedureLookupCandidate(candidateLeafNames, value.substring(separator + 2));
            separator = value.indexOf("::", separator + 1);
        }

        for (String candidateName : candidateLeafNames) {
            monitor.checkCancelled();
            SymbolIterator symbols = symbolTable.getSymbols(candidateName);
            while (symbols.hasNext()) {
                monitor.checkCancelled();
                addCandidateFunctionAndThunks(candidates, functionManager, symbols.next().getAddress());
            }
            Address dynamicAddress = SymbolUtilities.parseDynamicName(addressFactory, candidateName);
            if (dynamicAddress != null) {
                addCandidateFunctionAndThunks(candidates, functionManager, dynamicAddress);
            }
        }

        if (candidates.isEmpty()) {
            return List.of();
        }
        List<Function> matches = new ArrayList<>(candidates.size() == 1 ? 1 : 4);
        for (Function function : candidates.values()) {
            monitor.checkCancelled();
            if (procedureExactMatch(symbolTable, function, value)) {
                matches.add(function);
            }
        }
        return matches;
    }

    private static void addProcedureLookupCandidate(Set<String> candidates, String candidate) {
        if (!candidate.isEmpty()) {
            candidates.add(candidate);
        }
        String stripped = candidate;
        while (stripped.startsWith("thunk_")) {
            stripped = stripped.substring("thunk_".length());
            if (!stripped.isEmpty()) {
                candidates.add(stripped);
            }
        }
    }

    private void addCandidateFunctionAndThunks(
        TreeMap<Address, Function> candidates,
        FunctionManager functionManager,
        Address address
    ) throws Exception {
        if (!address.isMemoryAddress() && !address.isExternalAddress()) {
            return;
        }
        Function function = functionManager.getFunctionAt(address);
        if (function == null) {
            return;
        }
        if (candidates.putIfAbsent(function.getEntryPoint(), function) == null) {
            Address[] thunkAddresses = function.getFunctionThunkAddresses(true);
            if (thunkAddresses != null) {
                for (Address thunkAddress : thunkAddresses) {
                    monitor.checkCancelled();
                    Function thunk = functionManager.getFunctionAt(thunkAddress);
                    if (thunk != null) {
                        candidates.putIfAbsent(thunk.getEntryPoint(), thunk);
                    }
                }
            }
        }
    }

    private static boolean procedureExactMatch(
        SymbolTable symbolTable,
        Function function,
        String value
    ) {
        if (function.getName().equals(value)) {
            return true;
        }
        Symbol primarySymbol = function.getSymbol();
        if (primarySymbol != null && primarySymbol.getName(true).equals(value)) {
            return true;
        }
        for (Symbol symbol : symbolTable.getSymbols(function.getEntryPoint())) {
            if (symbol.getName().equals(value) || symbol.getName(true).equals(value)) {
                return true;
            }
        }
        return false;
    }

    private static RequestFailure ambiguousProcedureFailure(String value, List<Function> matches) {
        JsonArray candidates = new JsonArray();
        for (Function function : matches) candidates.add(canonicalAddress(function.getEntryPoint()));
        return new RequestFailure(
            "procedure_ambiguous",
            "Ghidra procedure name is ambiguous: " + value +
                "; select an exact entry address from " + matches.stream()
                    .map(function -> canonicalAddress(function.getEntryPoint())).toList(),
            candidates
        );
    }

    private Function resolveProcedure(String value) throws Exception {
        // Explicit address syntax wins; an unprefixed identifier is first an
        // exact symbol name, even when every character is a hexadecimal digit.
        boolean explicitAddress = isExplicitReaAddress(value);
        if (!explicitAddress) {
            // Imported labels (for example Mach-O _main) can share a function
            // entry without becoming its primary symbol; search accepts the same.
            Function matched = resolveProcedureByName(value);
            if (matched != null) return matched;
        }
        // Retain legacy bare-hex address input only when no symbol matches.
        Address address = explicitAddress ? parseReaAddress(value) : tryParseAddress(value);
        if (address == null)
            throw new RequestFailure("procedure_not_found", "Unknown Ghidra procedure name or address: " + value);
        Function function = functionAtOrContaining(address);
        if (function == null)
            // Other procedure operations retain their analysis-address semantics.
            throw new RequestFailure("procedure_not_found", "No procedure exists at the requested address: " + value +
                (isCodeOutsideFunctions(address) ? ". " + CODE_OUTSIDE_FUNCTIONS +
                    "; procedure_pseudo_code can decompile it on the fly, and inspect_native_instruction reads its instructions" : "") +
                "; Ghidra image base: " + canonicalAddress(currentProgram.getImageBase()) +
                ". Choose an observed analysis address. CLI: rea search <path> . --kind procedures --mode regex --provider ghidra --json; " +
                "MCP: list_procedures. Inspect the loaded base and source mappings with CLI rea analyze <path> --provider ghidra --json " +
                "and rea inspect-native-load-image <path> --provider ghidra --json, or MCP binary_overview and inspect_native_load_image. " +
                "Repeat the original target options. For decompile, select source coordinates explicitly with --file-offset=0x... or MCP procedure file-offset:0x....");
        return function;
    }

    private static final String NON_PROCEDURE_LIMITATION =
        "The selected address is outside every Ghidra function, such as an import address-table slot or a data label. " +
        "The result lists the ReferenceManager's references to that address with their containing functions; unrecorded references remain unknown.";

    /**
     * An explicit memory address outside every function selects that address
     * for incoming references, such as an import address-table slot. Names stay
     * procedure selectors: REA's shared selector owner resolves a name outside
     * every function and asks again by its address.
     */
    private Address incomingNonProcedureAddress(String value) {
        if (!isExplicitReaAddress(value)) return null;
        Address address = tryParseAddress(value);
        if (address == null || !address.isMemoryAddress() || !currentProgram.getMemory().contains(address)) return null;
        return functionAtOrContaining(address) == null ? address : null;
    }

    private JsonObject nonProcedureIdentity(Address address) {
        JsonObject result = new JsonObject();
        result.addProperty("address", canonicalAddress(address));
        Symbol symbol = currentProgram.getSymbolTable().getPrimarySymbol(address);
        result.addProperty("name", symbol == null ? canonicalAddress(address) : symbol.getName(true));
        result.add("symbol", symbol == null ? JsonNull.INSTANCE : symbolMetadata(symbol));
        result.add("classification", JsonNull.INSTANCE);
        JsonObject body = new JsonObject();
        body.addProperty("available", false);
        body.addProperty("reason", "The address is outside every Ghidra function; it has no function body");
        result.add("body", body);
        return result;
    }

    private List<Reference> referencesToAddress(Address address) throws Exception {
        TreeMap<String, Reference> observed = new TreeMap<>();
        visitObservedReferencesTo(address, reference -> addReference(observed, reference));
        List<Reference> result = new ArrayList<>(observed.values());
        result.sort(REFERENCE_ORDER);
        return result;
    }

    private JsonObject addressReferences(Address address) throws Exception {
        JsonObject result = new JsonObject();
        result.add("procedure", nonProcedureIdentity(address));
        result.addProperty("direction", "incoming");
        result.add("references", referenceEdges(referencesToAddress(address)));
        result.addProperty("reference_kinds_available", true);
        result.add("unresolved_calls", new JsonArray());
        return functionObservation(result, List.of(NON_PROCEDURE_LIMITATION));
    }

    private JsonObject addressCallers(Address address) throws Exception {
        TreeMap<Address, Function> callers = new TreeMap<>();
        for (Reference reference : referencesToAddress(address)) {
            monitor.checkCancelled();
            Function function = functionAtOrContaining(reference.getFromAddress());
            if (function != null) callers.putIfAbsent(function.getEntryPoint(), function);
        }
        JsonArray result = new JsonArray();
        for (Address entry : callers.keySet()) result.add(canonicalAddress(entry));
        return functionObservation(result, List.of(NON_PROCEDURE_LIMITATION));
    }

    /** Exact entries include externals; containment applies only to memory addresses. */
    private Function functionAtOrContaining(Address address) {
        Function function = currentProgram.getFunctionManager().getFunctionAt(address);
        return function == null && address.isMemoryAddress()
            ? currentProgram.getFunctionManager().getFunctionContaining(address)
            : function;
    }

    private JsonObject nativeApiBoundary(
        Function function,
        DecompileResults decompilation,
        List<Instruction> instructions
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

        if (currentProgram.getLanguageID().getIdAsString().startsWith("x86:LE:32:")) {
            DecompiledFunction inferred = decompilation.getDecompiledFunction();
            if (signatureSource.equals("analysis") && inferred != null) {
                result.add(
                    "prototype_conflicts",
                    prototypeConflicts(
                        function, prototype, instructions, inferred.getSignature(), signatureSource)
                );
            }
            limitations.add(
                "Prototype conflict checks cover direct EBP-framed argument reads and immediate RET cleanup under an inferred stdcall convention in analysis-inferred x86-32 signatures only; no diagnostic does not establish a correct signature."
            );
        }

        JumpTable[] recoveredJumpTables = highFunction.getJumpTables();
        if (recoveredJumpTables.length > 0) {
            Map<Address, List<ClangCaseToken>> caseTokensByTarget =
                indexCaseTokens(decompilation.getCCodeMarkup());
            for (int index = 0; index < recoveredJumpTables.length; index += 1) {
                jumpTables.add(inferredJumpTable(recoveredJumpTables[index], caseTokensByTarget));
            }
        }
        return result;
    }

    private Map<Address, List<ClangCaseToken>> indexCaseTokens(ClangNode root)
        throws Exception {
        Map<Address, List<ClangCaseToken>> casesByTarget = new HashMap<>();
        if (root == null) return casesByTarget;
        ArrayDeque<ClangNode> stack = new ArrayDeque<>();
        stack.push(root);
        while (!stack.isEmpty()) {
            monitor.checkCancelled();
            ClangNode node = stack.pop();
            if (node instanceof ClangCaseToken token) {
                PcodeOp operation = token.getPcodeOp();
                if (operation != null && operation.getParent() != null) {
                    casesByTarget
                        .computeIfAbsent(operation.getParent().getStart(), ignored -> new ArrayList<>())
                        .add(token);
                }
            }
            for (int index = node.numChildren() - 1; index >= 0; index -= 1) {
                ClangNode child = node.Child(index);
                if (child != null) stack.push(child);
            }
        }
        return casesByTarget;
    }

    private JsonArray prototypeConflicts(
        Function function,
        FunctionPrototype prototype,
        List<Instruction> instructions,
        String signature,
        String signatureSource
    ) throws Exception {
        JsonArray conflicts = new JsonArray();
        int count = prototype.getNumParams();
        if (count == 0) {
            FrameRead read = framedStackRead(function.getEntryPoint(), instructions, monitor);
            if (read != null) {
                JsonObject conflict = prototypeConflict(
                    "stack-argument-read", signature, signatureSource, count, read.instruction());
                conflict.addProperty("frame_offset_bytes", read.offset());
                conflict.add("unresolved_assumptions", GSON.toJsonTree(List.of(
                    "The frame-relative read is not proof of a source-level parameter or its type.",
                    "The instruction does not establish the value's origin or the function's complete computation."
                )));
                conflicts.add(conflict);
            }
        }
        String convention = prototype.getModelName();
        if (!"__stdcall".equalsIgnoreCase(convention)) return conflicts;
        int inferredStackBytes = 0;
        for (int index = 0; index < count; index++) {
            HighSymbol parameter = prototype.getParam(index);
            if (parameter == null) return conflicts;
            VariableStorage storage = parameter.getStorage();
            if (storage == null || !storage.isStackStorage() || storage.isCompoundStorage() ||
                storage.size() != 4 || storage.getStackOffset() != 4 + inferredStackBytes)
                return conflicts;
            inferredStackBytes += 4;
        }
        for (Instruction instruction : reachablePrototypeInstructions(
            function.getEntryPoint(), instructions, monitor)) {
            monitor.checkCancelled();
            Instruction terminal = instruction;
            if (instruction.getMnemonicString().equalsIgnoreCase("JMP") &&
                instruction.getFlows().length == 1) {
                Address target = instruction.getFlows()[0];
                // A direct one-hop shared epilogue is evidence, not additional owned
                // body. A target belonging to another function is a tail call, whose
                // cleanup belongs to that callee rather than this prototype.
                if (!function.getBody().contains(target) &&
                    functionAtOrContaining(target) == null) {
                    terminal = currentProgram.getListing().getInstructionAt(target);
                    if (terminal == null) continue;
                }
            }
            Long cleanup = conflictingReturnCleanup(terminal, inferredStackBytes);
            if (cleanup == null) continue;
            JsonObject conflict = prototypeConflict(
                "return-stack-cleanup", signature, signatureSource, count, terminal);
            conflict.addProperty("cleanup_bytes", cleanup);
            conflict.addProperty("inferred_stack_bytes", inferredStackBytes);
            conflict.add("unresolved_assumptions", GSON.toJsonTree(List.of(
                "The cleanup difference does not establish a missing, extra or differently sized source parameter.",
                "Hidden arguments, alternate entry paths and the compiler's calling convention remain unverified."
            )));
            conflicts.add(conflict);
            break;
        }
        return conflicts;
    }

    static Long conflictingReturnCleanup(Instruction instruction, int inferredStackBytes) {
        if (!instruction.getMnemonicString().equalsIgnoreCase("RET") ||
            instruction.getNumOperands() != 1 ||
            !OperandType.isScalar(instruction.getOperandType(0))) return null;
        Object[] objects = instruction.getOpObjects(0);
        if (objects.length != 1 || !(objects[0] instanceof Scalar immediate)) return null;
        long cleanup = immediate.getUnsignedValue();
        return cleanup <= 0xffff && cleanup != inferredStackBytes ? cleanup : null;
    }

    private static Map<Address, Instruction> decodedByAddress(List<Instruction> instructions) {
        Map<Address, Instruction> decoded = new HashMap<>();
        for (Instruction instruction : instructions) decoded.put(instruction.getAddress(), instruction);
        return decoded;
    }

    static List<Instruction> reachablePrototypeInstructions(
        Address entry, List<Instruction> instructions, TaskMonitor monitor
    ) throws Exception {
        Map<Address, Instruction> decoded = decodedByAddress(instructions);
        List<Instruction> reachable = new ArrayList<>();
        Set<Address> visited = new HashSet<>();
        ArrayDeque<Address> pending = new ArrayDeque<>();
        pending.add(entry);
        while (!pending.isEmpty()) {
            monitor.checkCancelled();
            Address address = pending.removeFirst();
            if (!visited.add(address)) continue;
            Instruction instruction = decoded.get(address);
            if (instruction == null) continue;
            reachable.add(instruction);
            queuePrototypeSuccessors(instruction, decoded, pending);
        }
        return reachable;
    }

    private static void queuePrototypeSuccessors(
        Instruction instruction, Map<Address, Instruction> decoded, ArrayDeque<Address> pending
    ) {
        Address fallThrough = instruction.getFallThrough();
        if (fallThrough != null && decoded.containsKey(fallThrough)) pending.add(fallThrough);
        // A call target's instructions belong to a different invocation.
        if (instruction.getFlowType().isCall()) return;
        for (Address destination : instruction.getFlows()) {
            if (decoded.containsKey(destination)) pending.add(destination);
        }
    }

    /** Follow only decoded, reachable instruction edges while the entry EBP frame survives. */
    static FrameRead framedStackRead(
        Address entry,
        List<Instruction> instructions,
        TaskMonitor monitor
    ) throws Exception {
        Map<Address, Instruction> decoded = decodedByAddress(instructions);
        // An owned block below the entry can precede it in the scan, so the
        // prologue is located by address instead of list position.
        Instruction push = decoded.get(entry);
        Instruction frame = push == null ? null : decoded.get(push.getFallThrough());
        if (push == null || frame == null ||
            !push.getMnemonicString().equalsIgnoreCase("PUSH") ||
            !registerOperand(push, 0, "EBP") ||
            !frame.getMnemonicString().equalsIgnoreCase("MOV") ||
            !registerOperand(frame, 0, "EBP") ||
            !registerOperand(frame, 1, "ESP"))
            return null;
        ArrayDeque<Address> pending = new ArrayDeque<>();
        if (frame.getFallThrough() != null) pending.add(frame.getFallThrough());
        Set<Address> visited = new HashSet<>();
        while (!pending.isEmpty()) {
            monitor.checkCancelled();
            Address address = pending.removeFirst();
            if (!visited.add(address)) continue;
            Instruction instruction = decoded.get(address);
            if (instruction == null) continue;
            Long offset = frameArgumentOffset(instruction);
            if (offset != null) return new FrameRead(instruction, offset);
            // The read uses the old EBP value; a write invalidates only successors.
            if (writesFramePointer(instruction)) continue;
            queuePrototypeSuccessors(instruction, decoded, pending);
        }
        return null;
    }

    static record FrameRead(Instruction instruction, long offset) {}

    private static Long frameArgumentOffset(Instruction instruction) {
        PcodeOp[] operations = instruction.getPcode();
        for (int operand = 0; operand < instruction.getNumOperands(); operand++) {
            int type = instruction.getOperandType(operand);
            if (!OperandType.isDynamic(type) && !OperandType.isIndirect(type)) continue;
            Object[] objects = instruction.getOpObjects(operand);
            if (objects.length != 2) continue;
            Register base = null;
            Scalar offset = null;
            for (Object object : objects) {
                if (object instanceof Register register) base = register;
                else if (object instanceof Scalar scalar) offset = scalar;
            }
            // An indexed operand has additional objects, not a direct [EBP + disp].
            if (base == null || offset == null ||
                !base.getName().equalsIgnoreCase("EBP") || offset.getSignedValue() < 8)
                continue;
            PcodeOp[] addressOps = instruction.getPcode(operand);
            if (addressOps.length == 0) continue;
            Varnode pointer = addressOps[addressOps.length - 1].getOutput();
            if (pointer == null) continue;
            for (PcodeOp operation : operations) {
                // LOAD's second input is the address being read. A LOAD from
                // ESP (POP's source) cannot justify a read through [EBP + disp].
                if (operation.getOpcode() == PcodeOp.LOAD &&
                    pointer.equals(operation.getInput(1))) return offset.getSignedValue();
            }
        }
        return null;
    }

    private static boolean writesFramePointer(Instruction instruction) {
        Register frame = instruction.getProgram().getRegister("EBP");
        if (frame == null) return true;
        for (Object object : instruction.getResultObjects()) {
            if (object instanceof Register register &&
                register.getBaseRegister().equals(frame.getBaseRegister())) return true;
        }
        // Include implicit and partial-register writes even when the listing's
        // result-object summary omits them (for example LEAVE or XCHG).
        for (PcodeOp operation : instruction.getPcode()) {
            Varnode output = operation.getOutput();
            if (output == null || !output.isRegister()) continue;
            Register register = instruction.getProgram().getRegister(output);
            if (register != null &&
                register.getBaseRegister().equals(frame.getBaseRegister())) return true;
        }
        return false;
    }

    private static boolean registerOperand(Instruction instruction, int index, String name) {
        if (instruction.getNumOperands() <= index) return false;
        Object[] objects = instruction.getOpObjects(index);
        return objects.length == 1 && objects[0] instanceof Register register &&
            register.getName().equalsIgnoreCase(name);
    }

    private static JsonObject prototypeConflict(
        String kind, String signature, String source, int count, Instruction instruction
    ) {
        JsonObject conflict = new JsonObject();
        conflict.addProperty("kind", kind);
        conflict.addProperty("inferred_signature", signature);
        conflict.addProperty("signature_source", source);
        conflict.addProperty("inferred_parameter_count", count);
        conflict.addProperty("instruction_address", canonicalAddress(instruction.getAddress()));
        conflict.addProperty("instruction", renderInstruction(instruction));
        return conflict;
    }

    private static JsonObject unavailableNativeValueFlow(String reason) {
        JsonObject unavailable = new JsonObject();
        unavailable.addProperty("available", false);
        unavailable.addProperty("reason", reason);
        JsonArray limitations = new JsonArray();
        limitations.add(
            "No p-code operations or def-use relationships were recovered for this procedure."
        );
        unavailable.add("limitations", limitations);
        return unavailable;
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
        Map<Address, List<ClangCaseToken>> caseTokensByTarget
    ) throws Exception {
        JsonObject result = new JsonObject();
        result.addProperty(
            "dispatch_address",
            canonicalAddress(jumpTable.getSwitchAddress())
        );
        JumpTable.LoadTable[] loadTables = jumpTable.getLoadTables();
        RecoveredAArch64RelativeTable recoveredAArch64 =
            recoverAArch64RelativeTable(jumpTable);
        if (recoveredAArch64 != null && loadTables.length > 0) {
            // A decoded table only adds evidence when Ghidra's own load table
            // describes the same bytes; any disagreement keeps Ghidra's view.
            boolean agrees = false;
            for (JumpTable.LoadTable loadTable : loadTables) {
                if (loadTable.getAddress().equals(recoveredAArch64.tableAddress) &&
                    loadTable.getSize() == recoveredAArch64.entrySize &&
                    loadTable.getNum() == recoveredAArch64.mappings.size()) {
                    agrees = true;
                }
            }
            if (!agrees) recoveredAArch64 = null;
        }
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
        if (recoveredAArch64 != null && loadTables.length == 0) {
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
                    "Decoded " + recoveredAArch64.mappings.size() + " " +
                    (recoveredAArch64.signedEntries ? "signed" : "unsigned") +
                    " entries of size " + recoveredAArch64.entrySize + " bytes from " + canonicalAddress(recoveredAArch64.tableAddress) +
                    "; the AArch64 ADRP/ADD table, indexed load, ADR base, ADD" +
                    (recoveredAArch64.offsetShift == 0 ? "" : " LSL #" + recoveredAArch64.offsetShift) +
                    "/BR chain uses a selector bounded by CMP #" + recoveredAArch64.compareImmediate +
                    " and " + recoveredAArch64.guardMnemonic + " on one straight-line path" +
                    (recoveredAArch64.nullTarget == null
                        ? "."
                        : "; zero entries are routed by CBZ to " + canonicalAddress(recoveredAArch64.nullTarget) + ".")
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
        TypedJumpTableCases typedCases = typedJumpTableCases(jumpTable, caseTokensByTarget);
        // Table indices identify the register bounded by CMP. Typed labels may
        // instead identify a selector before normalization (for example, SUB
        // index, selector, #10). Do not merge those distinct value identities.
        if (recoveredAArch64 != null && recoveredAArch64.priorSelectorDefinition != null) {
            typedCases.limitations.add(
                "REA decoded the relative table, but the compared selector has an earlier register definition at " +
                canonicalAddress(recoveredAArch64.priorSelectorDefinition) + "; its table indices are not proven to use the typed switch selector's case values. Ghidra's typed labels are retained and additional case labels remain unknown."
            );
            recoveredAArch64 = null;
        }
        if (recoveredAArch64 != null) {
            for (Map.Entry<Long, Address> typed : typedCases.cases.entrySet()) {
                long value = typed.getKey();
                if (value < 0 || value >= recoveredAArch64.mappings.size()) {
                    typedCases.limitations.add("Typed case labels and decoded table indices do not use a verified common selector; Ghidra's typed labels are retained.");
                    recoveredAArch64 = null;
                    break;
                }
                RecoveredAArch64Mapping decoded = recoveredAArch64.mappings.get((int) value);
                boolean divertedZero = decoded.nullEntry && typed.getValue().equals(recoveredAArch64.unreachableZeroTarget);
                if (!typed.getValue().equals(decoded.targetAddress) && !divertedZero) {
                    typedCases.limitations.add("Typed case evidence and the decoded relative table disagree on a destination; Ghidra's typed labels are retained.");
                    recoveredAArch64 = null;
                    break;
                }
            }
        }
        JsonArray mappings = new JsonArray();
        JsonArray defaultTargets = new JsonArray();
        for (Address target : typedCases.defaults) {
            defaultTargets.add(typedJumpTableTarget(target, jumpTable, "Typed default label"));
        }
        Set<Address> coveredTargets = new HashSet<>(typedCases.cases.values());
        coveredTargets.addAll(typedCases.defaults);
        if (recoveredAArch64 != null && recoveredAArch64.unreachableZeroTarget != null) {
            Address unreachable = recoveredAArch64.unreachableZeroTarget;
            coveredTargets.add(unreachable);
            for (RecoveredAArch64Mapping recovered : recoveredAArch64.mappings) {
                if (recovered.nullEntry && unreachable.equals(typedCases.cases.get((long) recovered.tableIndex))) {
                    typedCases.cases.remove((long) recovered.tableIndex);
                }
            }
            typedCases.limitations.add(
                "Ghidra recovered destination " + canonicalAddress(unreachable) +
                " as the zero-offset decode of the relative table, but the CBZ before the dispatch diverts zero entries to " +
                canonicalAddress(recoveredAArch64.nullTarget) + ", so the indirect branch never reaches it for an in-range case."
            );
        }
        if (recoveredAArch64 != null) {
            for (int index = 0; index < recoveredAArch64.mappings.size(); index += 1) {
                monitor.checkCancelled();
                RecoveredAArch64Mapping recovered = recoveredAArch64.mappings.get(index);
                if (
                    typedCases.unknownTargets.contains(recovered.targetAddress) ||
                    typedCases.ambiguousValues.contains((long) recovered.tableIndex)
                ) continue;
                JsonObject mapping = new JsonObject();
                mapping.addProperty("case_value", recovered.tableIndex);
                String targetAddress = canonicalAddress(recovered.targetAddress);
                mapping.addProperty("target_address", targetAddress);
                mapping.addProperty("confidence", "high");
                JsonArray evidence = new JsonArray();
                evidence.add(
                    inferenceEvidence(
                        "jump-table",
                        "ghidra-instruction-and-memory",
                        "Case value " + recovered.tableIndex + (recoveredAArch64.entrySize == 1 ? " indexes byte " : " indexes halfword at byte offset ") +
                        (recovered.tableIndex * recoveredAArch64.entrySize) + " at " + canonicalAddress(recoveredAArch64.tableAddress) +
                        (recovered.nullEntry
                            ? "; the entry is zero, so the CBZ before the dispatch branches to " + targetAddress + "."
                            : "; the loaded " + (recoveredAArch64.signedEntries ? "signed" : "unsigned") +
                              " entry " + recovered.encodedEntry + " selects a " +
                              (recoveredAArch64.offsetShift == 2 ? "four-byte instruction" : "byte") +
                              " offset from " + canonicalAddress(recoveredAArch64.branchBase) + ", reaching " + targetAddress + ".")
                    )
                );
                mapping.add("evidence", evidence);
                if (!typedCases.cases.containsKey((long) recovered.tableIndex)) {
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
            limitations.add("REA did not verify a supported signed or unsigned byte/halfword relative dispatch chain with exact unsigned bounds and register definitions; unsupported encodings and ambiguous bounds remain unknown.");
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
        Map<Address, List<ClangCaseToken>> tokensByTarget
    ) throws Exception {
        TypedJumpTableCases result = new TypedJumpTableCases();
        Set<Address> seenTargets = new HashSet<>();
        for (Address target : jumpTable.getCases()) {
            if (!seenTargets.add(target)) continue;
            List<ClangCaseToken> bucket = tokensByTarget.get(target);
            if (bucket == null) continue;
            for (ClangCaseToken token : bucket) {
                monitor.checkCancelled();
                PcodeOp operation = token.getPcodeOp();
                if (operation == null || operation.getParent() == null) continue;
                PcodeBlockBasic block = operation.getParent();
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
        private final int tableIndex;
        private final Address targetAddress;
        private final long encodedEntry;
        private final boolean nullEntry;

        private RecoveredAArch64Mapping(
            int tableIndex,
            Address targetAddress,
            long encodedEntry,
            boolean nullEntry
        ) {
            this.tableIndex = tableIndex;
            this.targetAddress = targetAddress;
            this.encodedEntry = encodedEntry;
            this.nullEntry = nullEntry;
        }
    }

    private static final class RecoveredAArch64RelativeTable {
        private final Address tableAddress;
        private final Address branchBase;
        private final int entrySize;
        private final Address priorSelectorDefinition;
        private final boolean signedEntries;
        private final int offsetShift;
        private final String guardMnemonic;
        private final long compareImmediate;
        private final Address nullTarget;
        private final Address unreachableZeroTarget;
        private final List<RecoveredAArch64Mapping> mappings;

        private RecoveredAArch64RelativeTable(
            Address tableAddress,
            Address branchBase,
            int entrySize,
            Address priorSelectorDefinition,
            boolean signedEntries,
            int offsetShift,
            String guardMnemonic,
            long compareImmediate,
            Address nullTarget,
            Address unreachableZeroTarget,
            List<RecoveredAArch64Mapping> mappings
        ) {
            this.tableAddress = tableAddress;
            this.branchBase = branchBase;
            this.entrySize = entrySize;
            this.priorSelectorDefinition = priorSelectorDefinition;
            this.signedEntries = signedEntries;
            this.offsetShift = offsetShift;
            this.guardMnemonic = guardMnemonic;
            this.compareImmediate = compareImmediate;
            this.nullTarget = nullTarget;
            this.unreachableZeroTarget = unreachableZeroTarget;
            this.mappings = mappings;
        }
    }

    private static final Pattern AARCH64_DISPATCH_ADD = Pattern.compile(
        "(?i)^([wx]\\d+),\\s*([wx]\\d+),\\s*([wx]\\d+)(?:,\\s*LSL\\s*#(?:0x)?([0-9a-f]+))?$"
    );
    private static final Pattern AARCH64_TABLE_LOAD = Pattern.compile(
        "(?i)^([wx]\\d+),\\s*\\[([wx]\\d+),\\s*([wx]\\d+)(?:,\\s*(LSL|UXTW)\\s*(?:#(?:0x)?([0-9a-f]+))?)?\\s*\\]$"
    );
    private static final Pattern AARCH64_REGISTER_AND_ADDRESS = Pattern.compile(
        "(?i)^([wx]\\d+),\\s*(0x[0-9a-f]+)$"
    );
    private static final Pattern AARCH64_ADD_IMMEDIATE = Pattern.compile(
        "(?i)^([wx]\\d+),\\s*([wx]\\d+),\\s*#?(0x[0-9a-f]+|[0-9]+)$"
    );
    private static final Pattern AARCH64_COMPARE_IMMEDIATE = Pattern.compile(
        "(?i)^([wx]\\d+),\\s*#?(0x[0-9a-f]+|[0-9]+)$"
    );
    private static final Pattern AARCH64_MOVE_REGISTER = Pattern.compile(
        "(?i)^([wx]\\d+),\\s*([wx]\\d+)$"
    );
    private static final Set<String> AARCH64_FLAG_PRESERVING =
        Set.of("MOV", "ADRP", "ADR", "ADD");

    /**
     * Recover only directly verified AArch64 relative branch tables:
     * ADRP/ADD table base, LDRB/LDRH/LDRSB/LDRSH entry load with an exact
     * index scale, ADR branch base, optional CBZ on the loaded entry, and
     * ADD (byte or LSL #2 scale)/BR, with a selector bounded by CMP #imm and an
     * unsigned B.HI or B.CS/B.HS guard on one straight-line path. Any other
     * instruction sequence keeps its case labels unknown.
     */
    private RecoveredAArch64RelativeTable recoverAArch64RelativeTable(
        JumpTable jumpTable
    ) throws Exception {
        if (!currentProgram.getLanguageID().getIdAsString().startsWith("AARCH64:")) {
            return null;
        }
        Function function = functionAtOrContaining(jumpTable.getSwitchAddress());
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
        if (branchIndex < 1 || !mnemonic(instructions.get(branchIndex)).equals("BR")) {
            return null;
        }
        Set<String> recoveredTargetSet = new HashSet<>();
        for (Address target : jumpTable.getCases()) recoveredTargetSet.add(canonicalAddress(target));
        if (recoveredTargetSet.isEmpty()) return null;
        return matchAArch64RelativeDispatch(
            instructions,
            branchIndex,
            recoveredTargetSet,
            dispatchPathDataReferences(jumpTable)
        );
    }

    private RecoveredAArch64RelativeTable matchAArch64RelativeDispatch(
        List<Instruction> instructions,
        int branchIndex,
        Set<String> recoveredTargetSet,
        List<Address> dataAddresses
    ) throws Exception {
        String branchRegister = normalizedRegister(operands(instructions.get(branchIndex)));

        // ADD Xd, Xn, Xm{, LSL #s}; BR Xd. LSL applies to Xm only.
        Instruction dispatchAdd = instructions.get(branchIndex - 1);
        if (!mnemonic(dispatchAdd).equals("ADD")) return null;
        java.util.regex.Matcher addMatcher = AARCH64_DISPATCH_ADD.matcher(operands(dispatchAdd));
        if (!addMatcher.matches() || !addMatcher.group(1).toLowerCase(Locale.ROOT).startsWith("x")) return null;
        if (!normalizedRegister(addMatcher.group(1)).equals(branchRegister)) return null;
        int offsetShift = addMatcher.group(4) == null ? 0 : Integer.parseInt(addMatcher.group(4), 16);
        if (offsetShift != 0 && offsetShift != 2) return null;
        String firstSource = normalizedRegister(addMatcher.group(2));
        String secondSource = normalizedRegister(addMatcher.group(3));
        if (firstSource.equals(secondSource)) return null;

        // The entry register is the source whose latest definition is the
        // table load; the other source must be defined by ADR.
        int loadIndex = -1;
        String entryRegister = null;
        String baseRegister = null;
        for (String candidate : offsetShift == 0 ? List.of(secondSource, firstSource) : List.of(secondSource)) {
            int writer = latestWriter(instructions, branchIndex - 1, candidate);
            if (writer >= 0 && Set.of("LDRB", "LDRH", "LDRSB", "LDRSH").contains(mnemonic(instructions.get(writer)))) {
                loadIndex = writer;
                entryRegister = candidate;
                baseRegister = candidate.equals(firstSource) ? secondSource : firstSource;
                break;
            }
        }
        if (loadIndex < 0) return null;

        Instruction load = instructions.get(loadIndex);
        String loadMnemonic = mnemonic(load);
        int entrySize = loadMnemonic.endsWith("B") ? 1 : 2;
        boolean signedEntries = loadMnemonic.startsWith("LDRS");
        java.util.regex.Matcher loadMatcher = AARCH64_TABLE_LOAD.matcher(operands(load));
        if (!loadMatcher.matches()) return null;
        // A signed load into a W register sign-extends only to 32 bits; the
        // 64-bit dispatch ADD would then read a zero-extended value.
        if (signedEntries && !loadMatcher.group(1).toLowerCase(Locale.ROOT).startsWith("x")) return null;
        String tableBaseRegister = normalizedRegister(loadMatcher.group(2));
        String indexRegister = normalizedRegister(loadMatcher.group(3));
        boolean wordIndex = loadMatcher.group(3).toLowerCase(Locale.ROOT).startsWith("w");
        String extend = loadMatcher.group(4) == null ? null : loadMatcher.group(4).toUpperCase(Locale.ROOT);
        int indexShift = loadMatcher.group(5) == null ? 0 : Integer.parseInt(loadMatcher.group(5), 16);
        if (wordIndex ? !"UXTW".equals(extend) : "UXTW".equals(extend)) return null;
        if (indexShift != (entrySize == 1 ? 0 : 1)) return null;

        // Only ADR and one CBZ on the entry may sit between load and ADD.
        Address nullTarget = null;
        for (int index = loadIndex + 1; index < branchIndex - 1; index += 1) {
            Instruction instruction = instructions.get(index);
            String name = mnemonic(instruction);
            if (name.equals("ADR")) continue;
            if (name.equals("CBZ") && nullTarget == null) {
                String[] parts = operands(instruction).split(",");
                Address[] flows = instruction.getFlows();
                if (parts.length != 2 || flows.length != 1 ||
                    !normalizedRegister(parts[0]).equals(entryRegister)) return null;
                nullTarget = flows[0];
                continue;
            }
            return null;
        }

        int baseIndex = latestWriter(instructions, branchIndex - 1, baseRegister);
        if (baseIndex < 0 || !mnemonic(instructions.get(baseIndex)).equals("ADR")) return null;
        java.util.regex.Matcher baseMatcher = AARCH64_REGISTER_AND_ADDRESS.matcher(operands(instructions.get(baseIndex)));
        if (!baseMatcher.matches()) return null;
        Address branchBase = addressFromOperand(baseMatcher.group(2));

        int tableAddIndex = latestWriter(instructions, loadIndex, tableBaseRegister);
        if (tableAddIndex < 0 || !mnemonic(instructions.get(tableAddIndex)).equals("ADD")) return null;
        java.util.regex.Matcher tableAddMatcher = AARCH64_ADD_IMMEDIATE.matcher(operands(instructions.get(tableAddIndex)));
        if (!tableAddMatcher.matches() ||
            !normalizedRegister(tableAddMatcher.group(1)).equals(tableBaseRegister) ||
            !normalizedRegister(tableAddMatcher.group(2)).equals(tableBaseRegister)) return null;
        int tablePageIndex = latestWriter(instructions, tableAddIndex, tableBaseRegister);
        if (tablePageIndex < 0 || !mnemonic(instructions.get(tablePageIndex)).equals("ADRP")) return null;
        java.util.regex.Matcher pageMatcher = AARCH64_REGISTER_AND_ADDRESS.matcher(operands(instructions.get(tablePageIndex)));
        if (!pageMatcher.matches() || !normalizedRegister(pageMatcher.group(1)).equals(tableBaseRegister)) return null;
        Address tableAddress = addressFromOperand(pageMatcher.group(2)).add(parseInteger(tableAddMatcher.group(3)));
        if (!currentProgram.getMemory().contains(tableAddress) ||
            (!dataAddresses.isEmpty() && !dataAddresses.contains(tableAddress))) return null;

        // Unsigned guard: CMP Rs, #imm, then B.HI (imm + 1 entries) or
        // B.CS/B.HS (imm entries), with only flag-preserving moves and
        // address arithmetic between the compare and the load.
        int guardIndex = -1;
        for (int index = loadIndex - 1; index >= 0; index -= 1) {
            String name = mnemonic(instructions.get(index));
            if (name.startsWith("B.")) {
                guardIndex = index;
                break;
            }
            if (!AARCH64_FLAG_PRESERVING.contains(name)) return null;
        }
        if (guardIndex < 1) return null;
        Instruction guard = instructions.get(guardIndex);
        String guardMnemonic = mnemonic(guard);
        if (!Set.of("B.HI", "B.CS", "B.HS").contains(guardMnemonic)) return null;
        Address[] guardFlows = guard.getFlows();
        if (guardFlows.length != 1) return null;
        Address defaultTarget = guardFlows[0];
        int compareIndex = -1;
        for (int index = guardIndex - 1; index >= 0; index -= 1) {
            String name = mnemonic(instructions.get(index));
            if (name.equals("CMP")) {
                compareIndex = index;
                break;
            }
            if (!AARCH64_FLAG_PRESERVING.contains(name)) return null;
        }
        if (compareIndex < 0) return null;
        java.util.regex.Matcher compareMatcher = AARCH64_COMPARE_IMMEDIATE.matcher(operands(instructions.get(compareIndex)));
        if (!compareMatcher.matches()) return null;
        String comparedRegister = normalizedRegister(compareMatcher.group(1));
        boolean comparedFullWidth = compareMatcher.group(1).toLowerCase(Locale.ROOT).startsWith("x");
        long compareImmediate = parseInteger(compareMatcher.group(2));
        long entryCountLong = guardMnemonic.equals("B.HI") ? compareImmediate + 1 : compareImmediate;
        if (entryCountLong <= 0 || entryCountLong > 4096) return null;
        int entryCount = (int) entryCountLong;

        // The loaded index must carry the compared value: either the compared
        // register itself, unchanged since CMP, or a MOV copy made after CMP.
        // A W compare bounds only the low 32 bits, so an X index needs a
        // zero-extending W copy; a W index is zero-extended by UXTW.
        int indexWriter = latestWriter(instructions, loadIndex, indexRegister);
        boolean bounded = false;
        if (indexWriter < compareIndex) {
            bounded = indexRegister.equals(comparedRegister) && (wordIndex || comparedFullWidth);
        }
        else if (mnemonic(instructions.get(indexWriter)).equals("MOV")) {
            java.util.regex.Matcher moveMatcher = AARCH64_MOVE_REGISTER.matcher(operands(instructions.get(indexWriter)));
            if (moveMatcher.matches() &&
                normalizedRegister(moveMatcher.group(2)).equals(comparedRegister) &&
                latestWriter(instructions, indexWriter, comparedRegister) < compareIndex) {
                boolean wordCopy = moveMatcher.group(1).toLowerCase(Locale.ROOT).startsWith("w");
                bounded = wordCopy || comparedFullWidth;
            }
        }
        if (!bounded) return null;

        // Every fact above holds only on one straight-line fall-through path
        // with no other entry into the window.
        int windowStart = Math.min(Math.min(tablePageIndex, baseIndex), compareIndex);
        for (int index = windowStart + 1; index <= branchIndex; index += 1) {
            monitor.checkCancelled();
            Instruction previous = instructions.get(index - 1);
            Instruction current = instructions.get(index);
            Address fallThrough = previous.getFallThrough();
            if (fallThrough == null || !fallThrough.equals(current.getAddress())) return null;
            ReferenceIterator incoming = currentProgram.getReferenceManager().getReferencesTo(current.getAddress());
            while (incoming.hasNext()) {
                if (incoming.next().getReferenceType().isFlow()) return null;
            }
        }

        List<RecoveredAArch64Mapping> mappings = new ArrayList<>();
        Set<String> mappedTargets = new HashSet<>();
        for (int tableIndex = 0; tableIndex < entryCount; tableIndex += 1) {
            monitor.checkCancelled();
            Address entry = tableAddress.add((long) tableIndex * entrySize);
            if (!currentProgram.getMemory().contains(entry)) return null;
            long encoded;
            if (entrySize == 1) {
                byte value = currentProgram.getMemory().getByte(entry);
                encoded = signedEntries ? value : value & 0xffL;
            }
            else {
                short value = currentProgram.getMemory().getShort(entry);
                encoded = signedEntries ? value : value & 0xffffL;
            }
            if (encoded == 0 && nullTarget != null) {
                mappings.add(new RecoveredAArch64Mapping(tableIndex, nullTarget, encoded, true));
                continue;
            }
            Address target;
            try {
                target = branchBase.addNoWrap(encoded << offsetShift);
            }
            catch (ghidra.program.model.address.AddressOverflowException overflow) {
                return null;
            }
            String canonicalTarget = canonicalAddress(target);
            if (!recoveredTargetSet.contains(canonicalTarget)) return null;
            mappedTargets.add(canonicalTarget);
            mappings.add(new RecoveredAArch64Mapping(tableIndex, target, encoded, false));
        }
        if (mappedTargets.contains(canonicalAddress(defaultTarget))) return null;
        // Ghidra's recovered destinations must be fully accounted for by the
        // decoded entries, the guard default, and the CBZ null path.
        Set<String> accountedTargets = new HashSet<>(mappedTargets);
        accountedTargets.add(canonicalAddress(defaultTarget));
        if (nullTarget != null) accountedTargets.add(canonicalAddress(nullTarget));
        // Ghidra does not model the CBZ, so it may decode a zero entry as a
        // branch to the base itself. Only a zero entry encodes offset 0, and
        // the CBZ diverts every zero entry, so the BR never reaches the base.
        Address unreachableZeroTarget = null;
        boolean divertedZeroEntry = mappings.stream().anyMatch(mapping -> mapping.nullEntry);
        if (divertedZeroEntry &&
            recoveredTargetSet.contains(canonicalAddress(branchBase)) &&
            !mappedTargets.contains(canonicalAddress(branchBase)) &&
            !branchBase.equals(defaultTarget) &&
            !branchBase.equals(nullTarget)) {
            unreachableZeroTarget = branchBase;
            accountedTargets.add(canonicalAddress(branchBase));
        }
        if (!accountedTargets.containsAll(recoveredTargetSet)) return null;
        int selectorWriter = latestWriter(instructions, compareIndex, comparedRegister);
        return new RecoveredAArch64RelativeTable(
            tableAddress,
            branchBase,
            entrySize,
            selectorWriter < 0 ? null : instructions.get(selectorWriter).getAddress(),
            signedEntries,
            offsetShift,
            guardMnemonic,
            compareImmediate,
            nullTarget,
            unreachableZeroTarget,
            List.copyOf(mappings)
        );
    }

    private static String mnemonic(Instruction instruction) {
        return instruction.getMnemonicString().toUpperCase(Locale.ROOT);
    }

    /** Index of the last instruction before {@code before} that writes {@code register}, or -1. */
    private static int latestWriter(List<Instruction> instructions, int before, String register) {
        for (int index = before - 1; index >= 0; index -= 1) {
            for (Object result : instructions.get(index).getResultObjects()) {
                if (result instanceof Register written &&
                    normalizedRegister(written.getBaseRegister().getName()).equals(register)) {
                    return index;
                }
            }
        }
        return -1;
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
        // The modification number changes with every committed Program edit,
        // so an edit that skipped the explicit invalidation still misses.
        DecompileCacheKey key = new DecompileCacheKey(
            function.getEntryPoint(),
            function instanceof UndefinedFunction,
            currentProgram.getModificationNumber(),
            decompileMaxPayloadMiB
        );
        SoftReference<DecompileResults> retained = decompileResults.get(key);
        DecompileResults reused = retained == null ? null : retained.get();
        if (reused != null) return reused;
        DecompileResults results = takeDecompileAheadForeground(key);
        // A failure or timeout read ahead for this request already spent its
        // deadline, so it is reported rather than started again.
        if (results == null) results = decompiler.decompileFunction(
            function,
            decompileTimeoutSeconds,
            monitor
        );
        if (results.isCancelled()) {
            throw new RequestFailure("decompile_cancelled", "Ghidra decompilation was cancelled");
        }
        // DecompInterface disposes the native process at the limit and starts a
        // fresh one for the next request, so the session stays usable.
        if (results.isTimedOut()) {
            throw new RequestFailure(
                "decompile_timed_out",
                "Ghidra decompilation of " + canonicalAddress(function.getEntryPoint()) +
                " exceeded the " + decompileTimeoutSeconds +
                "-second configured decompilation limit (ghidra.decompile_timeout_seconds; launch seed REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS)"
            );
        }
        if (!results.decompileCompleted()) {
            throw new RequestFailure(
                "decompile_failed",
                "Ghidra decompilation failed: " + diagnosticMessage(results.getErrorMessage()) +
                ". The effective native decompiler payload allowance is " +
                decompiler.getOptions().getMaxPayloadMBytes() +
                " MiB. " + decompilePayloadRecovery()
            );
        }
        // Only a completed decompilation is reusable; failures stay retryable.
        decompileResults.put(key, new SoftReference<>(results));
        return results;
    }

    /**
     * Decompile the functions a workflow will ask for next with several
     * decompiler processes and keep the completed results for those requests.
     * The first selector is the carrying request's own function. That request
     * waits for the window only within its own decompile deadline: siblings
     * still running when it has its result and the deadline has passed are
     * cancelled and left for their own requests, which report any failure as
     * before.
     */
    private void decompileAhead(List<String> selectors) throws Exception {
        clearDecompileAheadForeground();
        if (selectors.size() < 2) return;
        long modification = currentProgram.getModificationNumber();
        List<Function> pending = new ArrayList<>();
        Set<Address> seen = new HashSet<>();
        Address foreground = null;
        for (int index = 0; index < selectors.size(); index++) {
            Function function;
            try {
                function = resolveProcedure(selectors.get(index));
            } catch (RequestFailure unresolved) {
                continue;
            }
            if (function.isExternal() || function.getBody().isEmpty() || !seen.add(function.getEntryPoint())) continue;
            SoftReference<DecompileResults> retained = decompileResults.get(
                new DecompileCacheKey(function.getEntryPoint(), false, modification, decompileMaxPayloadMiB));
            if (retained != null && retained.get() != null) continue;
            if (index == 0) foreground = function.getEntryPoint();
            pending.add(function);
        }
        if (pending.size() < 2) return;
        Integer payloadMiB = decompileMaxPayloadMiB;
        synchronized (decompileAheadLock) {
            if (decompileAheadIdleRelease != null) decompileAheadIdleRelease.cancel(false);
            if (decompileAheadThreads == null) {
                decompileAheadThreads = GThreadPool.getPrivateThreadPool("REA decompile read-ahead");
                // Each worker is a native decompiler process with its own view
                // of the Program, so the worker count bounds memory as well as
                // CPU. Fixed: it shapes how the same results are produced, never
                // what a caller observes, and the host's processor count caps it.
                decompileAheadThreads.setMaxThreadCount(
                    Math.max(1, Math.min(Runtime.getRuntime().availableProcessors(), DECOMPILE_AHEAD_WORKERS)));
            }
            if (decompileAheadWorkers == null) {
                decompileAheadWorkers = new DecompilerCallback<>(currentProgram, prepared -> {
                    prepared.setOptions(decompileOptions(payloadMiB));
                    prepared.toggleCCode(true);
                    prepared.toggleSyntaxTree(true);
                    prepared.toggleJumpLoads(true);
                }) {
                    @Override
                    public DecompileResults process(DecompileResults results, TaskMonitor taskMonitor) {
                        return results;
                    }
                };
            }
            decompileAheadWorkers.setTimeout(decompileTimeoutSeconds);
            try {
                for (DecompileResults results : decompileWindow(pending, foreground)) {
                    Address entry = results.getFunction().getEntryPoint();
                    DecompileCacheKey key = new DecompileCacheKey(entry, false, modification, payloadMiB);
                    if (entry.equals(foreground)) {
                        decompileAheadForegroundKey = key;
                        decompileAheadForeground = results;
                    }
                    if (results.decompileCompleted() && !results.isCancelled() && !results.isTimedOut())
                        decompileResults.put(key, new SoftReference<>(results));
                }
            }
            finally {
                decompileAheadIdleRelease = decompileAheadReaper.schedule(
                    this::releaseIdleDecompileAhead, DECOMPILE_AHEAD_IDLE_MILLIS,
                    TimeUnit.MILLISECONDS);
            }
        }
        monitor.checkCancelled();
    }

    /**
     * Run one window and return the results that finished. With a configured
     * deadline the wait ends once the foreground function has its result
     * (its native deadline bounds that) and the deadline has elapsed.
     */
    private List<DecompileResults> decompileWindow(List<Function> pending, Address foreground) throws Exception {
        ConcurrentQ<Function, DecompileResults> queue = new ConcurrentQBuilder<Function, DecompileResults>()
            .setCollectResults(true)
            .setThreadPool(decompileAheadThreads)
            .setMonitor(monitor)
            .build(decompileAheadWorkers);
        List<DecompileResults> finished = new ArrayList<>();
        try {
            queue.add(pending);
            if (decompileTimeoutSeconds == 0) {
                collectDecompileResults(queue.waitForResults(), finished);
                return finished;
            }
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(decompileTimeoutSeconds);
            boolean foregroundDone = foreground == null;
            while (!queue.isEmpty()) {
                long remaining = deadline - System.nanoTime();
                if (foregroundDone && remaining <= 0) break;
                // Past the deadline only the foreground's own native deadline
                // is still running, so poll briefly until it reports.
                long wait = remaining > 0 ? remaining : TimeUnit.MILLISECONDS.toNanos(50);
                for (DecompileResults results : collectDecompileResults(
                        queue.waitForResults(wait, TimeUnit.NANOSECONDS), finished))
                    if (results.getFunction().getEntryPoint().equals(foreground)) foregroundDone = true;
            }
            // Cancellation reaches each sibling's decompiler through its task
            // monitor. Results that finished meanwhile are kept; cancelled
            // ones stay uncached for their own requests.
            if (!queue.isEmpty()) queue.cancelAllTasks(false);
            collectDecompileResults(queue.waitForResults(), finished);
            return finished;
        }
        finally {
            queue.dispose();
        }
    }

    private static List<DecompileResults> collectDecompileResults(
        Collection<QResult<Function, DecompileResults>> results,
        List<DecompileResults> finished
    ) {
        List<DecompileResults> added = new ArrayList<>();
        for (QResult<Function, DecompileResults> result : results) {
            if (result.hasError() || result.isCancelled()) continue;
            DecompileResults value;
            try {
                value = result.getResult();
            } catch (Exception unavailable) {
                continue;
            }
            if (value == null || value.isCancelled() || value.getFunction() == null) continue;
            added.add(value);
        }
        finished.addAll(added);
        return added;
    }

    private DecompileResults takeDecompileAheadForeground(DecompileCacheKey key) {
        DecompileResults results = key.equals(decompileAheadForegroundKey) ? decompileAheadForeground : null;
        clearDecompileAheadForeground();
        return results;
    }

    private void clearDecompileAheadForeground() {
        decompileAheadForegroundKey = null;
        decompileAheadForeground = null;
    }

    private void releaseIdleDecompileAhead() {
        synchronized (decompileAheadLock) {
            if (decompileAheadWorkers == null) return;
            decompileAheadWorkers.dispose();
            decompileAheadWorkers = null;
            decompileAheadIdleRelease = null;
        }
    }

    /**
     * Pooled decompilers hold native state for the Program and options they
     * opened with, so an edit, an option change or shutdown releases them.
     */
    private void disposeDecompileAhead() {
        clearDecompileAheadForeground();
        synchronized (decompileAheadLock) {
            if (decompileAheadIdleRelease != null) decompileAheadIdleRelease.cancel(false);
            decompileAheadIdleRelease = null;
            if (decompileAheadWorkers == null) return;
            decompileAheadWorkers.dispose();
            decompileAheadWorkers = null;
        }
    }

    /**
     * The function whose body the decompilation covers. Ghidra's decompile
     * callback widens an UndefinedFunction's body to the code it followed, so
     * a reused result keeps the widened function; a fresh lookup of the same
     * entry covers only that entry.
     */
    private static Function decompiledFunction(Function requested, DecompileResults results) {
        return results == null || results.getFunction() == null ? requested : results.getFunction();
    }

    /** Every input a completed decompilation of one Program state depends on. */
    private record DecompileCacheKey(
        Address entry,
        boolean undefinedFunction,
        long programModification,
        Integer maxPayloadMiB
    ) {}

    private String decompilePayloadRecovery() {
        int effective = decompiler.getOptions().getMaxPayloadMBytes();
        if (effective >= MAX_DECOMPILE_PAYLOAD_MIB)
            return "If the diagnostic reports payload exhaustion, the native payload allowance is already at its supported maximum; no higher value is accepted. Use analyze_function for available listing facts or explicitly select a smaller function for decompilation.";
        return "If the diagnostic reports payload exhaustion, in MCP raise ghidra.decompile_max_payload_mib with update_analysis_settings " +
            "(integer MiB from 1 to " + MAX_DECOMPILE_PAYLOAD_MIB +
            ") and repeat the selected operation on this Program without restarting REA. " +
            "For a one-shot CLI retry, set REA_GHIDRA_DECOMPILE_MAX_PAYLOAD_MIB to a larger MiB value in the environment that starts the next rea invocation, then repeat the selected operation; the previous invocation's Program is no longer active. " +
            "Runtime null or an omitted launch seed restores the installed Ghidra default. This does not raise the decompile deadline, high-pcode projection budgets or MCP client limits.";
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

    private JsonObject functionObservation(
            JsonElement value,
            List<String> limitations) {
        JsonObject result = new JsonObject();
        result.add("value", value);
        result.add("limitations", GSON.toJsonTree(limitations));
        return result;
    }

    private static JsonObject facetAvailability(boolean available, String reason) {
        JsonObject result = new JsonObject();
        result.addProperty("available", available);
        if (!available) result.addProperty("reason", reason);
        return result;
    }

    private JsonObject callRelationshipObservation(JsonElement value, CallBoundaryObservation calls)
            throws Exception {
        monitor.checkCancelled();
        JsonObject result = functionObservation(value, calls.limitations());
        result.add("relationship_coverage", callRelationshipCoverage(calls, null));
        return result;
    }

    private JsonObject callRelationshipCoverage(
            CallBoundaryObservation calls, Integer missingCallers) {
        JsonObject coverage = completeResolvedCallCoverage();
        JsonObject discovery = new JsonObject();
        if (missingCallers != null) {
            JsonObject callers = new JsonObject();
            callers.addProperty("status", "unknown");
            callers.addProperty("reason", "Recorded incoming references do not establish additional computed callers elsewhere in the program.");
            discovery.add("callers", callers);
        }
        if (calls != null && !calls.computedCallSites().isEmpty()) {
            JsonObject callees = new JsonObject();
            callees.addProperty("status", "unknown");
            callees.addProperty("reason", computedCallTargetLimitation(calls.computedCallSites()));
            discovery.add("callees", callees);
        }
        if (!discovery.isEmpty()) coverage.add("discovery", discovery);
        Integer omitted = calls == null ? null : calls.unrepresentedCalleeCalls();
        JsonArray directions = new JsonArray();
        if (missingCallers != null && missingCallers > 0) directions.add("callers");
        String callerLimitation = missingCallers != null && missingCallers > 0
            ? "Ghidra's caller inventory omits sources of " + missingCallers +
                " call reference(s) into this function's body." : null;
        if ((calls != null && omitted == null) || (calls == null && missingCallers == null)) {
            coverage.addProperty("status", "unknown");
            String reason = calls == null ? "No call inventory was examined."
                : "The callee inventory was not examined alongside decoded call targets.";
            coverage.addProperty("reason", reason + (callerLimitation == null ? "" : " " + callerLimitation));
            if (calls == null && missingCallers == null) directions.add("callers");
            directions.add("callees");
            coverage.add("limited_directions", directions);
            return qualifyProjectCallCoverage(coverage, calls, missingCallers);
        }
        JsonArray limitations = new JsonArray();
        if (callerLimitation != null) limitations.add(callerLimitation);
        if (omitted != null && omitted > 0) directions.add("callees");
        if (omitted != null && omitted > 0) {
            limitations.add("Ghidra's callee inventory omits targets of " + omitted +
                " call reference(s) or decoded call(s) without destinations.");
        }
        if (!limitations.isEmpty()) {
            coverage.addProperty("status", "partial");
            coverage.add("limitations", limitations);
            coverage.add("limited_directions", directions);
        }
        return qualifyProjectCallCoverage(coverage, calls, missingCallers);
    }

    private JsonObject qualifyProjectCallCoverage(
            JsonObject coverage, CallBoundaryObservation calls, Integer missingCallers) {
        if (!existingProject) return coverage;
        String reason = "The selected project's prior analysis completeness is unknown; " +
            "the recorded call relationships may omit undiscovered callers or callees.";
        String status = coverage.get("status").getAsString();
        // A single-direction read with known omissions is still partial; an
        // unknown project history adds a limitation rather than erasing them.
        if (status.equals("partial") && (calls == null || missingCallers == null)) {
            coverage.getAsJsonArray("limitations").add(reason);
            return coverage;
        }
        if (status.equals("unknown")) reason += " " + coverage.get("reason").getAsString();
        if (status.equals("partial")) {
            for (JsonElement limitation : coverage.getAsJsonArray("limitations"))
                reason += " " + limitation.getAsString();
        }
        JsonArray directions = new JsonArray();
        if (missingCallers != null || (calls == null && missingCallers == null))
            directions.add("callers");
        if (calls != null || (calls == null && missingCallers == null))
            directions.add("callees");
        coverage.addProperty("status", "unknown");
        coverage.addProperty("reason", reason);
        coverage.remove("limitations");
        coverage.add("limited_directions", directions);
        return coverage;
    }

    private static JsonObject completeResolvedCallCoverage() {
        JsonObject coverage = new JsonObject();
        coverage.addProperty("status", "complete");
        JsonArray diagnostics = new JsonArray();
        diagnostics.add(
            "Only resolved Ghidra call references are returned; unresolved computed or indirect calls remain unknown, while function classifications distinguish thunks and externals."
        );
        coverage.add("diagnostics", diagnostics);
        return coverage;
    }

    /** Name a few sites inline; reference reads and call-target queries recover the rest. */
    private static final int NAMED_COMPUTED_CALL_SITES = 4;

    /**
     * A computed call's ReferenceManager targets are static candidates: Ghidra
     * records no proof that other values cannot reach the call, so the callee
     * set stays incomplete while the recorded candidates remain observed.
     */
    private static String computedCallTargetLimitation(List<String> sites) {
        if (sites.isEmpty()) return null;
        int named = Math.min(sites.size(), NAMED_COMPUTED_CALL_SITES);
        String listed = String.join(", ", sites.subList(0, named)) +
            (sites.size() > named ? " and " + (sites.size() - named) + " more" : "");
        return "Ghidra records call reference targets at " + sites.size() +
            " computed call site(s) (" + listed + "); these static references do not establish" +
            " every possible target, so additional callees remain unknown.";
    }

    private boolean unrepresentedCaller(Reference reference, Set<Function> callers) {
        if (!reference.getReferenceType().isCall()) return false;
        Function caller = functionAtOrContaining(reference.getFromAddress());
        return caller == null || !callers.contains(caller);
    }

    private int unrepresentedIncomingCalls(Function function, Set<Function> callers)
            throws Exception {
        int[] omitted = { 0 };
        visitReferences(function, "incoming", reference -> {
            if (unrepresentedCaller(reference, callers)) omitted[0]++;
        });
        return omitted[0];
    }

    private List<String> functionBoundaryLimitations(
            Function function, Iterable<Instruction> instructions)
            throws Exception {
        FunctionBoundaryLimitations boundary = new FunctionBoundaryLimitations(function);
        for (Instruction instruction : instructions) boundary.observe(instruction);
        return boundary.values();
    }

    private CallBoundaryObservation callBoundaryObservation(
            Function function, Iterable<Instruction> instructions, Set<Function> returnedCallees,
            boolean includeUnresolvedSites, List<Reference> observedReferences)
            throws Exception {
        FunctionBoundaryLimitations boundary = new FunctionBoundaryLimitations(function);
        CallBoundaryReferences calls = new CallBoundaryReferences(returnedCallees, includeUnresolvedSites);
        if (observedReferences == null) visitReferences(function, "outgoing", calls::observe);
        else for (Reference reference : observedReferences) {
            monitor.checkCancelled();
            calls.observe(reference);
        }
        List<String> computedCallSites = new ArrayList<>();
        boolean checkRelocations = !loaderInitializedRelocations.isEmpty();
        for (Instruction instruction : instructions) {
            FlowType flow = instruction.getFlowType();
            boolean isCall = flow.isCall();
            Reference[] referencesFrom = (checkRelocations || isCall)
                ? instruction.getReferencesFrom()
                : null;
            boundary.observe(instruction, referencesFrom);
            if (!isCall) continue;
            boolean destination = false;
            for (Reference reference : referencesFrom) {
                if (!reference.getReferenceType().isCall()) continue;
                destination = true;
                break;
            }
            if (!destination) {
                calls.unrepresented++;
                calls.unresolved(instruction.getAddress(),
                    "Instruction decoder identifies a call but ReferenceManager supplies no call destination");
            }
            // The same decoded flow classifies resolve_native_call_targets'
            // mechanism; its recorded targets are candidates, not a closed set.
            else if (flow.isComputed()) computedCallSites.add(canonicalAddress(instruction.getAddress()));
        }
        return new CallBoundaryObservation(boundary.values(),
            returnedCallees == null ? null : calls.unrepresented, calls.unresolvedCalls(),
            List.copyOf(computedCallSites));
    }

    private boolean isX86_32Program() {
        return currentProgram.getDefaultPointerSize() == 4 &&
            "x86".equalsIgnoreCase(currentProgram.getLanguage().getProcessor().toString());
    }

    private final class FunctionBoundaryLimitations {
        private final Function function;
        private final boolean checkLoaderRelocations = !loaderInitializedRelocations.isEmpty();
        private final boolean checkBorlandSeh = isX86_32Program();
        private final List<String> limitations = new ArrayList<>();
        private boolean inferredNoReturnCall;
        private final Set<Address> observedLoaderRelocations = new HashSet<>();
        private Instruction beforePrevious;
        private Instruction previous;

        private FunctionBoundaryLimitations(Function function) {
            this.function = function;
        }

        private void observe(Instruction instruction) throws Exception {
            observe(instruction, checkLoaderRelocations ? instruction.getReferencesFrom() : null);
        }

        private void observe(Instruction instruction, Reference[] referencesFrom) throws Exception {
            monitor.checkCancelled();
            TerminalCall terminal = terminalCall(instruction);
            if (terminal != null) {
                limitations.add(terminal.limitation());
                if (terminal.inferredNoReturn()) inferredNoReturnCall = true;
            }
            if (checkLoaderRelocations && referencesFrom != null) {
                for (Reference reference : referencesFrom) {
                    if (!reference.getReferenceType().isRead()) continue;
                    LoaderInitializedRelocation relocation = loaderInitializedRelocationAt(
                        reference.getToAddress()
                    );
                    if (relocation == null || !observedLoaderRelocations.add(relocation.address()))
                        continue;
                    limitations.add(loaderInitializedRelocationLimitation(relocation));
                }
            }
            if (checkBorlandSeh) {
                if (beforePrevious != null && previous != null) {
                    String seh = borlandSehHandlerLimitation(
                        function, beforePrevious, previous, instruction);
                    if (seh != null) limitations.add(seh);
                }
                beforePrevious = previous;
                previous = instruction;
            }
        }

        private List<String> values() {
            if (!inferredNoReturnCall) return List.copyOf(limitations);
            List<String> result = new ArrayList<>();
            // One consequence and recovery per function, ahead of the call-specific facts so a
            // bounded summary that admits limitations in order keeps it. The text names no
            // address, so those summaries also deduplicate it across functions.
            result.add("A terminal call in this function targets a callee that " +
                "Ghidra's Non-Returning Functions - Discovered analyzer inferred cannot return, so Ghidra " +
                "excluded that call's fall-through from the analyzed body and from the pseudocode and facts " +
                "derived from it. If the callee returns, code reachable only through that fall-through is " +
                "missing from this result. To compare, analyze a fresh import with " +
                "REA_GHIDRA_DISABLED_ANALYZERS='Non-Returning Functions - Discovered'.");
            result.addAll(limitations);
            return result;
        }
    }

    /** A terminal call's limitation and whether its no-return flag was analyzer-inferred. */
    private record TerminalCall(String limitation, boolean inferredNoReturn) {}

    /**
     * Ghidra's Non-Returning Functions - Discovered analyzer bookmarks each entry it marks with
     * this Analysis comment; the name-list Known analyzer uses "Non-Returning Function Identified".
     * A missing bookmark leaves the flag's origin unknown, never declared.
     */
    private boolean discoveredNoReturn(Function target) {
        Function thunked = target.isThunk() ? target.getThunkedFunction(true) : null;
        return hasDiscoveredNoReturnBookmark(target) ||
            (thunked != null && hasDiscoveredNoReturnBookmark(thunked));
    }

    private boolean hasDiscoveredNoReturnBookmark(Function function) {
        Bookmark bookmark = currentProgram.getBookmarkManager().getBookmark(
            function.getEntryPoint(), BookmarkType.ANALYSIS, "Non-Returning Function");
        return bookmark != null && "Non-Returning Function Found".equals(bookmark.getComment());
    }

    private static String loaderInitializedRelocationLimitation(
            LoaderInitializedRelocation relocation) {
        String symbol = relocation.symbolName();
        String symbolDetail = symbol == null || symbol.isBlank()
            ? "an unnamed relocation"
            : "the relocation for " + symbol;
        return "This procedure reads bytes affected by the loader relocation at " +
            canonicalAddress(relocation.address()) + " in non-writable block " +
            relocation.blockName() +
            ", which contains " + symbolDetail +
            "; the file-backed value may differ from the loader-initialized runtime value, " +
            "so constants derived from this location are not authoritative.";
    }

    private String borlandSehHandlerLimitation(
            Function function, Instruction handlerPush, Instruction framePush,
            Instruction frameLink) {
        if (!immediatelyPrecedes(handlerPush, framePush) ||
            !immediatelyPrecedes(framePush, frameLink) ||
            !handlerPush.getMnemonicString().equalsIgnoreCase("PUSH") ||
            handlerPush.getNumOperands() != 1 ||
            !framePush.getMnemonicString().equalsIgnoreCase("PUSH") ||
            framePush.getNumOperands() != 1 ||
            !frameLink.getMnemonicString().equalsIgnoreCase("MOV") ||
            frameLink.getNumOperands() != 2 ||
            !sameFsMemoryOperand(framePush, frameLink) ||
            !hasRegisterOperand(frameLink, 1, "ESP"))
            return null;
        Object[] handlerOperand = handlerPush.getOpObjects(0);
        if (handlerOperand.length != 1 || !(handlerOperand[0] instanceof Scalar scalar) ||
            scalar.bitLength() != 32)
            return null;
        Address handler = currentProgram.getAddressFactory().getDefaultAddressSpace()
            .getAddress(scalar.getUnsignedValue());
        if (function.getBody().contains(handler)) return null;
        return "Ghidra Listing shows a Borland/Delphi-style SEH frame registration at " +
            canonicalAddress(frameLink.getAddress()) + " (push " + canonicalAddress(handler) +
            " followed by fs-segment stack chaining); handler " + canonicalAddress(handler) +
            " lies outside this procedure's body, so callees, strings, and cross-references may omit the handler region.";
    }

    private static boolean immediatelyPrecedes(Instruction first, Instruction second) {
        Address fallThrough = first.getFallThrough();
        return fallThrough != null && fallThrough.equals(second.getAddress());
    }

    private static boolean sameFsMemoryOperand(Instruction first, Instruction second) {
        String firstOperand = normalizedFsMemoryOperand(first);
        String secondOperand = normalizedFsMemoryOperand(second);
        return firstOperand != null && firstOperand.equalsIgnoreCase(secondOperand);
    }

    private static String normalizedFsMemoryOperand(Instruction instruction) {
        String representation = instruction.getDefaultOperandRepresentation(0);
        if (representation.indexOf('[') < 0) return null;
        representation = WHITESPACE_RUN.matcher(
            FS_PTR_PREFIX.matcher(representation).replaceAll("")
        ).replaceAll("");
        return representation.regionMatches(true, 0, "fs:", 0, 3) ? representation : null;
    }

    private static boolean hasRegisterOperand(
            Instruction instruction, int operand, String name) {
        for (Object object : instruction.getOpObjects(operand)) {
            if (object instanceof Register register && register.getName().equalsIgnoreCase(name))
                return true;
        }
        return false;
    }

    private final class CallBoundaryReferences {
        private final Set<Function> returnedCallees;
        private final TreeMap<Address, String> unresolved;
        private int unrepresented;

        CallBoundaryReferences(Set<Function> returnedCallees, boolean includeUnresolvedSites) {
            this.returnedCallees = returnedCallees;
            unresolved = includeUnresolvedSites ? new TreeMap<>() : null;
        }

        void observe(Reference reference) {
            if (!reference.getReferenceType().isCall()) return;
            // Reference identity follows the same containing-function owner as referenceEdge.
            Function target = functionAtOrContaining(reference.getToAddress());
            if (returnedCallees != null && (target == null || !returnedCallees.contains(target)))
                unrepresented++;
            if (target == null) unresolved(reference.getFromAddress(),
                "A call destination has no known containing Ghidra procedure");
        }

        void unresolved(Address address, String reason) {
            if (unresolved != null) unresolved.put(address, reason);
        }

        JsonArray unresolvedCalls() {
            if (unresolved == null) return null;
            JsonArray result = new JsonArray();
            for (var item : unresolved.entrySet()) {
                JsonObject site = new JsonObject();
                site.addProperty("address", canonicalAddress(item.getKey()));
                site.addProperty("reason", item.getValue());
                result.add(site);
            }
            return result;
        }
    }

    private TerminalCall terminalCall(Instruction instruction) {
        if (!instruction.getFlowType().isCall() || !instruction.getFlowType().isTerminal())
            return null;
        boolean inferred = false;
        Address[] destinations = instruction.getFlows();
        StringBuilder limitation = new StringBuilder();
        limitation.append("Ghidra Listing reports a terminal call at ")
            .append(canonicalAddress(instruction.getAddress()));
        if (destinations.length == 0) {
            limitation.append(" with no resolved callee; its no-return basis is unknown.");
        }
        else {
            limitation.append(" to ");
            for (int index = 0; index < destinations.length; index++) {
                if (index > 0) limitation.append(", ");
                Address destination = destinations[index];
                limitation.append(canonicalAddress(destination));
                Function target = currentProgram.getFunctionManager().getFunctionAt(destination);
                if (target == null) {
                    limitation.append(" (callee identity unknown)");
                }
                else {
                    limitation.append(" ").append(procedureName(target));
                    limitation.append(" (external=").append(target.isExternal());
                    limitation.append(", thunk=").append(target.isThunk());
                    limitation.append(", hasNoReturn=").append(target.hasNoReturn()).append(")");
                }
            }
            limitation.append("; fallthrough is excluded by Ghidra's flow model.");
            Function target = destinations.length == 1
                ? currentProgram.getFunctionManager().getFunctionAt(destinations[0])
                : null;
            if (target != null && target.hasNoReturn() && discoveredNoReturn(target)) {
                inferred = true;
                limitation.append(" Ghidra's Non-Returning Functions - Discovered analyzer bookmarked this callee as a non-returning function it found; the flag is an analysis inference, not an independent verification that the callee cannot return.");
            }
            else if (target != null && target.hasNoReturn()) {
                limitation.append(" This records Ghidra's FunctionManager flag, not an independent verification that the callee cannot return.");
            }
            else {
                limitation.append(" The reason for the terminal flow is not established by this observation.");
            }
        }
        return new TerminalCall(limitation.toString(), inferred);
    }

    private static String renderAssembly(List<Instruction> instructions) {
        return String.join("\n", renderAssemblyLines(instructions));
    }

    private static List<String> renderAssemblyLines(List<Instruction> instructions) {
        List<String> result = new ArrayList<>();
        for (Instruction instruction : instructions) {
            result.add(
                canonicalAddress(instruction.getAddress()) + ": " + renderInstruction(instruction)
            );
        }
        return result;
    }

    private static String renderInstruction(Instruction instruction) {
        StringBuilder line = new StringBuilder();
        line.append(instruction.getMnemonicString());
        for (int index = 0; index < instruction.getNumOperands(); index += 1) {
            line.append(index == 0 ? " " : ", ");
            line.append(instruction.getDefaultOperandRepresentation(index));
        }
        return line.toString();
    }

    private List<Reference> collectReferences(
            Function function,
            String direction) throws Exception {
        TreeMap<String, Reference> observed = new TreeMap<>();
        visitReferences(function, direction, reference -> addReference(observed, reference));
        List<Reference> result = new ArrayList<>(observed.values());
        result.sort(REFERENCE_ORDER);
        return result;
    }

    @FunctionalInterface
    private interface ReferenceVisitor {
        void accept(Reference reference) throws Exception;
    }

    private void visitReferences(Function function, String direction, ReferenceVisitor visitor)
            throws Exception {
        // References can target instruction interiors or originate in embedded
        // data. Use actual body ownership, including an external's exact entry.
        AddressSet scope = functionObservationScope(function);
        boolean outgoing = direction.equals("outgoing");
        AddressIterator addresses = outgoing
            ? currentProgram.getReferenceManager().getReferenceSourceIterator(scope, true)
            : currentProgram.getReferenceManager().getReferenceDestinationIterator(scope, true);
        while (addresses.hasNext()) {
            monitor.checkCancelled();
            Address address = addresses.next();
            if (outgoing) {
                visitObservedReferencesFrom(address, visitor);
            }
            else {
                visitObservedReferencesTo(address, visitor);
            }
        }
    }

    private void visitObservedReferencesFrom(Address address, ReferenceVisitor visitor)
            throws Exception {
        for (Reference reference : currentProgram.getReferenceManager().getReferencesFrom(address)) {
            monitor.checkCancelled();
            visitObservedReference(reference, visitor);
        }
    }

    private void visitObservedReferencesTo(Address address, ReferenceVisitor visitor)
            throws Exception {
        ReferenceIterator references = currentProgram.getReferenceManager().getReferencesTo(address);
        while (references.hasNext()) {
            monitor.checkCancelled();
            visitObservedReference(references.next(), visitor);
        }
    }

    private static void visitObservedReference(Reference reference, ReferenceVisitor visitor)
            throws Exception {
        if (!reference.isEntryPointReference()) visitor.accept(reference);
    }

    private static void addReference(TreeMap<String, Reference> observed, Reference reference) {
        String key = canonicalAddress(reference.getFromAddress()) + "\u0000" +
            canonicalAddress(reference.getToAddress()) + "\u0000" +
            reference.getReferenceType().getName() + "\u0000" +
            reference.getOperandIndex() + "\u0000" +
            reference.isPrimary();
        observed.putIfAbsent(key, reference);
    }

    private static AddressSet functionObservationScope(Function function) {
        AddressSet scope = new AddressSet(function.getBody());
        scope.add(function.getEntryPoint());
        return scope;
    }

    private JsonArray referenceEdges(List<Reference> references) {
        return referenceEdges(references, new HashMap<>(), new HashMap<>());
    }

    private JsonArray referenceEdges(
        List<Reference> references,
        Map<Address, Function> resolvedFunctions,
        Map<Address, JsonObject> procedureIdentities
    ) {
        JsonArray result = new JsonArray();
        for (Reference reference : references) {
            result.add(referenceEdge(reference, resolvedFunctions, procedureIdentities));
        }
        return result;
    }

    private JsonObject referenceEdge(
        Reference reference,
        Map<Address, Function> resolvedFunctions,
        Map<Address, JsonObject> procedureIdentities
    ) {
        JsonObject result = new JsonObject();
        Address fromAddress = reference.getFromAddress();
        Address toAddress = reference.getToAddress();
        result.addProperty("source_address", canonicalAddress(fromAddress));
        result.addProperty("target_address", canonicalAddress(toAddress));
        Function source = cachedFunctionAtOrContaining(resolvedFunctions, fromAddress);
        Function target = cachedFunctionAtOrContaining(resolvedFunctions, toAddress);
        result.add(
            "source_procedure",
            source == null ? JsonNull.INSTANCE : cachedProcedureIdentity(procedureIdentities, source)
        );
        result.add(
            "target_procedure",
            target == null ? JsonNull.INSTANCE : cachedProcedureIdentity(procedureIdentities, target)
        );
        result.add("kind", referenceKind(reference));
        return result;
    }

    private Function cachedFunctionAtOrContaining(Map<Address, Function> cache, Address address) {
        if (!cache.containsKey(address)) {
            Function resolved = functionAtOrContaining(address);
            cache.put(address, resolved);
            return resolved;
        }
        return cache.get(address);
    }

    private static JsonObject cachedProcedureIdentity(Map<Address, JsonObject> cache, Function function) {
        Address entry = function.getEntryPoint();
        JsonObject identity = cache.get(entry);
        if (identity == null) {
            identity = procedureIdentity(function);
            cache.put(entry, identity);
        }
        return identity;
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

    private JsonArray comments(Function function) throws Exception {
        Listing listing = currentProgram.getListing();
        AddressSet scope = functionObservationScope(function);
        AddressIterator addresses = listing.getCommentAddressIterator(scope, true);
        TreeMap<String, JsonObject> observed = new TreeMap<>();
        while (addresses.hasNext()) {
            monitor.checkCancelled();
            Address address = addresses.next();
            for (CommentType type : CommentType.values()) {
                String text = listing.getComment(type, address);
                if (text == null || text.isEmpty()) {
                    continue;
                }
                String kind = type == CommentType.EOL ? "inline" : "comment";
                JsonObject item = new JsonObject();
                item.addProperty("address", canonicalAddress(address));
                item.addProperty("kind", kind);
                item.addProperty("text", text);
                String key = canonicalAddress(address) + "\u0000" +
                    kind + "\u0000" + type.name() + "\u0000" + text;
                observed.put(key, item);
            }
        }
        JsonArray result = new JsonArray();
        observed.values().forEach(result::add);
        return result;
    }

    private JsonArray referencedStrings(List<Reference> references) throws Exception {
        TreeMap<String, JsonObject> observed = new TreeMap<>();
        Map<Address, String[]> resolved = new HashMap<>();
        Listing listing = currentProgram.getListing();
        for (Reference reference : references) {
            monitor.checkCancelled();
            Address target = reference.getToAddress();
            String[] entry;
            if (resolved.containsKey(target)) {
                entry = resolved.get(target);
            } else {
                Data data = listing.getDefinedDataContaining(target);
                String value = data != null && data.hasStringValue()
                    ? StringDataInstance.getStringDataInstance(data).getStringValue()
                    : null;
                entry = value == null ? null : new String[] { canonicalAddress(data.getAddress()), value };
                resolved.put(target, entry);
            }
            if (entry == null) {
                continue;
            }
            String sourceAddress = canonicalAddress(reference.getFromAddress());
            JsonObject item = new JsonObject();
            item.addProperty("address", entry[0]);
            item.addProperty("value", entry[1]);
            item.addProperty("source_address", sourceAddress);
            String key = entry[0] + "\u0000" + entry[1] + "\u0000" + sourceAddress;
            observed.put(key, item);
        }
        JsonArray result = new JsonArray();
        observed.values().forEach(result::add);
        return result;
    }

    private JsonArray referencedNames(List<Reference> references) throws Exception {
        TreeMap<String, JsonObject> observed = new TreeMap<>();
        Map<Address, String> resolved = new HashMap<>();
        SymbolTable symbolTable = currentProgram.getSymbolTable();
        for (Reference reference : references) {
            monitor.checkCancelled();
            Address target = reference.getToAddress();
            String name;
            if (resolved.containsKey(target)) {
                name = resolved.get(target);
            } else {
                Symbol symbol = symbolTable.getPrimarySymbol(target);
                name = symbol == null ? null : symbol.getName(true);
                resolved.put(target, name);
            }
            if (name == null) {
                continue;
            }
            String targetAddress = canonicalAddress(target);
            String sourceAddress = canonicalAddress(reference.getFromAddress());
            JsonObject item = new JsonObject();
            item.addProperty("address", targetAddress);
            item.addProperty("value", name);
            item.addProperty("source_address", sourceAddress);
            String key = targetAddress + "\u0000" + name + "\u0000" + sourceAddress;
            observed.put(key, item);
        }
        JsonArray result = new JsonArray();
        observed.values().forEach(result::add);
        return result;
    }

    private boolean swiftProgram() {
        if (swiftProgramCached != null) return swiftProgramCached;
        for (MemoryBlock block : currentProgram.getMemory().getBlocks()) {
            String name = block.getName();
            if (name.startsWith("__swift5_") || name.startsWith("swift5_")) {
                swiftProgramCached = Boolean.TRUE;
                return true;
            }
        }
        swiftProgramCached = Boolean.FALSE;
        return false;
    }

    /**
     * Swift passes a String as two words: small literals carry their bytes in the words and
     * immortal large literals carry their count and a biased pointer to the bytes. Ghidra keeps
     * neither as a data reference, so decode constant pairs where Swift consumes them: argument
     * and return registers at calls, tail calls and returns, and both registers of one STP.
     * The canonical empty string is a small literal with a zero count.
     */
    private SwiftStringLiteralDecode swiftStringLiterals(Function function) throws Exception {
        return swiftStringLiterals(function, new SwiftLiteralBudget());
    }

    // An explicit budget makes capacity omissions deterministic in producer tests.
    private SwiftStringLiteralDecode swiftStringLiterals(
        Function function,
        SwiftLiteralBudget budget
    ) throws Exception {
        Register[] registers = new Register[31];
        for (int index = 0; index < registers.length; index++) {
            registers[index] = currentProgram.getRegister("x" + index);
        }
        TreeMap<String, JsonObject> observed = new TreeMap<>();
        TreeMap<String, JsonObject> omitted = new TreeMap<>();
        Map<String, Boolean> selectedValues = new HashMap<>();
        SymbolicPropogator propagator = new SymbolicPropogator(currentProgram, false);
        propagator.flowConstants(function.getEntryPoint(), function.getBody(), new ContextEvaluatorAdapter() {
            @Override
            public boolean evaluateContextBefore(VarnodeContext context, Instruction instruction) {
                // Returning true ends only the current flow, so every queued flow checks the shared stop.
                if ((monitor != null && monitor.isCancelled()) || budget.stopped()) return true;
                FlowType flow = instruction.getFlowType();
                boolean unconditionalJump = flow.isJump() && !flow.isConditional();
                Address[] flowTargets = unconditionalJump ? instruction.getFlows() : null;
                boolean unresolvedJump = unconditionalJump && flowTargets.length == 0;
                for (Register[] pair : swiftStringPairs(function, instruction, registers, flow, unconditionalJump, flowTargets)) {
                    Long word = registerConstant(context, pair[0]);
                    Long object = registerConstant(context, pair[1]);
                    if (word == null || object == null) continue;
                    SwiftLiteralLayout layout = swiftLiteralLayout(word, object);
                    if (layout == null) continue;
                    // A selected word can combine with a path-dependent ordinary move. Cache the
                    // provenance question per site/register, charging retained cache state to the
                    // same dossier budget before allocating it.
                    boolean selected = false;
                    boolean provenanceOverCapacity = false;
                    for (Register register : pair) {
                        String provenanceKey = canonicalAddress(instruction.getAddress()) + "\u0000" +
                            register.getBaseRegister().getName();
                        Boolean value = selectedValues.get(provenanceKey);
                        if (value == null) {
                            if (!budget.takeState()) {
                                provenanceOverCapacity = true;
                                break;
                            }
                            value = selectedValue(function, instruction, register);
                            if (monitor != null && monitor.isCancelled()) return true;
                            selectedValues.put(provenanceKey, value);
                        }
                        if (value) {
                            selected = true;
                            break;
                        }
                    }
                    if (selected) continue;
                    // Forks can reach one site with different constants, so the words are part of the key.
                    String key = canonicalAddress(instruction.getAddress()) + "\u0000" + pair[0].getName() +
                        "\u0000" + pair[1].getName() + "\u0000" + Long.toUnsignedString(word, 16) +
                        "\u0000" + Long.toUnsignedString(object, 16);
                    if (observed.containsKey(key) || omitted.containsKey(key)) continue;
                    // Every record draws on the budget; the first one that does not fit is kept as an
                    // omission and decoding stops, so later sites are never examined.
                    String value = layout.smallValue();
                    boolean overCapacity = provenanceOverCapacity || !budget.take(layout.byteLength());
                    if (!overCapacity && value == null) {
                        try {
                            value = swiftLargeLiteralText(layout);
                        } catch (OutOfMemoryError exhausted) {
                            overCapacity = true;
                        }
                    }
                    if (value == null && !overCapacity) continue;
                    JsonObject item = overCapacity
                        ? swiftStringOmission(layout, word, object)
                        : swiftStringItem(value, layout, word, object);
                    if (unresolvedJump && !overCapacity)
                        item = swiftStringOmission(layout, word, object, "unresolved_jump");
                    item.addProperty("source_address", canonicalAddress(instruction.getAddress()));
                    JsonArray pairRegisters = new JsonArray();
                    pairRegisters.add(pair[0].getName());
                    pairRegisters.add(pair[1].getName());
                    item.add("registers", pairRegisters);
                    (overCapacity || unresolvedJump ? omitted : observed).put(key, item);
                    if (overCapacity) {
                        budget.stop();
                        return true;
                    }
                }
                return false;
            }
        }, false, monitor);
        monitor.checkCancelled();
        JsonArray literals = new JsonArray();
        observed.values().forEach(literals::add);
        JsonArray omissions = new JsonArray();
        omitted.values().forEach(omissions::add);
        return new SwiftStringLiteralDecode(literals, omissions);
    }

    private static List<Register[]> swiftStringPairs(
        Function function,
        Instruction instruction,
        Register[] registers,
        FlowType flow,
        boolean unconditionalJump,
        Address[] flowTargets
    ) {
        if (instruction.getMnemonicString().equals("stp")) {
            Register first = instruction.getRegister(0);
            Register second = instruction.getRegister(1);
            if (first != null && second != null && first.getBitLength() == 64 && second.getBitLength() == 64) {
                return List.<Register[]>of(new Register[] {first, second});
            }
            return List.of();
        }
        boolean returns = false;
        if (flow.isTerminal()) {
            for (PcodeOp operation : instruction.getPcode()) {
                if (operation.getOpcode() == PcodeOp.RETURN) {
                    returns = true;
                    break;
                }
            }
        }
        // A jump is a proven tail call only when it has resolved targets and all leave the
        // body. For unresolved targetless jumps, candidate literals remain unknown omissions.
        boolean tailCall = false;
        if (unconditionalJump && flowTargets.length > 0) {
            tailCall = true;
            AddressSetView body = function.getBody();
            for (Address target : flowTargets) {
                if (body.contains(target)) {
                    tailCall = false;
                    break;
                }
            }
        }
        boolean unresolvedJump = unconditionalJump && flowTargets.length == 0;
        if (!flow.isCall() && !returns && !tailCall && !unresolvedJump) return List.of();
        // A String occupies two consecutive registers among x0-x7, or x0 and x1 when returned.
        int lastFirstRegister = returns ? 0 : 6;
        List<Register[]> pairs = new ArrayList<>(lastFirstRegister + 1);
        for (int index = 0; index <= lastFirstRegister; index++) {
            pairs.add(new Register[] {registers[index], registers[index + 1]});
        }
        return pairs;
    }

    private static Long registerConstant(VarnodeContext context, Register register) {
        Varnode value = context.getRegisterVarnodeValue(register);
        return value != null && context.isConstant(value) ? value.getOffset() : null;
    }

    // Search every predecessor path for the reaching definitions, following register copies,
    // since a select copied into an argument register or defined before a branch forks just as
    // independently as one written there directly.
    private boolean selectedValue(Function function, Instruction use, Register register) {
        ArrayDeque<Instruction> instructions = new ArrayDeque<>();
        ArrayDeque<Register> targets = new ArrayDeque<>();
        Set<String> visited = new HashSet<>();
        for (Instruction predecessor : predecessors(function, use)) {
            instructions.push(predecessor);
            targets.push(register.getBaseRegister());
        }
        while (!instructions.isEmpty()) {
            if (monitor != null && monitor.isCancelled()) return false;
            Instruction instruction = instructions.pop();
            Register target = targets.pop();
            if (!visited.add(canonicalAddress(instruction.getAddress()) + "\u0000" + target.getName())) continue;
            boolean defines = false;
            for (Object result : instruction.getResultObjects()) {
                if (result instanceof Register written && written.getBaseRegister().equals(target)) defines = true;
            }
            Register next = target;
            if (defines) {
                PcodeOp[] operations = instruction.getPcode();
                for (PcodeOp operation : operations) {
                    if (operation.getOpcode() == PcodeOp.CBRANCH && operation.getInput(0).isConstant()) return true;
                }
                Register source = copiedRegister(operations);
                if (source == null) continue;
                next = source.getBaseRegister();
            }
            for (Instruction predecessor : predecessors(function, instruction)) {
                instructions.push(predecessor);
                targets.push(next);
            }
        }
        return false;
    }

    private List<Instruction> predecessors(Function function, Instruction instruction) {
        List<Instruction> result = new ArrayList<>();
        Address from = instruction.getFallFrom();
        if (from != null) {
            Instruction previous = currentProgram.getListing().getInstructionAt(from);
            if (previous != null) result.add(previous);
        }
        for (Reference reference : currentProgram.getReferenceManager().getReferencesTo(instruction.getAddress())) {
            if (!reference.getReferenceType().isFlow() || reference.getReferenceType().isCall()) continue;
            if (!function.getBody().contains(reference.getFromAddress())) continue;
            Instruction source = currentProgram.getListing().getInstructionAt(reference.getFromAddress());
            if (source != null) result.add(source);
        }
        return result;
    }

    private Register copiedRegister(PcodeOp[] operations) {
        if (operations.length != 1) return null;
        int opcode = operations[0].getOpcode();
        Varnode input = operations[0].getInput(0);
        if ((opcode != PcodeOp.COPY && opcode != PcodeOp.INT_ZEXT) || input == null || !input.isRegister()) return null;
        return currentProgram.getRegister(input);
    }

    /** Validate the ABI layout of a pair; a small literal is decoded here, a large one only located. */
    private SwiftLiteralLayout swiftLiteralLayout(long word, long object) {
        int discriminator = (int) (object >>> 60);
        if (discriminator == 0xE || discriminator == 0xA) {
            int count = (int) ((object >>> 56) & 0xF);
            byte[] bytes = new byte[15];
            for (int index = 0; index < 8; index++) bytes[index] = (byte) (word >>> (8 * index));
            for (int index = 0; index < 7; index++) bytes[8 + index] = (byte) (object >>> (8 * index));
            for (int index = count; index < bytes.length; index++) {
                if (bytes[index] != 0) return null;
            }
            // Count zero is the canonical empty string (object 0xE000000000000000, word 0).
            String value = swiftStringText(bytes, count, discriminator == 0xE);
            return value == null ? null : new SwiftLiteralLayout("small", null, count, true, value);
        }
        int flags = (int) (word >>> 60);
        long count = word & 0xFFFFFFFFFFFFL;
        // Immortal literals: ASCII and NFC or neither, tail allocated, with a pointer biased by 32.
        if ((object >>> 56) != 0x80 || (flags != 0xD && flags != 0x1) || ((word >>> 48) & 0xFFF) != 0) {
            return null;
        }
        try {
            Address address = currentProgram.getAddressFactory().getDefaultAddressSpace()
                .getAddress((object & 0x00FFFFFFFFFFFFFFL) + 0x20);
            MemoryBlock block = currentProgram.getMemory().getBlock(address);
            // The bytes and their terminator must lie in one initialized, non-executable block,
            // and Java arrays bound one read.
            if (block == null || !block.isInitialized() || block.isExecute() ||
                count >= block.getEnd().subtract(address) + 1 || count >= Integer.MAX_VALUE) {
                return null;
            }
            return new SwiftLiteralLayout("large", address, count, flags == 0xD, null);
        } catch (Exception unaddressable) {
            return null;
        }
    }

    private String swiftLargeLiteralText(SwiftLiteralLayout layout) {
        int count = (int) layout.byteLength();
        byte[] bytes = new byte[count + 1];
        try {
            if (currentProgram.getMemory().getBytes(layout.address(), bytes) != bytes.length) return null;
        } catch (Exception unreadable) {
            return null;
        }
        return bytes[count] == 0 ? swiftStringText(bytes, count, layout.ascii()) : null;
    }

    /**
     * Every literal record of one dossier draws on half of the heap that was free when decoding
     * began. Text is charged at the worst case per UTF-8 byte: two bytes of UTF-16 text, then up
     * to six escaped JSON characters ("\\u0000") held as UTF-16 in Gson's growing writer buffer
     * (up to twice its length), again in the returned String, and once more as UTF-8 on the
     * socket. Each record also pays a fixed cost for its map key, JSON members, addresses, words
     * and their serialized form, so many empty or small literals are bounded too. Retained
     * provenance-cache entries draw on that same fixed-state allowance.
     */
    private static final class SwiftLiteralBudget {
        private static final long BYTES_PER_LITERAL_BYTE = 2 + 6 * 2 * 2 + 6 * 2 + 6;
        private static final long BYTES_PER_RECORD = 4096;
        private long remaining;
        private boolean stopped;

        SwiftLiteralBudget() {
            Runtime runtime = Runtime.getRuntime();
            remaining = Math.max(0, (runtime.maxMemory() - runtime.totalMemory() + runtime.freeMemory()) / 2);
        }

        SwiftLiteralBudget(long remaining) {
            if (remaining < 0) throw new IllegalArgumentException("Swift literal budget must be nonnegative");
            this.remaining = remaining;
        }

        boolean takeState() {
            if (remaining < BYTES_PER_RECORD) return false;
            remaining -= BYTES_PER_RECORD;
            return true;
        }

        boolean take(long bytes) {
            if (remaining < BYTES_PER_RECORD ||
                bytes > (remaining - BYTES_PER_RECORD) / BYTES_PER_LITERAL_BYTE) {
                return false;
            }
            remaining -= BYTES_PER_RECORD + bytes * BYTES_PER_LITERAL_BYTE;
            return true;
        }

        void stop() {
            stopped = true;
        }

        boolean stopped() {
            return stopped;
        }
    }

    // Swift String values may contain any scalar, including controls; JSON escapes them.
    private static String swiftStringText(byte[] bytes, int length, boolean ascii) {
        if (length < 0 || length > bytes.length) return null;
        for (int index = 0; index < length; index++) {
            if (ascii && bytes[index] < 0) return null;
        }
        try {
            return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes, 0, length)).toString();
        } catch (CharacterCodingException invalid) {
            return null;
        }
    }

    private static JsonObject swiftStringOmission(SwiftLiteralLayout layout, long word, long object) {
        return swiftStringOmission(layout, word, object, "capacity");
    }

    private static JsonObject swiftStringOmission(
        SwiftLiteralLayout layout,
        long word,
        long object,
        String reason
    ) {
        JsonObject item = new JsonObject();
        item.addProperty("representation", layout.representation());
        if (layout.address() == null) {
            item.add("address", JsonNull.INSTANCE);
        } else {
            item.addProperty("address", canonicalAddress(layout.address()));
        }
        item.addProperty("byte_length", layout.byteLength());
        item.addProperty("reason", reason);
        item.add("words", swiftStringWords(word, object));
        return item;
    }

    private static JsonObject swiftStringItem(
        String value,
        SwiftLiteralLayout layout,
        long word,
        long object
    ) {
        JsonObject item = new JsonObject();
        item.addProperty("value", value);
        item.addProperty("representation", layout.representation());
        if (layout.address() == null) {
            item.add("address", JsonNull.INSTANCE);
        } else {
            item.addProperty("address", canonicalAddress(layout.address()));
        }
        item.add("words", swiftStringWords(word, object));
        return item;
    }

    private static JsonArray swiftStringWords(long word, long object) {
        JsonArray words = new JsonArray();
        words.add("0x" + Long.toUnsignedString(word, 16));
        words.add("0x" + Long.toUnsignedString(object, 16));
        return words;
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

    private static void writeNameEntries(JsonWriter out, List<NameEntry> entries) throws IOException {
        out.beginArray();
        for (NameEntry entry : entries) {
            writeResultItem(out, entry.address(), entry.value(), "symbol", entry.facts(), null, List.of());
        }
        out.endArray();
    }

    private static void writeProcedureEntries(JsonWriter out, List<ProcedureEntry> entries) throws IOException {
        out.beginArray();
        for (ProcedureEntry entry : entries) {
            writeResultItem(out, entry.address(), entry.value(), "procedure", entry.facts(), entry.symbol(), List.of());
        }
        out.endArray();
    }

    private static void writeMatchedProcedures(JsonWriter out, List<MatchedProcedure> matches) throws IOException {
        out.beginArray();
        for (MatchedProcedure match : matches) {
            ProcedureEntry entry = match.entry();
            writeResultItem(
                out,
                entry.address(),
                entry.value(),
                "procedure",
                entry.facts(),
                entry.symbol(),
                match.matchedAliases()
            );
        }
        out.endArray();
    }

    private static void writeStringEntries(JsonWriter out, List<StringEntry> entries) throws IOException {
        out.beginArray();
        for (StringEntry entry : entries) {
            writeResultItem(out, entry.address(), entry.value(), "string", entry.facts(), null, List.of());
        }
        out.endArray();
    }

    private static <T> List<T> sliceAtAddress(
        List<T> sortedEntries,
        java.util.function.Function<T, Address> addressExtractor,
        Address target
    ) {
        int low = 0;
        int high = sortedEntries.size();
        while (low < high) {
            int mid = (low + high) >>> 1;
            if (addressExtractor.apply(sortedEntries.get(mid)).compareTo(target) < 0) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        if (low >= sortedEntries.size() || !addressExtractor.apply(sortedEntries.get(low)).equals(target)) {
            return List.of();
        }
        int end = low + 1;
        while (end < sortedEntries.size() && addressExtractor.apply(sortedEntries.get(end)).equals(target)) {
            end++;
        }
        return sortedEntries.subList(low, end);
    }

    private static void writeResultItem(
        JsonWriter out,
        Address address,
        String value,
        String factsName,
        InventoryFacts facts,
        SymbolFacts symbol,
        List<String> matchedAliases
    ) throws IOException {
        out.beginObject();
        out.name("address").value(canonicalAddress(address));
        out.name("value").value(value);
        if (factsName != null) {
            out.name(factsName);
            facts.writeJson(out);
        }
        if (symbol != null) {
            out.name("symbol");
            symbol.writeJson(out);
        }
        if (!matchedAliases.isEmpty()) {
            out.name("matched_aliases");
            out.beginArray();
            for (String alias : matchedAliases) {
                out.value(alias);
            }
            out.endArray();
        }
        out.endObject();
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
        Symbol symbol = function.getSymbol();
        result.add("symbol", symbol == null ? JsonNull.INSTANCE : symbolMetadata(symbol));
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
        return canonicalHexOffset(
            address.getAddressSpace(),
            "0x" + Long.toHexString(address.getOffset())
        );
    }

    private static String canonicalOffset(AddressSpace space, BigInteger offset) {
        return canonicalHexOffset(space, "0x" + offset.toString(16));
    }

    private static String canonicalHexOffset(AddressSpace space, String value) {
        if (space.equals(sessionDefaultAddressSpace)) {
            return value;
        }
        return encodeAddressSpace(space.getName()) + ":" + value;
    }

    private Address requireAddress(JsonObject params, String name) {
        return parseReaAddress(requireString(params, name));
    }

    private static boolean isExplicitReaAddress(String value) {
        if (value.regionMatches(true, 0, "0x", 0, 2) &&
            isHexadecimal(value, 2, value.length()))
            return true;
        int separator = value.toLowerCase(Locale.ROOT).lastIndexOf(":0x");
        if (separator <= 0 || !isHexadecimal(value, separator + 3, value.length()))
            return false;
        // Classify the encoded space iteratively. A repeated regex alternation
        // can exhaust Java's stack on a long ordinary symbol name.
        for (int index = 0; index < separator; index++) {
            char item = value.charAt(index);
            if ((item >= 'A' && item <= 'Z') ||
                (item >= 'a' && item <= 'z') ||
                (item >= '0' && item <= '9') ||
                item == '.' || item == '_' || item == '~' || item == '-')
                continue;
            if (item != '%' || index + 2 >= separator ||
                !isHexadecimal(value, index + 1, index + 3))
                return false;
            index += 2;
        }
        return true;
    }

    private static boolean isHexadecimal(String value, int start, int end) {
        if (start >= end) return false;
        for (int index = start; index < end; index++) {
            char item = value.charAt(index);
            if (!((item >= '0' && item <= '9') ||
                  (item >= 'a' && item <= 'f') ||
                  (item >= 'A' && item <= 'F')))
                return false;
        }
        return true;
    }

    private Address parseReaAddress(String value) {
        Address address = tryParseAddress(value);
        if (address == null) {
            throw new RequestFailure("invalid_request", "Unknown or invalid Ghidra address: " + value);
        }
        return address;
    }

    private Address tryParseAddress(String value) {
        try {
            String spaceName = null;
            String offset = value;
            int separator = value.toLowerCase(Locale.ROOT).lastIndexOf(":0x");
            if (separator >= 0) {
                spaceName = decodeAddressSpace(value.substring(0, separator));
                offset = value.substring(separator + 3);
            }
            else if (value.startsWith("0x") || value.startsWith("0X")) {
                offset = value.substring(2);
            }
            if (!isHexadecimal(offset, 0, offset.length())) {
                return null;
            }
            AddressSpace space = spaceName == null
                ? currentProgram.getAddressFactory().getDefaultAddressSpace()
                : currentProgram.getAddressFactory().getAddressSpace(spaceName);
            if (space == null) return null;
            Address address = space.getAddress(offset);
            BigInteger requestedOffset = new BigInteger(offset, 16);
            BigInteger parsedOffset = new BigInteger(Long.toUnsignedString(address.getOffset()));
            if (!requestedOffset.equals(parsedOffset))
                throw new RequestFailure("invalid_request",
                    "Ghidra address offset cannot be represented without truncation in space " +
                    space.getName() + ": requested " + value + ", parsed " + canonicalAddress(address));
            return address;
        }
        catch (RequestFailure failure) { throw failure; }
        catch (Exception exception) {
            return null;
        }
    }

    private static String encodeAddressSpace(String value) {
        for (int index = 0; index < value.length(); index++) {
            char item = value.charAt(index);
            if (!((item >= 'A' && item <= 'Z') ||
                  (item >= 'a' && item <= 'z') ||
                  (item >= '0' && item <= '9') ||
                  item == '.' || item == '_' || item == '~' || item == '-')) {
                return encodeAddressSpaceBytes(value);
            }
        }
        return value;
    }

    private static String encodeAddressSpaceBytes(String value) {
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
        return NORMALIZED_SYMBOL_TYPES.computeIfAbsent(symbol.getSymbolType(), type -> {
            String value = EDGE_UNDERSCORES.matcher(
                NON_ALNUM_RUN.matcher(type.toString().toLowerCase(Locale.ROOT)).replaceAll("_")
            ).replaceAll("");
            return value.isEmpty() ? "unknown" : value;
        });
    }

    private static SymbolFacts symbolFacts(Symbol symbol) {
        return new SymbolFacts(
            symbol.isPrimary(),
            symbol.isDynamic(),
            symbol.isExternal(),
            normalizedSymbolType(symbol),
            normalizedSource(symbol.getSource())
        );
    }

    private static JsonObject symbolMetadata(Symbol symbol) {
        return symbolFacts(symbol).toJson();
    }

    private static String normalizedSource(SourceType source) {
        return NORMALIZED_SOURCES.computeIfAbsent(source, item -> item.name().toLowerCase(Locale.ROOT));
    }

    private static ValueMatcher literalMatcher(String pattern) {
        return nonLeafMatcher(value -> value.contains(pattern));
    }

    private static boolean containsNonAscii(String value) {
        for (int index = 0; index < value.length(); index++) {
            if (value.charAt(index) > 127) return true;
        }
        return false;
    }

    private static void requireAsciiCandidate(String asciiPattern) {
        for (int index = 0; index < asciiPattern.length(); index++) {
            if (asciiPattern.charAt(index) > 127) {
                throw new RequestFailure("invalid_request", "ASCII candidate contains a non-ASCII character");
            }
        }
    }

    private static boolean containsFoldedAscii(String value, String asciiPattern) {
        int patternLength = asciiPattern.length();
        if (patternLength == 0) {
            return true;
        }
        int valueLength = value.length();
        if (valueLength < patternLength) {
            return false;
        }
        char firstTarget = asciiPattern.charAt(0);
        int limit = valueLength - patternLength;
        for (int index = 0; index <= limit; index++) {
            if (foldAsciiCandidateChar(value.charAt(index)) != firstTarget) {
                continue;
            }
            int matched = 1;
            while (matched < patternLength &&
                   foldAsciiCandidateChar(value.charAt(index + matched)) == asciiPattern.charAt(matched)) {
                matched++;
            }
            if (matched == patternLength) {
                return true;
            }
        }
        return false;
    }

    // REA's host owns ECMAScript /iu simple case folding. Across all 1,114,112
    // Unicode code points, only U+017F (ſ -> s) and U+212A (K -> k) fold to
    // ASCII. When asciiPattern is null, the pattern has a non-ASCII char without
    // an ASCII fold, so only source strings containing non-ASCII (and any
    // required ASCII-foldable substring) stay eligible.
    private static ValueMatcher literalCandidateMatcher(String asciiPattern, String asciiSubstring) {
        if (asciiPattern == null) {
            if (asciiSubstring == null || asciiSubstring.isEmpty()) {
                return nonLeafMatcher(value -> containsNonAscii(value));
            }
            requireAsciiCandidate(asciiSubstring);
            return nonLeafMatcher(value ->
                containsFoldedAscii(value, asciiSubstring) && containsNonAscii(value)
            );
        }
        requireAsciiCandidate(asciiPattern);
        if (asciiPattern.isEmpty()) {
            return nonLeafMatcher(value -> true);
        }
        return nonLeafMatcher(value -> containsFoldedAscii(value, asciiPattern));
    }

    private interface StringCheck {
        boolean test(String value);
    }

    private static ValueMatcher nonLeafMatcher(StringCheck check) {
        return new ValueMatcher() {
            @Override
            public boolean matches(String value) {
                return check.test(value);
            }

            @Override
            public boolean requiresLeafCheck() {
                return false;
            }
        };
    }

    private static int foldAsciiCandidateChar(char ch) {
        if (ch <= 127) {
            return (ch >= 'A' && ch <= 'Z') ? ch + ('a' - 'A') : ch;
        }
        if (ch == '\u017F') return 's';
        if (ch == '\u212A') return 'k';
        return -1;
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
            // Java wraps compiler stack exhaustion in PatternSyntaxException
            // without retaining its cause. This producer reason is not bad syntax.
            if (exception.getDescription().equals("Stack overflow during pattern compilation"))
                throw regexStackExhausted(expression, "compiling");
            throw new RequestFailure("invalid_regex_pattern", "Invalid regex pattern " + expression + ": " + exception.getDescription() + " at index " + exception.getIndex());
        }
        catch (StackOverflowError exhausted) {
            throw regexStackExhausted(expression, "compiling");
        }
        return value -> {
            try {
                return pattern.matcher(value).find();
            }
            catch (StackOverflowError exhausted) {
                throw regexStackExhausted(expression, "matching");
            }
        };
    }

    // The host queue owns session lifetime, including concurrent cancellation.
    private static RequestFailure regexStackExhausted(String expression, String stage) {
        return new RequestFailure("regex_stack_exhausted",
            "Ghidra's Java regex engine exhausted its stack while " + stage +
            " pattern " + expression + ".");
    }

    private static SessionDescriptor readDescriptor(Path path) throws IOException {
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new IllegalArgumentException("REA session descriptor is invalid");
        }
        JsonElement parsed = JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8));
        Set<String> keys = new HashSet<>(DESCRIPTOR_KEYS);
        if (parsed.isJsonObject() && parsed.getAsJsonObject().has("analysis_extensions"))
            keys.add("analysis_extensions");
        if (parsed.isJsonObject() && parsed.getAsJsonObject().has("decompile_timeout_seconds"))
            keys.add("decompile_timeout_seconds");
        if (parsed.isJsonObject() && parsed.getAsJsonObject().has("existing_project"))
            keys.add("existing_project");
        if (parsed.isJsonObject() && parsed.getAsJsonObject().has("entry_context_register"))
            keys.add("entry_context_register");
        JsonObject object = requireObject(parsed, keys);
        List<String> entryContext = List.of();
        if (object.has("entry_context_register")) {
            String register = requireString(object, "entry_context_register");
            if (!ENTRY_CONTEXT_REGISTERS.contains(register))
                throw new IllegalArgumentException("REA session descriptor is invalid");
            entryContext = List.of(register);
        }
        int decompileTimeout = 0;
        if (object.has("decompile_timeout_seconds")) {
            decompileTimeout = requireInteger(object, "decompile_timeout_seconds");
            if (decompileTimeout < 1 || decompileTimeout > MAX_DECOMPILE_TIMEOUT_SECONDS)
                throw new IllegalArgumentException("REA session descriptor is invalid");
        }
        return new SessionDescriptor(
            requireString(object, "transport"),
            requireString(object, "endpoint_path"),
            requireString(object, "token"),
            requireString(object, "run_id"),
            requireSha256(object, "target_sha256"),
            requireString(object, "provider_version"),
            requireString(object, "profile_digest"),
            object.has("analysis_extensions") ? object.getAsJsonArray("analysis_extensions") : new JsonArray(),
            decompileTimeout,
            object.has("existing_project") && requireBoolean(object, "existing_project"),
            entryContext
        );
    }

    private static Request parseRequest(String line, String expectedToken) {
        JsonElement parsed = JsonParser.parseString(line);
        Set<String> keys = new HashSet<>(REQUEST_KEYS);
        if (parsed.isJsonObject() && parsed.getAsJsonObject().has("decompile_timeout_seconds"))
            keys.add("decompile_timeout_seconds");
        if (parsed.isJsonObject() && parsed.getAsJsonObject().has("value_flow_limits"))
            keys.add("value_flow_limits");
        if (parsed.isJsonObject() && parsed.getAsJsonObject().has("decompile_max_payload_mib"))
            keys.add("decompile_max_payload_mib");
        if (parsed.isJsonObject() && parsed.getAsJsonObject().has("decompile_read_ahead"))
            keys.add("decompile_read_ahead");
        JsonObject object = requireObject(parsed, keys);
        DecompilePayload payload = null;
        if (object.has("decompile_max_payload_mib")) {
            Integer payloadMiB = null;
            if (!object.get("decompile_max_payload_mib").isJsonNull()) {
                payloadMiB = requireInteger(object, "decompile_max_payload_mib");
                if (payloadMiB < 1 || payloadMiB > MAX_DECOMPILE_PAYLOAD_MIB)
                    throw new IllegalArgumentException("Invalid per-request native decompiler payload limit");
            }
            payload = new DecompilePayload(payloadMiB);
        }
        ValueFlowLimits flowLimits = defaultValueFlowLimits();
        if (object.has("value_flow_limits")) {
            JsonObject limits = requireObject(object.get("value_flow_limits"),
                Set.of("max_operations", "max_inputs_per_operation", "max_edges"));
            int operations = requireInteger(limits, "max_operations");
            int inputs = requireInteger(limits, "max_inputs_per_operation");
            int edges = requireInteger(limits, "max_edges");
            if (operations < 1 || inputs < 1 || edges < 1)
                throw new IllegalArgumentException("Invalid per-request value-flow limits");
            flowLimits = new ValueFlowLimits(operations, inputs, edges);
        }
        Integer timeout = null;
        if (object.has("decompile_timeout_seconds")) {
            JsonElement value = object.get("decompile_timeout_seconds");
            timeout = value.isJsonNull() ? 0 : requireInteger(object, "decompile_timeout_seconds");
            if (!value.isJsonNull() && (timeout < 1 || timeout > MAX_DECOMPILE_TIMEOUT_SECONDS))
                throw new IllegalArgumentException("Invalid per-request decompile deadline");
        }
        int id = requireInteger(object, "id");
        if (id <= 0 || !constantTimeEquals(requireString(object, "token"), expectedToken)) {
            throw new IllegalArgumentException("Bridge request authentication failed");
        }
        JsonElement params = object.get("params");
        if (params == null || !params.isJsonObject()) {
            throw new IllegalArgumentException("Bridge request parameters are invalid");
        }
        List<String> readAhead = new ArrayList<>();
        if (object.has("decompile_read_ahead")) {
            JsonElement selectors = object.get("decompile_read_ahead");
            if (!selectors.isJsonArray())
                throw new IllegalArgumentException("Invalid decompile read-ahead");
            for (JsonElement selector : selectors.getAsJsonArray()) {
                if (!selector.isJsonPrimitive() || !selector.getAsJsonPrimitive().isString())
                    throw new IllegalArgumentException("Invalid decompile read-ahead");
                // The hint is advisory: selectors past one window are ignored.
                if (readAhead.size() < DECOMPILE_AHEAD_WINDOW) readAhead.add(selector.getAsString());
            }
        }
        return new Request(id, requireString(object, "method"), params.getAsJsonObject(), timeout, payload, flowLimits,
            List.copyOf(readAhead));
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
            throw new RequestFailure("not_found", "Unknown Ghidra Program identity: " + document + "; active program: " + currentProgram.getName());
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

    private static void writeStreamingSuccess(BufferedWriter writer, int id, StreamingResult result)
            throws IOException {
        JsonWriter out = GSON.newJsonWriter(new SurrogateEscapingWriter(writer));
        out.setSerializeNulls(true);
        out.beginObject();
        out.name("id").value(id);
        out.name("ok").value(true);
        out.name("result");
        result.write(out);
        out.endObject();
        out.flush();
        writer.newLine();
        writer.flush();
    }

    /** Reserved response id for a failure not tied to one parsed request. */
    private static final int CONNECTION_FAILURE_ID = 0;

    private static void writeFailure(
            BufferedWriter writer,
            int id,
            String code,
            String message) throws IOException {
        writeFailure(writer, id, new RequestFailure(code, message));
    }

    private static void writeFailure(BufferedWriter writer, int id, RequestFailure failure) throws IOException {
        JsonObject error = new JsonObject();
        error.addProperty("code", failure.code);
        error.addProperty("message", failure.getMessage());
        if (failure.candidates != null) error.add("candidates", failure.candidates);
        if (failure.requiredValue != null) error.addProperty("required_value", failure.requiredValue);
        JsonObject response = new JsonObject();
        response.addProperty("id", id);
        response.addProperty("ok", false);
        response.add("error", error);
        writeResponse(writer, response);
    }

    private static void writeResponse(BufferedWriter writer, JsonObject response) throws IOException {
        try {
            GSON.toJson(response, new SurrogateEscapingWriter(writer));
        }
        catch (JsonIOException exception) {
            if (exception.getCause() instanceof IOException ioException) {
                throw ioException;
            }
            throw exception;
        }
        writer.newLine();
        writer.flush();
    }

    // Gson leaves UTF-16 surrogates literal. Stream directly to the socket
    // writer while escaping surrogates so large replies avoid multi-x heap copies.
    private static final class SurrogateEscapingWriter extends Writer {
        private static final char[] HEX_DIGITS = "0123456789abcdef".toCharArray();
        private final BufferedWriter delegate;
        private final char[] surrogateEscape = { '\\', 'u', '0', '0', '0', '0' };

        private SurrogateEscapingWriter(BufferedWriter delegate) {
            this.delegate = delegate;
        }

        private void writeSurrogateEscape(char ch) throws IOException {
            surrogateEscape[2] = HEX_DIGITS[(ch >>> 12) & 0xf];
            surrogateEscape[3] = HEX_DIGITS[(ch >>> 8) & 0xf];
            surrogateEscape[4] = HEX_DIGITS[(ch >>> 4) & 0xf];
            surrogateEscape[5] = HEX_DIGITS[ch & 0xf];
            delegate.write(surrogateEscape, 0, 6);
        }

        @Override
        public void write(int ch) throws IOException {
            char value = (char) ch;
            if (Character.isSurrogate(value)) {
                writeSurrogateEscape(value);
            } else {
                delegate.write(ch);
            }
        }

        @Override
        public void write(char[] cbuf, int off, int len) throws IOException {
            java.util.Objects.checkFromIndexSize(off, len, cbuf.length);
            int start = off;
            int end = off + len;
            for (int index = off; index < end; index++) {
                char ch = cbuf[index];
                if (!Character.isSurrogate(ch)) continue;
                if (index > start) {
                    delegate.write(cbuf, start, index - start);
                }
                writeSurrogateEscape(ch);
                start = index + 1;
            }
            if (end > start) {
                delegate.write(cbuf, start, end - start);
            }
        }

        @Override
        public void write(String str, int off, int len) throws IOException {
            java.util.Objects.checkFromIndexSize(off, len, str.length());
            int start = off;
            int end = off + len;
            for (int index = off; index < end; index++) {
                char ch = str.charAt(index);
                if (!Character.isSurrogate(ch)) continue;
                if (index > start) {
                    delegate.write(str, start, index - start);
                }
                writeSurrogateEscape(ch);
                start = index + 1;
            }
            if (end > start) {
                delegate.write(str, start, end - start);
            }
        }

        @Override
        public Writer append(CharSequence csq) throws IOException {
            if (csq == null) {
                delegate.write("null");
            } else if (csq instanceof String str) {
                write(str, 0, str.length());
            } else {
                append(csq, 0, csq.length());
            }
            return this;
        }

        @Override
        public Writer append(CharSequence csq, int start, int end) throws IOException {
            if (csq == null) {
                delegate.write("null", start, end - start);
            } else if (csq instanceof String str) {
                write(str, start, end - start);
            } else {
                java.util.Objects.checkFromToIndex(start, end, csq.length());
                for (int index = start; index < end; index++) {
                    write(csq.charAt(index));
                }
            }
            return this;
        }

        @Override
        public void flush() {
            // Caller issues writer.newLine() + writer.flush() once at frame end.
        }

        @Override
        public void close() {
            // Socket writer outlives one response frame.
        }
    }

    private static String safeMessage(Exception exception) {
        String message = exception.getMessage();
        return message == null || message.isBlank() ? "operation failed" : message;
    }

    private interface ValueMatcher {
        boolean matches(String value);

        default boolean requiresLeafCheck() {
            return true;
        }
    }

    private interface StreamingResult {
        void write(JsonWriter out) throws IOException;
    }

    private interface InventoryFacts {
        JsonObject toJson();
        void writeJson(JsonWriter out) throws IOException;
    }

    private static int compareInventory(
        Address leftAddress,
        String leftValue,
        InventoryFacts leftFacts,
        Address rightAddress,
        String rightValue,
        InventoryFacts rightFacts
    ) {
        int cmp = leftAddress.compareTo(rightAddress);
        if (cmp != 0) return cmp;
        cmp = leftValue.compareTo(rightValue);
        if (cmp != 0) return cmp;
        if (leftFacts.equals(rightFacts)) return 0;
        return GSON.toJson(leftFacts.toJson()).compareTo(GSON.toJson(rightFacts.toJson()));
    }

    private static final Comparator<NameEntry> NAME_ORDER = (left, right) ->
        compareInventory(left.address(), left.value(), left.facts(), right.address(), right.value(), right.facts());
    private static final Comparator<ProcedureEntry> PROCEDURE_ORDER = (left, right) ->
        compareInventory(left.address(), left.value(), left.facts(), right.address(), right.value(), right.facts());
    private static final Comparator<StringEntry> STRING_ORDER = (left, right) ->
        compareInventory(left.address(), left.value(), left.facts(), right.address(), right.value(), right.facts());
    private static final Comparator<Reference> REFERENCE_ORDER =
        Comparator.comparing(Reference::getFromAddress)
            .thenComparing(Reference::getToAddress)
            .thenComparing(reference -> reference.getReferenceType().getName())
            .thenComparingInt(Reference::getOperandIndex)
            .thenComparing(Reference::isPrimary);

    private record SymbolFacts(
        boolean primary,
        boolean dynamic,
        boolean external,
        String type,
        String source
    ) implements InventoryFacts {
        @Override
        public JsonObject toJson() {
            JsonObject facts = new JsonObject();
            facts.addProperty("primary", primary);
            facts.addProperty("dynamic", dynamic);
            facts.addProperty("external", external);
            facts.addProperty("type", type);
            facts.addProperty("source", source);
            return facts;
        }

        @Override
        public void writeJson(JsonWriter out) throws IOException {
            out.beginObject();
            out.name("primary").value(primary);
            out.name("dynamic").value(dynamic);
            out.name("external").value(external);
            out.name("type").value(type);
            out.name("source").value(source);
            out.endObject();
        }
    }

    private record ProcedureFacts(
        boolean external,
        boolean thunk,
        Address thunkTarget
    ) implements InventoryFacts {
        @Override
        public JsonObject toJson() {
            JsonObject facts = new JsonObject();
            facts.addProperty("external", external);
            facts.addProperty("thunk", thunk);
            if (thunkTarget == null) {
                facts.add("thunk_target", JsonNull.INSTANCE);
            } else {
                facts.addProperty("thunk_target", canonicalAddress(thunkTarget));
            }
            return facts;
        }

        @Override
        public void writeJson(JsonWriter out) throws IOException {
            out.beginObject();
            out.name("external").value(external);
            out.name("thunk").value(thunk);
            out.name("thunk_target");
            if (thunkTarget == null) {
                out.nullValue();
            } else {
                out.value(canonicalAddress(thunkTarget));
            }
            out.endObject();
        }
    }

    private record StringFacts(
        String encoding,
        boolean missingNullTerminator,
        int byteLength
    ) implements InventoryFacts {
        @Override
        public JsonObject toJson() {
            JsonObject facts = new JsonObject();
            facts.addProperty("encoding", encoding);
            facts.addProperty(
                "termination",
                missingNullTerminator ? "missing" : "present_or_not_required"
            );
            facts.addProperty("byte_length", byteLength);
            return facts;
        }

        @Override
        public void writeJson(JsonWriter out) throws IOException {
            out.beginObject();
            out.name("encoding").value(encoding);
            out.name("termination").value(
                missingNullTerminator ? "missing" : "present_or_not_required"
            );
            out.name("byte_length").value(byteLength);
            out.endObject();
        }
    }

    private record MatchedProcedure(ProcedureEntry entry, List<String> matchedAliases) {}
    private record NameEntry(Address address, String value, SymbolFacts facts) {}
    private record ProcedureAlias(String leaf, String qualified, boolean leafIsSuffix) {
        ProcedureAlias(String leaf, String qualified) {
            this(leaf, qualified, qualified.endsWith(leaf));
        }
    }
    private record ProcedureEntry(
        Function function,
        Address address,
        String value,
        String leafName,
        boolean leafIsSuffix,
        List<ProcedureAlias> aliases,
        ProcedureFacts facts,
        SymbolFacts symbol
    ) {
        ProcedureEntry(
            Function function,
            Address address,
            String value,
            String leafName,
            List<ProcedureAlias> aliases,
            ProcedureFacts facts,
            SymbolFacts symbol
        ) {
            this(function, address, value, leafName, value.endsWith(leafName), aliases, facts, symbol);
        }
    }
    private record StringEntry(Address address, String value, StringFacts facts) {}
    private record AddressNameRequest(String inputAddress, Address address, String name) {}
    private record AddressNameDestination(long namespace, String leaf) {}
    private record AddressNameTarget(Address address, Namespace namespace, String leaf) {
        AddressNameDestination destination() {
            return new AddressNameDestination(namespace.getID(), leaf);
        }
    }
    private record AddressNameConflict(Namespace namespace, String leaf, List<Address> requesters, List<Address> holders) {}
    private record AddressNameFailure(String reason, AddressNameConflict conflict) {}
    private record LoaderInitializedRelocation(
        Address address, long lengthInAddressableUnits, String blockName, String symbolName
    ) {
        private boolean contains(Address candidate) {
            if (!candidate.hasSameAddressSpace(address) || candidate.compareTo(address) < 0)
                return false;
            long displacement = candidate.subtract(address);
            return displacement >= 0 && displacement < lengthInAddressableUnits;
        }
    }
    private record ProcedureNameMatch(boolean primary, List<String> aliases) {
        boolean matched() {
            return primary || !aliases.isEmpty();
        }
    }
    private record FunctionAnalysisObservation(JsonObject dossier, List<String> limitations, JsonObject relationshipCoverage, boolean decompilerFailed) {}
    private record CallBoundaryObservation(List<String> limitations, Integer unrepresentedCalleeCalls, JsonArray unresolvedCalls, List<String> computedCallSites) {}
    private record SwiftStringLiteralDecode(JsonArray literals, JsonArray omissions) {}
    private record SwiftLiteralLayout(
        String representation,
        Address address,
        long byteLength,
        boolean ascii,
        String smallValue
    ) {}
    private record InstructionScan(List<Instruction> instructions, boolean truncated) {}
    private record SessionDescriptor(
        String transport,
        String endpointPath,
        String token,
        String runId,
        String targetSha256,
        String providerVersion,
        String profileDigest,
        JsonArray analysisExtensions,
        int decompileTimeoutSeconds,
        boolean existingProject,
        List<String> entryContextRegisters
    ) {}
    private static ValueFlowLimits defaultValueFlowLimits() {
        return new ValueFlowLimits(DEFAULT_HIGH_PCODE_OPS, DEFAULT_HIGH_PCODE_INPUTS_PER_OP, DEFAULT_HIGH_PCODE_DEF_USE_EDGES);
    }
    private record ValueFlowLimits(int maxOperations, int maxInputsPerOperation, int maxEdges) {}
    /**
     * A request's decompiler payload selection. A null selection means the
     * request carried no decompiler options; a null limit inside one selects
     * the installed Ghidra default.
     */
    private record DecompilePayload(Integer mebibytes) {}

    private record Request(int id, String method, JsonObject params, Integer decompileTimeoutSeconds, DecompilePayload decompilePayload, ValueFlowLimits valueFlowLimits,
        List<String> decompileReadAhead) {}

    private static final class RequestFailure extends RuntimeException {
        private final String code;
        /** Every matching selector candidate, for an ambiguous selection only. */
        private final JsonArray candidates;

        RequestFailure(String code, String message) {
            this(code, message, null);
        }

        /** The measured value a per-call control must admit, for a bounded refusal only. */
        private final Integer requiredValue;

        RequestFailure(String code, String message, JsonArray candidates) {
            this(code, message, candidates, null);
        }

        RequestFailure(String code, String message, JsonArray candidates, Integer requiredValue) {
            super(message);
            this.code = code;
            this.candidates = candidates;
            this.requiredValue = requiredValue;
        }

        /** The same failure, its facts kept, with context before its message. */
        RequestFailure prefixed(String context) {
            return new RequestFailure(code, context + getMessage(), candidates, requiredValue);
        }
    }

}
