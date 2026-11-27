import java.io.BufferedReader;
import java.io.IOException;
import java.io.StringReader;
import java.util.Set;

/**
 * Request-line admission for the REA bridge transports.
 *
 * One owner for the bounded line read and for the shared
 * REA_BRIDGE_MAX_REQUEST_BYTES contract, so the bridge does not re-derive it
 * per provider. The TypeScript client keeps ownership of the byte ceiling it
 * enforces before writing; this class derives the character extent it retains
 * while reading, and refuses a setting the other bridges refuse.
 *
 * Ghidra compiles every script under bridge/ghidra, so this source must stay
 * free of Ghidra imports. Keeping it dependency-free also lets
 * scripts/verify-ghidra-bridge-sources.mjs exercise it with a plain JDK.
 *
 * Run {@code java ReaGhidraRequestLine} to execute the self-test.
 */
final class ReaGhidraRequestLine {
    static final String SETTING = "REA_BRIDGE_MAX_REQUEST_BYTES";
    static final long DEFAULT_BYTES = 16L * 1024 * 1024;
    static final long MINIMUM_BYTES = 7464L;
    static final long MAXIMUM_BYTES = 536870887L;

    private ReaGhidraRequestLine() {}

    static String constraint() {
        return SETTING + " must be a positive decimal integer from " +
            MINIMUM_BYTES + " to " + MAXIMUM_BYTES + " bytes; the default is " +
            DEFAULT_BYTES + " bytes (16 MiB). A value below " + MINIMUM_BYTES +
            " bytes cannot carry the largest admitted symbol-name command, and " +
            "a larger value is refused so the encoded payload plus its framing " +
            "LF stays one string under Node's single-string ceiling.";
    }

    /**
     * Validated ceiling, or the default when the setting is absent. The
     * accepted spelling matches the client's schema exactly: ASCII digits, no
     * sign, no surrounding space, no leading zero, and inside the shared range.
     * An invalid setting throws instead of silently defaulting or clamping,
     * which is what the REA client and the Hopper and Cutter bridges do.
     */
    static long resolve(String raw) {
        if (raw == null) return DEFAULT_BYTES;
        if (!raw.matches("[1-9][0-9]*")) throw new IllegalArgumentException(constraint());
        long parsed;
        try {
            parsed = Long.parseLong(raw);
        }
        catch (NumberFormatException exception) {
            throw new IllegalArgumentException(constraint());
        }
        if (parsed < MINIMUM_BYTES || parsed > MAXIMUM_BYTES)
            throw new IllegalArgumentException(constraint());
        return parsed;
    }

    /** Ceiling from this process environment. Unset keeps the default. */
    static long resolveFromEnvironment() {
        return resolve(System.getenv(SETTING));
    }

    /**
     * Retained-character ceiling for one request line. Decoded characters are
     * never more than the encoded bytes they arrived in, so a request the
     * client admitted under its byte ceiling is never refused here.
     */
    static int charCeiling(long maximumBytes) {
        return (int) Math.min(maximumBytes, 2147483647L);
    }

    /**
     * Read one request line, refusing one above the ceiling the same way the
     * authentication handshake refuses an oversized frame. Termination matches
     * {@link BufferedReader#readLine()}: LF, CR, or CRLF, with the terminator
     * excluded from the count and a lone CR not consuming the next character.
     *
     * @return the line without its terminator, null at end of stream, or the
     *         unterminated remainder when the peer drops the connection
     * @throws IOException when the line exceeds the ceiling, or when the read
     *         itself fails; callers drop the connection because the line's id
     *         has not parsed, so no correlated failure exists to send
     */
    static String readBoundedLine(BufferedReader reader, int maxChars)
            throws IOException {
        StringBuilder line = new StringBuilder();
        int value;
        while ((value = reader.read()) != -1) {
            if (value == '\n') return line.toString();
            if (value == '\r') {
                reader.mark(1);
                int next = reader.read();
                if (next != '\n' && next != -1) reader.reset();
                return line.toString();
            }
            if (line.length() >= maxChars)
                throw new IOException("Bridge request frame is too large");
            line.append((char) value);
        }
        return line.length() == 0 ? null : line.toString();
    }

    public static void main(String[] arguments) throws IOException {
        if (arguments.length != 0) {
            System.err.println("REA_REQUEST_LINE_SELFTEST_FAIL unexpected arguments");
            System.exit(2);
        }
        Set<String> checks = new java.util.LinkedHashSet<>();
        StringBuilder failures = new StringBuilder();

        // Line termination: LF, CR and CRLF all end a line, and a lone CR does
        // not consume the character that follows it.
        checkLine(checks, failures, "lf", "abc\nrest", 16, "abc", "rest");
        checkLine(checks, failures, "cr", "abc\rrest", 16, "abc", "rest");
        checkLine(checks, failures, "crlf", "abc\r\nrest", 16, "abc", "rest");
        checkLine(checks, failures, "empty-line", "\nrest", 16, "", "rest");

        // The ceiling counts content characters and excludes both terminator
        // characters, so an exact-limit line is admitted.
        String exact = "x".repeat(8);
        checkLine(checks, failures, "exact-limit-lf", exact + "\n", 8, exact, "");
        checkLine(checks, failures, "exact-limit-crlf", exact + "\r\n", 8, exact, "");
        checkLineThrows(checks, failures, "over-limit-lf", "x".repeat(9) + "\n", 8);
        checkLineThrows(checks, failures, "over-limit-crlf", "x".repeat(9) + "\r\n", 8);
        checkLineThrows(checks, failures, "over-limit-cr-only", "x".repeat(9), 8);

        // A dropped connection without a terminator keeps what arrived, and an
        // immediate EOF is a clean end of stream.
        checkLine(checks, failures, "unterminated-drop", "partial", 64, "partial", "");
        checkLine(checks, failures, "immediate-eof", "", 64, null, "");

        // The spelling contract: the client accepts ASCII digits with no sign,
        // no surrounding space and no leading zero, and refuses every value
        // outside the shared range instead of defaulting or clamping it.
        checkCeiling(checks, failures, "ceiling-unset", null, DEFAULT_BYTES);
        checkCeiling(checks, failures, "ceiling-valid-floor", "7464", MINIMUM_BYTES);
        checkCeiling(checks, failures, "ceiling-valid-maximum", String.valueOf(MAXIMUM_BYTES),
            MAXIMUM_BYTES);
        checkCeilingRejected(checks, failures, "ceiling-space-padded", " 8192 ");
        int refusedIndex = 0;
        for (String refused : new String[] {
            "", "0", "-1", "7463", "536870888", "8192.0", "0x2000", "  ", "8192x",
            "+8192", "1e3", "08", "\u0668\u0669", "99999999999999999999"}) {
            checkCeilingRejected(checks, failures,
                "ceiling-refused-" + String.valueOf(refusedIndex++), refused);
        }

        // The environment path must refuse an invalid setting too. The verifier
        // sets one on purpose; a local run without it keeps the default.
        String environment = System.getenv(ReaGhidraRequestLine.SETTING);
        if ("not-a-byte-count".equals(environment)) {
            checks.add("environment-invalid-refused");
            try {
                long resolved = resolveFromEnvironment();
                failures.append("\n  environment-invalid-refused: accepted ")
                    .append(resolved);
            }
            catch (IllegalArgumentException expected) {
                // The bridge must refuse, not default to 16 MiB or clamp.
            }
        }

        if (failures.length() != 0) {
            System.err.print("REA_REQUEST_LINE_SELFTEST_FAIL" + failures);
            System.exit(1);
        }
        System.out.println("REA_REQUEST_LINE_SELFTEST_OK checks=" + checks.size() +
            " (" + String.join(",", checks) + ")");
    }

    private static void checkLine(
            Set<String> checks,
            StringBuilder failures,
            String name,
            String input,
            int maxChars,
            String expectedLine,
            String expectedRest) throws IOException {
        checks.add(name);
        BufferedReader reader = new BufferedReader(new StringReader(input));
        String line = readBoundedLine(reader, maxChars);
        StringBuilder rest = new StringBuilder();
        int value;
        while ((value = reader.read()) != -1) rest.append((char) value);
        if (expectedLine == null ? line != null : !expectedLine.equals(line))
            failures.append("\n  ").append(name).append(": line ").append(describe(line))
                .append(" != ").append(describe(expectedLine));
        if (!expectedRest.contentEquals(rest))
            failures.append("\n  ").append(name).append(": rest ")
                .append(describe(rest.toString())).append(" != ")
                .append(describe(expectedRest));
    }

    private static void checkLineThrows(
            Set<String> checks,
            StringBuilder failures,
            String name,
            String input,
            int maxChars) throws IOException {
        checks.add(name);
        try {
            String line = readBoundedLine(new BufferedReader(new StringReader(input)), maxChars);
            failures.append("\n  ").append(name).append(": expected refusal, read ")
                .append(describe(line));
        }
        catch (IOException expected) {
            // The ceiling is advisory to the caller, which drops the connection.
        }
    }

    private static void checkCeiling(
            Set<String> checks,
            StringBuilder failures,
            String name,
            String raw,
            long expected) {
        checks.add(name);
        try {
            long resolved = resolve(raw);
            if (resolved != expected)
                failures.append("\n  ").append(name).append(": ").append(resolved)
                    .append(" != ").append(expected);
        }
        catch (IllegalArgumentException exception) {
            failures.append("\n  ").append(name).append(": refused ")
                .append(describe(raw)).append(" with ")
                .append(exception.getClass().getSimpleName());
        }
    }

    private static void checkCeilingRejected(
            Set<String> checks,
            StringBuilder failures,
            String name,
            String raw) {
        checks.add(name);
        try {
            long resolved = resolve(raw);
            failures.append("\n  ").append(name).append(": accepted ")
                .append(describe(raw)).append(" as ").append(resolved);
        }
        catch (IllegalArgumentException expected) {
            // Refusal is the contract shared with the client and the other bridges.
        }
    }

    private static String describe(String value) {
        return value == null ? "null" : "\"" + value + "\"";
    }
}
