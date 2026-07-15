// REA's packaged, read-only Ghidra headless bridge.
// @category REA

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.Reader;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.Channels;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.Set;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import ghidra.app.util.headless.HeadlessScript;
import ghidra.framework.Application;

public final class ReaGhidraBridge extends HeadlessScript {
    private static final int BRIDGE_VERSION = 1;
    private static final int MAX_DESCRIPTOR_BYTES = 16 * 1024;
    // A Java character occupies at most three UTF-8 bytes in this Reader, so
    // this also keeps the decoded request below the 1 MiB wire budget.
    private static final int MAX_REQUEST_CHARACTERS = 256 * 1024;
    private static final Gson GSON = new Gson();
    private static final Set<String> DESCRIPTOR_KEYS = Set.of(
        "schema_version",
        "socket_path",
        "token",
        "run_id",
        "provider_version",
        "profile_digest"
    );
    private static final Set<String> REQUEST_KEYS = Set.of(
        "id",
        "token",
        "method",
        "params"
    );

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
        if (!Application.getApplicationVersion().equals(descriptor.providerVersion)) {
            throw new IllegalStateException("Ghidra provider version does not match the session");
        }
        serve(descriptor);
    }

    private void serve(SessionDescriptor descriptor) throws Exception {
        Path socketPath = Path.of(descriptor.socketPath);
        Files.deleteIfExists(socketPath);
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            Files.setPosixFilePermissions(socketPath, PosixFilePermissions.fromString("rw-------"));
            try (SocketChannel client = server.accept();
                 BufferedReader reader = new BufferedReader(Channels.newReader(client, StandardCharsets.UTF_8));
                 BufferedWriter writer = new BufferedWriter(Channels.newWriter(client, StandardCharsets.UTF_8))) {
                serveClient(descriptor, reader, writer);
            }
        }
        finally {
            Files.deleteIfExists(socketPath);
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
            if (request.method.equals("ping")) {
                writeSuccess(writer, request.id, sessionInfo(descriptor));
                continue;
            }
            if (request.method.equals("shutdown")) {
                JsonObject result = new JsonObject();
                result.addProperty("shutdown", true);
                result.addProperty("project_ephemeral", true);
                writeSuccess(writer, request.id, result);
                return;
            }
            writeFailure(writer, request.id, "method_unavailable", "Bridge method is unavailable");
        }
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

        JsonObject result = new JsonObject();
        result.addProperty("name", "REA Ghidra bridge");
        result.addProperty("bridge_version", BRIDGE_VERSION);
        result.addProperty("run_id", descriptor.runId);
        result.addProperty("profile_digest", descriptor.profileDigest);
        result.add("provider", provider);
        result.addProperty("read_only", true);
        result.addProperty("analysis_complete", !timedOut);
        result.addProperty("analysis_timed_out", timedOut);
        result.add("capabilities", GSON.toJsonTree(new String[] { "ping", "shutdown" }));
        result.add("target", target);
        return result;
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
        if (requireInteger(object, "schema_version") != 1) {
            throw new IllegalArgumentException("REA session descriptor version is invalid");
        }
        return new SessionDescriptor(
            requireString(object, "socket_path"),
            requireString(object, "token"),
            requireString(object, "run_id"),
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
        if (params == null ||
            !params.isJsonObject() ||
            params.getAsJsonObject().size() != 0) {
            throw new IllegalArgumentException("Bridge request parameters are invalid");
        }
        return new Request(id, requireString(object, "method"));
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

    private static String requireString(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException("JSON string required");
        }
        String result = value.getAsString();
        if (result.isEmpty()) {
            throw new IllegalArgumentException("JSON string cannot be empty");
        }
        return result;
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
        writer.write(GSON.toJson(response));
        writer.newLine();
        writer.flush();
    }

    private record SessionDescriptor(
        String socketPath,
        String token,
        String runId,
        String providerVersion,
        String profileDigest
    ) {}

    private record Request(int id, String method) {}
}
