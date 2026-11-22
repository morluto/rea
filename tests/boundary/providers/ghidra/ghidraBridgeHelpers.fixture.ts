import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

const BRIDGE_SOURCE_PATH = resolve("bridge/ghidra/ReaGhidraBridge.java");
const JAVA_BINARY = process.platform === "win32" ? "java.exe" : "java";
const JAVAC_BINARY = process.platform === "win32" ? "javac.exe" : "javac";

export interface JdkToolchain {
  readonly javac: string;
  readonly java: string;
  readonly versionLine: string;
}

export interface CompiledBridgeProbe {
  readonly classesDir: string;
  readonly jdk: JdkToolchain;
}

const candidateToolchains = (): readonly { javac: string; java: string }[] => {
  const candidates: { javac: string; java: string }[] = [];
  const envHomes = [
    process.env.JAVA_HOME,
    process.env.JAVA_HOME_25_X64,
    process.env.JAVA_HOME_25_ARM64,
    process.env.JAVA_HOME_21_X64,
    process.env.JAVA_HOME_21_ARM64,
  ];
  for (const home of envHomes) {
    if (home !== undefined && home !== "") {
      candidates.push({
        javac: join(home, "bin", JAVAC_BINARY),
        java: join(home, "bin", JAVA_BINARY),
      });
    }
  }
  const systemBins =
    process.platform === "darwin"
      ? [
          "/opt/homebrew/opt/openjdk@21/bin",
          "/opt/homebrew/opt/openjdk/bin",
          "/usr/local/opt/openjdk@21/bin",
          "/usr/local/opt/openjdk/bin",
        ]
      : process.platform === "linux"
        ? [
            "/usr/lib/jvm/java-21-openjdk-amd64/bin",
            "/usr/lib/jvm/java-21-openjdk-arm64/bin",
            "/usr/lib/jvm/java-25-openjdk-amd64/bin",
            "/usr/lib/jvm/java-25-openjdk-arm64/bin",
          ]
        : [];
  for (const bin of systemBins) {
    candidates.push({
      javac: join(bin, JAVAC_BINARY),
      java: join(bin, JAVA_BINARY),
    });
  }
  candidates.push({ javac: JAVAC_BINARY, java: JAVA_BINARY });
  return candidates;
};

const probeToolchain = async (
  javac: string,
  java: string,
): Promise<JdkToolchain | undefined> => {
  const isBareCommand = !javac.includes("/") && !javac.includes("\\");
  if (!isBareCommand && (!existsSync(javac) || !existsSync(java))) {
    return undefined;
  }
  try {
    const javacVersion = await execute(javac, ["-version"], { timeout: 5_000 });
    const banner = `${javacVersion.stdout}\n${javacVersion.stderr}`.trim();
    const major = Number(/^javac (\d+)/mu.exec(banner)?.[1]);
    if (!Number.isInteger(major) || major < 21) {
      return undefined;
    }
    await execute(java, ["-version"], { timeout: 5_000 });
    return { javac, java, versionLine: banner };
  } catch {
    return undefined;
  }
};

/** Locate a JDK 21+ compiler and runtime, returning undefined when absent. */
export const discoverJdk21Toolchain = async (): Promise<
  JdkToolchain | undefined
> => {
  const seen = new Set<string>();
  for (const candidate of candidateToolchains()) {
    const key = `${candidate.javac}\0${candidate.java}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const toolchain = await probeToolchain(candidate.javac, candidate.java);
    if (toolchain !== undefined) return toolchain;
  }
  return undefined;
};

/** Encode a UTF-16 JS string (including lone surrogates) as comma-separated hex code units. */
export const encodeUtf16Hex = (value: string): string => {
  const units: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    units.push(value.charCodeAt(index).toString(16).padStart(4, "0"));
  }
  return units.join(",");
};

const extractBridgeSlice = (
  source: string,
  startMarker: string,
  endMarker: string,
): string => {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Missing bridge start marker: ${startMarker}`);
  }
  const end = source.indexOf(endMarker, start);
  if (end < 0) {
    throw new Error(`Missing bridge end marker: ${endMarker}`);
  }
  return source.slice(start, end);
};

const extractRequestFailureSlice = (source: string): string => {
  const startMarker =
    "    private static final class RequestFailure extends RuntimeException {";
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Missing bridge start marker: ${startMarker}`);
  }
  const lastBrace = source.lastIndexOf("}");
  if (lastBrace <= start) {
    throw new Error("Missing closing brace in ReaGhidraBridge.java");
  }
  return source.slice(start, lastBrace);
};

const JAVA_HEADER = String.raw`
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

public final class ReaGhidraBridgeHelperProbe {
`;

const JAVA_GSON_STUBS = String.raw`
    private static class JsonElement {}
    private static final class JsonNull extends JsonElement {
        static final JsonNull INSTANCE = new JsonNull();
    }
    private static final class JsonPrimitive extends JsonElement {
        private final Object value;
        JsonPrimitive(String value) { this.value = value; }
        JsonPrimitive(Number value) { this.value = value; }
        JsonPrimitive(Boolean value) { this.value = value; }
        boolean isString() { return value instanceof String; }
        boolean isNumber() { return value instanceof Number; }
        boolean isBoolean() { return value instanceof Boolean; }
        String getAsString() { return (String) value; }
        Number getAsNumber() { return (Number) value; }
        boolean getAsBoolean() { return (Boolean) value; }
    }
    private static final class JsonArray extends JsonElement implements Iterable<JsonElement> {
        private final List<JsonElement> items = new ArrayList<>();
        void add(JsonElement value) { items.add(value == null ? JsonNull.INSTANCE : value); }
        void add(String value) { items.add(value == null ? JsonNull.INSTANCE : new JsonPrimitive(value)); }
        @Override public Iterator<JsonElement> iterator() { return items.iterator(); }
    }
    private static final class JsonObject extends JsonElement {
        private final Map<String, JsonElement> members = new LinkedHashMap<>();
        void add(String property, JsonElement value) {
            members.put(property, value == null ? JsonNull.INSTANCE : value);
        }
        void addProperty(String property, String value) {
            members.put(property, value == null ? JsonNull.INSTANCE : new JsonPrimitive(value));
        }
        void addProperty(String property, Number value) {
            members.put(property, value == null ? JsonNull.INSTANCE : new JsonPrimitive(value));
        }
        void addProperty(String property, Boolean value) {
            members.put(property, value == null ? JsonNull.INSTANCE : new JsonPrimitive(value));
        }
        Set<Map.Entry<String, JsonElement>> entrySet() { return members.entrySet(); }
    }
    private static final class JsonIOException extends RuntimeException {
        JsonIOException(String message) { super(message); }
        JsonIOException(Throwable cause) { super(cause); }
    }

    private static final class JsonWriter {
        private final Writer out;
        private final Gson gson;
        private final List<Boolean> containerNeedsComma = new ArrayList<>();
        private boolean pendingName;

        JsonWriter(Writer out, Gson gson) {
            this.out = out;
            this.gson = gson;
        }

        private void beforeValue() throws IOException {
            if (pendingName) {
                pendingName = false;
                return;
            }
            if (!containerNeedsComma.isEmpty()) {
                int top = containerNeedsComma.size() - 1;
                if (containerNeedsComma.get(top)) {
                    out.write(',');
                } else {
                    containerNeedsComma.set(top, true);
                }
            }
        }

        JsonWriter beginObject() throws IOException {
            beforeValue();
            out.write('{');
            containerNeedsComma.add(false);
            return this;
        }

        JsonWriter endObject() throws IOException {
            containerNeedsComma.remove(containerNeedsComma.size() - 1);
            out.write('}');
            return this;
        }

        JsonWriter beginArray() throws IOException {
            beforeValue();
            out.write('[');
            containerNeedsComma.add(false);
            return this;
        }

        JsonWriter endArray() throws IOException {
            containerNeedsComma.remove(containerNeedsComma.size() - 1);
            out.write(']');
            return this;
        }

        JsonWriter name(String name) throws IOException {
            int top = containerNeedsComma.size() - 1;
            if (containerNeedsComma.get(top)) {
                out.write(',');
            } else {
                containerNeedsComma.set(top, true);
            }
            gson.writeString(out, name);
            out.write(':');
            pendingName = true;
            return this;
        }

        JsonWriter value(String value) throws IOException {
            if (value == null) return nullValue();
            beforeValue();
            gson.writeString(out, value);
            return this;
        }

        JsonWriter value(boolean value) throws IOException {
            beforeValue();
            out.write(value ? "true" : "false");
            return this;
        }

        JsonWriter value(long value) throws IOException {
            beforeValue();
            out.write(Long.toString(value));
            return this;
        }

        JsonWriter nullValue() throws IOException {
            beforeValue();
            out.write("null");
            return this;
        }

        void flush() throws IOException {
            out.flush();
        }
    }

    private static class Gson {
        private static final String[] REPLACEMENT_CHARS = new String[128];
        static {
            for (int i = 0; i <= 0x1f; i++) {
                REPLACEMENT_CHARS[i] = String.format("\\u%04x", i);
            }
            REPLACEMENT_CHARS['"'] = "\\\"";
            REPLACEMENT_CHARS['\\'] = "\\\\";
            REPLACEMENT_CHARS['\t'] = "\\t";
            REPLACEMENT_CHARS['\b'] = "\\b";
            REPLACEMENT_CHARS['\n'] = "\\n";
            REPLACEMENT_CHARS['\r'] = "\\r";
            REPLACEMENT_CHARS['\f'] = "\\f";
            REPLACEMENT_CHARS['<'] = "\\u003c";
            REPLACEMENT_CHARS['>'] = "\\u003e";
            REPLACEMENT_CHARS['&'] = "\\u0026";
            REPLACEMENT_CHARS['='] = "\\u003d";
            REPLACEMENT_CHARS['\''] = "\\u0027";
        }
        private boolean useCharArrayWrites;
        void setUseCharArrayWrites(boolean useCharArrayWrites) {
            this.useCharArrayWrites = useCharArrayWrites;
        }
        JsonWriter newJsonWriter(Writer out) {
            return new JsonWriter(out, this);
        }
        void toJson(JsonElement element, Appendable appendable) {
            Writer out = (Writer) appendable;
            try {
                writeElement(out, element);
            }
            catch (IOException exception) {
                throw new JsonIOException(exception);
            }
        }
        private void writeElement(Writer out, JsonElement element) throws IOException {
            if (element == null || element instanceof JsonNull) {
                out.append("null");
            } else if (element instanceof JsonPrimitive primitive) {
                if (primitive.isBoolean()) {
                    out.write(primitive.getAsBoolean() ? "true" : "false");
                } else if (primitive.isNumber()) {
                    out.write(primitive.getAsNumber().toString());
                } else {
                    writeString(out, primitive.getAsString());
                }
            } else if (element instanceof JsonArray array) {
                out.write('[');
                boolean first = true;
                for (JsonElement item : array) {
                    if (!first) out.write(',');
                    first = false;
                    writeElement(out, item);
                }
                out.write(']');
            } else if (element instanceof JsonObject object) {
                out.write('{');
                boolean first = true;
                for (Map.Entry<String, JsonElement> entry : object.entrySet()) {
                    if (!first) out.write(',');
                    first = false;
                    writeString(out, entry.getKey());
                    out.write(':');
                    writeElement(out, entry.getValue());
                }
                out.write('}');
            }
        }
        private void writeString(Writer out, String value) throws IOException {
            out.write('"');
            int last = 0;
            int length = value.length();
            char[] chars = useCharArrayWrites ? value.toCharArray() : null;
            for (int index = 0; index < length; index++) {
                char c = value.charAt(index);
                String replacement = null;
                if (c < 128) {
                    replacement = REPLACEMENT_CHARS[c];
                } else if (c == '\u2028') {
                    replacement = "\\u2028";
                } else if (c == '\u2029') {
                    replacement = "\\u2029";
                }
                if (replacement == null) continue;
                if (last < index) {
                    if (chars != null) {
                        out.write(chars, last, index - last);
                    } else {
                        out.write(value, last, index - last);
                    }
                }
                out.write(replacement);
                last = index + 1;
            }
            if (last < length) {
                if (chars != null) {
                    out.write(chars, last, length - last);
                } else {
                    out.write(value, last, length - last);
                }
            }
            out.write('"');
        }
    }
    private static Gson GSON = new Gson();
`;

const JAVA_GHIDRA_STUBS = String.raw`
    private interface Address extends Comparable<Address> {
        boolean isMemoryAddress();
        boolean isExternalAddress();
        long getOffset();
        String canonical();
    }
    private record StubAddress(long offset, boolean external) implements Address {
        @Override public boolean isMemoryAddress() { return !external; }
        @Override public boolean isExternalAddress() { return external; }
        @Override public long getOffset() { return offset; }
        @Override public String canonical() {
            return (external ? "EXTERNAL:" : "") + "0x" + Long.toHexString(offset);
        }
        @Override public int compareTo(Address other) {
            int kind = Boolean.compare(external, other.isExternalAddress());
            if (kind != 0) return kind;
            return Long.compareUnsigned(offset, other.getOffset());
        }
    }
    private interface Symbol {
        Address getAddress();
        String getName();
        String getName(boolean includeNamespace);
    }
    private record StubSymbol(Address address, String leafName, String qualifiedName) implements Symbol {
        @Override public Address getAddress() { return address; }
        @Override public String getName() { return leafName; }
        @Override public String getName(boolean includeNamespace) {
            return includeNamespace ? qualifiedName : leafName;
        }
    }
    private interface SymbolIterator {
        boolean hasNext();
        Symbol next();
    }
    private interface SymbolTable {
        SymbolIterator getSymbols(String name);
        List<Symbol> getSymbols(Address address);
    }
    private static final class StubSymbolTable implements SymbolTable {
        private final Map<String, List<Symbol>> byLeafName = new HashMap<>();
        private final Map<Address, List<Symbol>> byAddress = new HashMap<>();
        void register(Symbol symbol, boolean indexByLeaf) {
            byAddress.computeIfAbsent(symbol.getAddress(), k -> new ArrayList<>()).add(symbol);
            if (indexByLeaf) {
                byLeafName.computeIfAbsent(symbol.getName(), k -> new ArrayList<>()).add(symbol);
            }
        }
        @Override public SymbolIterator getSymbols(String name) {
            List<Symbol> found = byLeafName.getOrDefault(name, List.of());
            Iterator<Symbol> iterator = found.iterator();
            return new SymbolIterator() {
                @Override public boolean hasNext() { return iterator.hasNext(); }
                @Override public Symbol next() { return iterator.next(); }
            };
        }
        @Override public List<Symbol> getSymbols(Address address) {
            return byAddress.getOrDefault(address, List.of());
        }
    }
    private interface Function {
        Address getEntryPoint();
        String getName();
        Symbol getSymbol();
        Address[] getFunctionThunkAddresses(boolean includeExternal);
    }
    private static final class StubFunction implements Function {
        private final Address entryPoint;
        private final String name;
        private final Symbol primarySymbol;
        private final List<Address> thunkAddresses = new ArrayList<>();
        StubFunction(Address entryPoint, String name, Symbol primarySymbol) {
            this.entryPoint = entryPoint;
            this.name = name;
            this.primarySymbol = primarySymbol;
        }
        void addThunk(Address thunkAddress) { thunkAddresses.add(thunkAddress); }
        @Override public Address getEntryPoint() { return entryPoint; }
        @Override public String getName() { return name; }
        @Override public Symbol getSymbol() { return primarySymbol; }
        @Override public Address[] getFunctionThunkAddresses(boolean includeExternal) {
            return thunkAddresses.isEmpty() ? null : thunkAddresses.toArray(Address[]::new);
        }
    }
    private interface FunctionManager {
        Function getFunctionAt(Address address);
    }
    private static final class StubFunctionManager implements FunctionManager {
        private final Map<Address, Function> functions = new LinkedHashMap<>();
        void register(Function function) { functions.put(function.getEntryPoint(), function); }
        List<Function> all() { return List.copyOf(functions.values()); }
        @Override public Function getFunctionAt(Address address) { return functions.get(address); }
    }
    private static final class AddressFactory {
        private final Set<Address> dynamicTargets = new LinkedHashSet<>();
        void registerDynamic(Address address) { dynamicTargets.add(address); }
        boolean contains(Address address) { return dynamicTargets.contains(address); }
    }
    private static final class SymbolUtilities {
        static Address parseDynamicName(AddressFactory factory, String name) {
            if (!name.startsWith("FUN_")) return null;
            try {
                Address addr = new StubAddress(Long.parseUnsignedLong(name.substring(4), 16), false);
                return factory.contains(addr) ? addr : null;
            }
            catch (NumberFormatException ignored) {
                return null;
            }
        }
    }
    private static final class TaskMonitor {
        void checkCancelled() throws Exception {}
    }
    private static final class StubProgram {
        private final StubSymbolTable symbolTable = new StubSymbolTable();
        private final StubFunctionManager functionManager = new StubFunctionManager();
        private final AddressFactory addressFactory = new AddressFactory();
        StubSymbolTable getSymbolTable() { return symbolTable; }
        StubFunctionManager getFunctionManager() { return functionManager; }
        AddressFactory getAddressFactory() { return addressFactory; }
    }
    private final StubProgram currentProgram = new StubProgram();
    private final TaskMonitor monitor = new TaskMonitor();
    private List<ProcedureEntry> procedureInventory;
    private Map<String, Object> procedureNameIndex;
    private static String canonicalAddress(Address address) {
        return address.canonical();
    }
`;

const JAVA_PROBE_DRIVER = String.raw`
    private static String decodeHex(String hex) {
        if (hex == null || hex.isEmpty()) return "";
        String[] parts = hex.split(",");
        char[] chars = new char[parts.length];
        for (int index = 0; index < parts.length; index++) {
            chars[index] = (char) Integer.parseInt(parts[index], 16);
        }
        return new String(chars);
    }

    private static List<String> readStdinLines() throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        List<String> lines = new ArrayList<>();
        String line;
        while ((line = reader.readLine()) != null) {
            lines.add(line);
        }
        return lines;
    }

    private static void runFoldChar() throws IOException {
        for (String line : readStdinLines()) {
            char ch = (char) Integer.parseInt(line, 16);
            System.out.println(foldAsciiCandidateChar(ch));
        }
    }

    private static void runLiteralBatch() throws IOException {
        for (String line : readStdinLines()) {
            String[] fields = line.split("\\|", -1);
            String pattern = "0".equals(fields[0]) ? null : decodeHex(fields[1]);
            String value = decodeHex(fields[2]);
            try {
                ValueMatcher matcher = literalCandidateMatcher(pattern);
                System.out.println(matcher.matches(value) ? "1" : "0");
            }
            catch (RequestFailure failure) {
                System.out.println("ERR:" + failure.code + ":" + failure.getMessage());
            }
        }
    }

    private static void runLiteralDirect() throws IOException {
        for (String line : readStdinLines()) {
            String[] fields = line.split("\\|", -1);
            String pattern = decodeHex(fields[0]);
            String value = decodeHex(fields[1]);
            System.out.println(literalMatcher(pattern).matches(value) ? "1" : "0");
        }
    }

    private static void runWriteResponse() throws IOException {
        for (String line : readStdinLines()) {
            String[] fields = line.split("\\|", -1);
            String mode = fields[0];
            String kind = fields[1];
            String key = decodeHex(fields[2]);
            String value = decodeHex(fields[3]);
            GSON.setUseCharArrayWrites("char-array".equals(mode));
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8.newEncoder()));
            if ("failure".equals(kind)) {
                writeFailure(writer, 7, key, value);
            } else {
                JsonObject result = new JsonObject();
                result.addProperty(key, value);
                writeSuccess(writer, 1, result);
            }
            System.out.println(Base64.getEncoder().encodeToString(out.toByteArray()));
        }
        GSON.setUseCharArrayWrites(false);
    }

    private static final class TrackingWriter extends Writer {
        final StringBuilder written = new StringBuilder();
        boolean flushed;
        boolean closed;
        boolean failOnWrite;
        boolean failOnNewline;
        boolean failOnFlush;
        int writeBudget = Integer.MAX_VALUE;
        @Override public void write(char[] cbuf, int off, int len) throws IOException {
            Objects.checkFromIndexSize(off, len, cbuf.length);
            if (failOnWrite || writeBudget <= 0) throw new IOException("simulated write failure");
            String slice = new String(cbuf, off, len);
            if (failOnNewline && slice.contains("\n")) throw new IOException("simulated newline failure");
            writeBudget -= len;
            written.append(slice);
        }
        @Override public void flush() throws IOException {
            if (failOnFlush) throw new IOException("simulated flush failure");
            flushed = true;
        }
        @Override public void close() { closed = true; }
    }

    private static void runSurrogateWriterChecks() throws IOException {
        TrackingWriter tracking = new TrackingWriter();
        BufferedWriter buffered = new BufferedWriter(tracking, 8192);
        SurrogateEscapingWriter writer = new SurrogateEscapingWriter(buffered);
        writer.write('A');
        writer.write('\ud800');
        writer.write('\udfff');
        char[] cbuf = new char[] { 'X', 'b', '\ud83d', '\ude00', 'c', '\ud801', 'Y' };
        writer.write(cbuf, 1, 5);
        writer.write("skip-d-\udc00-e-tail", 5, 6);
        writer.append(null);
        writer.append("S\ud800");
        writer.append(new StringBuilder("B\udfff"));
        writer.append(null, 1, 3);
        writer.append("01\ud80023", 1, 4);
        writer.append(new StringBuilder("pq\udc01rs"), 1, 4);
        writer.flush();
        writer.close();
        System.out.println("no_early_flush=" + (!tracking.flushed && !tracking.closed && tracking.written.length() == 0));
        buffered.write("!");
        buffered.flush();
        System.out.println("after_flush=" + Base64.getEncoder().encodeToString(tracking.written.toString().getBytes(StandardCharsets.UTF_8)));

        boolean cbufOob = false;
        try { writer.write(new char[] { 'a' }, 1, 1); }
        catch (IndexOutOfBoundsException expected) { cbufOob = true; }
        boolean strOob = false;
        try { writer.write("a", 0, 2); }
        catch (IndexOutOfBoundsException expected) { strOob = true; }
        boolean appendOob = false;
        try { writer.append(new StringBuilder("ab"), 1, 3); }
        catch (IndexOutOfBoundsException expected) { appendOob = true; }
        System.out.println("bounds_checks=" + (cbufOob && strOob && appendOob));
    }

    private static void runWriteFailures() {
        JsonObject payload = new JsonObject();
        payload.addProperty("msg", "hello");
        TrackingWriter writeFailTracker = new TrackingWriter();
        writeFailTracker.failOnWrite = true;
        BufferedWriter writeFailWriter = new BufferedWriter(writeFailTracker, 1);
        try {
            writeResponse(writeFailWriter, payload);
            System.out.println("unwrap_write_io=ERR");
        }
        catch (IOException expected) {
            System.out.println("unwrap_write_io=OK:" + expected.getMessage());
        }

        TrackingWriter newlineFailTracker = new TrackingWriter();
        newlineFailTracker.failOnNewline = true;
        BufferedWriter newlineFailWriter = new BufferedWriter(newlineFailTracker, 1);
        try {
            writeResponse(newlineFailWriter, payload);
            System.out.println("newline_io=ERR");
        }
        catch (IOException expected) {
            System.out.println("newline_io=OK:" + expected.getMessage());
        }

        TrackingWriter flushFailTracker = new TrackingWriter();
        flushFailTracker.failOnFlush = true;
        BufferedWriter flushFailWriter = new BufferedWriter(flushFailTracker, 8192);
        try {
            writeResponse(flushFailWriter, payload);
            System.out.println("flush_io=ERR");
        }
        catch (IOException expected) {
            System.out.println("flush_io=OK:" + expected.getMessage());
        }

        Gson previous = GSON;
        try {
            GSON = new Gson() {
                @Override void toJson(JsonElement element, Appendable appendable) {
                    throw new JsonIOException(new IllegalStateException("non-io-cause"));
                }
            };
            try {
                writeResponse(new BufferedWriter(new TrackingWriter()), payload);
                System.out.println("rethrow_non_io_cause=ERR");
            }
            catch (JsonIOException expected) {
                System.out.println("rethrow_non_io_cause=OK:" + expected.getCause().getClass().getSimpleName());
            }
            catch (IOException unexpected) {
                System.out.println("rethrow_non_io_cause=ERR_IO");
            }

            GSON = new Gson() {
                @Override void toJson(JsonElement element, Appendable appendable) {
                    throw new JsonIOException("bare-json-io");
                }
            };
            try {
                writeResponse(new BufferedWriter(new TrackingWriter()), payload);
                System.out.println("rethrow_bare_json_io=ERR");
            }
            catch (JsonIOException expected) {
                System.out.println("rethrow_bare_json_io=OK:" + expected.getMessage());
            }
            catch (IOException unexpected) {
                System.out.println("rethrow_bare_json_io=ERR_IO");
            }
        }
        finally {
            GSON = previous;
        }
    }

    private StubFunction addFunction(long offset, boolean external, String leafName, String qualifiedName, boolean indexByLeaf) {
        Address addr = new StubAddress(offset, external);
        Symbol symbol = new StubSymbol(addr, leafName, qualifiedName);
        currentProgram.getSymbolTable().register(symbol, indexByLeaf);
        StubFunction function = new StubFunction(addr, leafName, symbol);
        currentProgram.getFunctionManager().register(function);
        return function;
    }

    private void populateProcedureProgram() {
        StubFunction nsOtherWork = addFunction(0x1000L, false, "other::work", "ns::other::work", true);
        StubFunction nsThunkOtherWork = addFunction(0x2500L, false, "thunk_other::work", "ns::thunk_other::work", false);
        nsOtherWork.addThunk(nsThunkOtherWork.getEntryPoint());
        currentProgram.getSymbolTable().register(
            new StubSymbol(nsOtherWork.getEntryPoint(), "sub::leaf", "alias_ns::sub::leaf"), true);
        currentProgram.getSymbolTable().register(
            new StubSymbol(new StubAddress(0x1004L, false), "body_label", "ns::inner::body_label"), true);
        addFunction(0x1100L, false, "inner::do::step", "pkg::sub::inner::do::step", true);
        addFunction(0x1300L, false, "other::work", "wrong::other::work", true);
        addFunction(0x1400L, false, "shared::op", "ns::shared::op", true);
        addFunction(0x1500L, false, "op", "shared::op", true);
        addFunction(0x1600L, false, "unique::leaf", "ns::unique::leaf", true);

        StubFunction targetOp = addFunction(0x2100L, false, "target::op", "lib::target::op", true);
        StubFunction thunkTargetOp = addFunction(0x2000L, false, "thunk_target::op", "ns::thunk_target::op", false);
        targetOp.addThunk(thunkTargetOp.getEntryPoint());

        StubFunction nestedOp = addFunction(0x2300L, false, "nested::op", "lib::nested::op", true);
        StubFunction doubleThunk = addFunction(0x2200L, false, "thunk_thunk_nested::op", "ns::thunk_thunk_nested::op", false);
        StubFunction nsThunk = addFunction(0x2400L, false, "nested::op", "thunk_ns::nested::op", false);
        nestedOp.addThunk(doubleThunk.getEntryPoint());
        nestedOp.addThunk(nsThunk.getEntryPoint());

        StubFunction extTarget = addFunction(0x3000L, true, "ext::work", "<EXTERNAL>::ext::work", true);
        StubFunction extThunk = addFunction(0x3100L, false, "thunk_ext::work", "ns::thunk_ext::work", false);
        extTarget.addThunk(extThunk.getEntryPoint());

        Address dynamicAddr = new StubAddress(0x401000L, false);
        currentProgram.getAddressFactory().registerDynamic(dynamicAddr);
        StubFunction dynamicFn = addFunction(0x401000L, false, "FUN_00401000", "FUN_00401000", false);
        StubFunction dynamicThunk = addFunction(0x402000L, false, "thunk_FUN_00401000", "ns::thunk_FUN_00401000", false);
        dynamicFn.addThunk(dynamicThunk.getEntryPoint());

        addFunction(0x4100L, false, "triple", "ns:::triple", true);
        addFunction(0x4200L, false, ":colon_leaf", "ns:::colon_leaf", true);
        addFunction(0x5000L, false, "a::b", "dup::a::b", true);
        addFunction(0x5100L, false, "a::b", "dup::a::b", true);
    }

    private void buildInventoryFromProgram() {
        List<ProcedureEntry> inventory = new ArrayList<>();
        for (Function function : currentProgram.getFunctionManager().all()) {
            Symbol primary = function.getSymbol();
            String leafName = function.getName();
            String value = primary == null ? leafName : primary.getName(true);
            List<ProcedureAlias> aliases = new ArrayList<>();
            for (Symbol candidate : currentProgram.getSymbolTable().getSymbols(function.getEntryPoint())) {
                String qualified = candidate.getName(true);
                String candidateLeaf = candidate.getName();
                if (qualified.equals(value) && candidateLeaf.equals(leafName)) continue;
                aliases.add(new ProcedureAlias(candidateLeaf.equals(qualified) ? qualified : candidateLeaf, qualified));
            }
            inventory.add(new ProcedureEntry(
                function,
                function.getEntryPoint(),
                value,
                leafName.equals(value) ? value : leafName,
                List.copyOf(aliases),
                new ProcedureFacts(false, false, null),
                new SymbolFacts(true, false, false, "Function", "USER_DEFINED")
            ));
        }
        procedureInventory = List.copyOf(inventory);
        procedureNameIndex = null;
    }

    private String formatResolve(String query) throws Exception {
        try {
            Function fn = resolveProcedureByName(query);
            return fn == null ? "null" : canonicalAddress(fn.getEntryPoint());
        }
        catch (RequestFailure failure) {
            return "ERR:" + failure.code + ":" + failure.getMessage();
        }
    }

    private void runResolveProcedures() throws Exception {
        populateProcedureProgram();
        List<String> queries = readStdinLines();
        List<String> directResults = new ArrayList<>(queries.size());
        for (String query : queries) {
            directResults.add(formatResolve(query));
        }
        buildInventoryFromProgram();
        for (int index = 0; index < queries.size(); index++) {
            String query = queries.get(index);
            String cached = formatResolve(query);
            System.out.println(query + "\t" + directResults.get(index) + "\t" + cached);
        }
    }

    private static void runSpellingMatch() throws IOException {
        for (String line : readStdinLines()) {
            String[] fields = line.split("\\|", -1);
            String factory = fields[0];
            String expr = decodeHex(fields[1]);
            String qualified = decodeHex(fields[2]);
            String leaf = decodeHex(fields[3]);
            String aliasQualified = decodeHex(fields[4]);
            String aliasLeaf = decodeHex(fields[5]);
            ValueMatcher delegate = switch (factory) {
                case "literal" -> literalMatcher(expr);
                case "candidate-ascii" -> literalCandidateMatcher(expr);
                case "candidate-null" -> literalCandidateMatcher(null);
                case "regex-cs" -> regexMatcher(expr, true);
                case "regex-ci" -> regexMatcher(expr, false);
                default -> throw new IllegalArgumentException("Unknown matcher factory: " + factory);
            };
            int[] calls = new int[1];
            ValueMatcher matcher = new ValueMatcher() {
                @Override
                public boolean matches(String value) {
                    calls[0]++;
                    return delegate.matches(value);
                }

                @Override
                public boolean requiresLeafCheck() {
                    return delegate.requiresLeafCheck();
                }
            };
            ProcedureEntry entry = new ProcedureEntry(
                null,
                null,
                qualified,
                leaf,
                qualified.endsWith(leaf),
                aliasQualified.isEmpty()
                    ? List.of()
                    : List.of(new ProcedureAlias(aliasLeaf, aliasQualified)),
                new ProcedureFacts(false, false, null),
                new SymbolFacts(true, false, false, "Function", "USER_DEFINED")
            );
            ProcedureNameMatch result = matchProcedureNames(entry, matcher);
            System.out.println(result.primary() + "|" + String.join(",", result.aliases()) + "|" + calls[0]);
        }
    }

    private static void runStreamInventory() throws IOException {
        StubAddress addr1 = new StubAddress(0x1000L, false);
        StubAddress addr2 = new StubAddress(0x2000L, false);
        SymbolFacts symFacts = new SymbolFacts(true, false, false, "Function", "USER_DEFINED");
        ProcedureFacts procFacts = new ProcedureFacts(false, true, addr2);
        ProcedureFacts procFactsNull = new ProcedureFacts(false, false, null);
        StringFacts strFacts = new StringFacts("utf-8", true, 12);

        List<NameEntry> names = List.of(new NameEntry(addr1, "ns::sym", symFacts));
        ProcedureEntry proc1 = new ProcedureEntry(null, addr1, "ns::work", "work", true, List.of(), procFacts, symFacts);
        ProcedureEntry proc2 = new ProcedureEntry(null, addr2, "plain", "plain", true, List.of(), procFactsNull, null);
        List<MatchedProcedure> matched = List.of(new MatchedProcedure(proc1, List.of("alt::a", "alt::b")));
        List<StringEntry> strings = List.of(new StringEntry(addr1, "hi-\ud800-lo-\udfff-end", strFacts));

        StreamingResult[] streams = new StreamingResult[] {
            out -> writeNameEntries(out, names),
            out -> writeProcedureEntries(out, List.of(proc1, proc2)),
            out -> writeMatchedProcedures(out, matched),
            out -> writeStringEntries(out, strings),
        };
        for (int i = 0; i < streams.length; i++) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(bytes, StandardCharsets.UTF_8));
            writeStreamingSuccess(writer, i + 1, streams[i]);
            System.out.println(Base64.getEncoder().encodeToString(bytes.toByteArray()));
        }
    }

    public static void main(String[] args) throws Exception {
        switch (args[0]) {
            case "fold-char" -> runFoldChar();
            case "literal-batch" -> runLiteralBatch();
            case "literal-direct" -> runLiteralDirect();
            case "spelling-match" -> runSpellingMatch();
            case "write-response" -> runWriteResponse();
            case "stream-inventory" -> runStreamInventory();
            case "surrogate-writer" -> runSurrogateWriterChecks();
            case "write-failures" -> runWriteFailures();
            case "resolve-procedures" -> new ReaGhidraBridgeHelperProbe().runResolveProcedures();
            default -> throw new IllegalArgumentException("Unknown probe mode: " + args[0]);
        }
    }
}
`;

const buildBridgeProbeSource = (bridgeSource: string): string => {
  const procedureMethods = extractBridgeSlice(
    bridgeSource,
    "    private Map<String, Object> procedureIndex() {",
    "    private Function resolveProcedure(String value) throws Exception {",
  );
  const matchMethods = extractBridgeSlice(
    bridgeSource,
    "    private static ProcedureNameMatch matchProcedureNames(",
    "    private List<NameEntry> names() throws Exception {",
  );
  const literalMethods = extractBridgeSlice(
    bridgeSource,
    "    private static ValueMatcher literalMatcher(String pattern) {",
    "    private static SessionDescriptor readDescriptor(",
  );
  const responseMethods = extractBridgeSlice(
    bridgeSource,
    "    private static void writeSuccess(BufferedWriter writer, int id, JsonElement result)",
    "    private static String safeMessage(Exception exception) {",
  );
  const streamingInventoryWriters = extractBridgeSlice(
    bridgeSource,
    "    private static void writeNameEntries(",
    "    private static JsonObject memoryRegion(",
  );
  const valueMatcherInterface = extractBridgeSlice(
    bridgeSource,
    "    private interface ValueMatcher {",
    "    private static int compareInventory(",
  );
  const inventoryFactRecords = extractBridgeSlice(
    bridgeSource,
    "    private record SymbolFacts(",
    "    private record AddressNameTarget(",
  );
  const procedureNameMatchRecord = extractBridgeSlice(
    bridgeSource,
    "    private record ProcedureNameMatch(",
    "    private record FunctionAnalysisObservation(",
  );
  const requestFailureClass = extractRequestFailureSlice(bridgeSource);
  return [
    JAVA_HEADER,
    JAVA_GSON_STUBS,
    JAVA_GHIDRA_STUBS,
    valueMatcherInterface,
    inventoryFactRecords,
    procedureNameMatchRecord,
    procedureMethods,
    matchMethods,
    literalMethods,
    streamingInventoryWriters,
    responseMethods,
    requestFailureClass,
    JAVA_PROBE_DRIVER,
  ].join("\n");
};

/** Compile the pure-JDK harness embedding production methods from ReaGhidraBridge.java. */
export const compileBridgeProbe = async (
  jdk: JdkToolchain,
  workspaceRoot: string,
): Promise<CompiledBridgeProbe> => {
  const bridgeSource = await readFile(BRIDGE_SOURCE_PATH, "utf8");
  const sourceDir = join(workspaceRoot, "src");
  const classesDir = join(workspaceRoot, "classes");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(classesDir, { recursive: true });
  const probeSourcePath = join(sourceDir, "ReaGhidraBridgeHelperProbe.java");
  await writeFile(
    probeSourcePath,
    buildBridgeProbeSource(bridgeSource),
    "utf8",
  );
  await execute(
    jdk.javac,
    [
      "--release",
      "21",
      "-encoding",
      "UTF-8",
      "-d",
      classesDir,
      probeSourcePath,
    ],
    { timeout: 30_000 },
  );
  return { classesDir, jdk };
};

/** Execute one mode of the compiled bridge probe with optional stdin lines. */
export const runBridgeProbe = (
  probe: CompiledBridgeProbe,
  mode: string,
  stdinText = "",
): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      probe.jdk.java,
      ["-cp", probe.classesDir, "ReaGhidraBridgeHelperProbe", mode],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectPromise(
            new Error(
              `Java probe '${mode}' failed: ${error.message}\n${stderr}`,
            ),
          );
          return;
        }
        resolvePromise(stdout);
      },
    );
    child.stdin?.end(stdinText, "utf8");
  });
