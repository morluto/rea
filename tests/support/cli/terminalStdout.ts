/**
 * Run a command with stdout on a pseudo-terminal, so it sees
 * `process.stdout.isTTY` as a user's terminal would, while stdin stays empty
 * and stderr stays a separate pipe. Python's standard `pty` support provides
 * the terminal without a native Node dependency. Output post-processing is
 * off, so the captured bytes are the ones the command wrote. The window is a
 * fixed 80x24 so width-dependent output does not follow the host.
 */
const DRIVER = String.raw`
import fcntl, os, signal, struct, subprocess, sys, termios, threading

leader, follower = os.openpty()
attributes = termios.tcgetattr(follower)
attributes[1] &= ~termios.OPOST
termios.tcsetattr(follower, termios.TCSANOW, attributes)
fcntl.ioctl(follower, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen(
    sys.argv[1:], stdin=subprocess.DEVNULL, stdout=follower, stderr=subprocess.PIPE
)
os.close(follower)
signal.signal(signal.SIGTERM, lambda *_: child.terminate())
errors = []
reader = threading.Thread(target=lambda: errors.append(child.stderr.read()))
reader.start()
output = bytearray()
while True:
    try:
        chunk = os.read(leader, 65536)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
reader.join()
code = child.wait()
sys.stdout.buffer.write(output)
sys.stderr.buffer.write(errors[0])
sys.exit(code if code >= 0 else 128 - code)
`;

/** The command and arguments that run `command` with a terminal stdout. */
export const terminalStdoutInvocation = (
  command: string,
  arguments_: readonly string[],
): { readonly command: string; readonly arguments: readonly string[] } => {
  if (process.platform === "win32")
    throw new Error("A terminal stdout needs a POSIX pseudo-terminal.");
  return {
    command: "python3",
    arguments: ["-I", "-S", "-c", DRIVER, command, ...arguments_],
  };
};
