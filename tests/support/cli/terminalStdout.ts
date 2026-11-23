/**
 * Run a command with stdout on a pseudo-terminal, so it sees
 * `process.stdout.isTTY` as a user's terminal would, while stdin stays empty
 * and stderr stays a separate pipe. Python's standard `pty` support provides
 * the terminal without a native Node dependency.
 *
 * The driver forks a relay that copies the terminal to its stdout as bytes
 * arrive, then replaces itself with the command. The process the caller
 * starts is therefore the command itself: its deadline signals (SIGTERM,
 * then SIGKILL) reach the command, and output written before a timeout is
 * already captured. The relay ends when the command's terminal closes.
 * Output post-processing is off, so the captured bytes are the ones the
 * command wrote, and the window is a fixed 80x24 so width-dependent output
 * does not follow the host.
 */
const DRIVER = String.raw`
import fcntl, os, struct, sys, termios

leader, follower = os.openpty()
attributes = termios.tcgetattr(follower)
attributes[1] &= ~termios.OPOST
termios.tcsetattr(follower, termios.TCSANOW, attributes)
fcntl.ioctl(follower, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
if os.fork() == 0:
    os.close(follower)
    while True:
        try:
            chunk = os.read(leader, 65536)
        except OSError:
            break
        if not chunk:
            break
        view = memoryview(chunk)
        while view:
            view = view[os.write(1, view):]
    os._exit(0)
os.close(leader)
empty = os.open(os.devnull, os.O_RDONLY)
os.dup2(empty, 0)
os.dup2(follower, 1)
os.close(empty)
os.close(follower)
os.execv(sys.argv[1], sys.argv[1:])
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
