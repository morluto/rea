package dev.rea.uiautomator;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.system.StructTimeval;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.function.Function;

/** One operator-owned, app-private socket; request bytes never enter shell argv or files. */
final class ReaUiSocket implements AutoCloseable {
  private final File path;
  private final int frameBytes;
  private final Function<String, String> exchange;
  private final LocalSocket binding = new LocalSocket(LocalSocket.SOCKET_STREAM);
  private LocalServerSocket listener;
  private StructStat identity;
  private volatile boolean closed;
  private volatile LocalSocket active;

  ReaUiSocket(File files, String instance, int frameBytes, Function<String, String> exchange) {
    path = new File(files, "rea-ui-" + instance + ".sock");
    this.frameBytes = frameBytes;
    this.exchange = exchange;
  }

  String relativePath() {
    return "files/" + path.getName();
  }

  void start() throws IOException, ErrnoException {
    if (path.getAbsolutePath().getBytes(StandardCharsets.UTF_8).length > 107)
      throw new IOException("Runner socket path exceeds the Unix-domain path limit");
    if (path.exists()) throw new IOException("Runner socket path already exists");
    binding.bind(
        new LocalSocketAddress(path.getAbsolutePath(), LocalSocketAddress.Namespace.FILESYSTEM));
    identity = Os.lstat(path.getAbsolutePath());
    listener = new LocalServerSocket(binding.getFileDescriptor());
    Thread thread = new Thread(this::serve, "rea-ui-input");
    thread.setDaemon(true);
    thread.start();
  }

  private void serve() {
    while (!closed) {
      try (LocalSocket connection = listener.accept()) {
        active = connection;
        if (closed) return;
        // run-as is admitted by Android for the operator's debuggable helper.
        // The private directory and peer UID both bind this channel to that app.
        if (connection.getPeerCredentials().getUid() != android.os.Process.myUid()) continue;
        connection.setSoTimeout(5000);
        Os.setsockoptTimeval(
            connection.getFileDescriptor(),
            OsConstants.SOL_SOCKET,
            OsConstants.SO_SNDTIMEO,
            StructTimeval.fromMillis(5000));
        BufferedInputStream input = new BufferedInputStream(connection.getInputStream(), 4096);
        ByteArrayOutputStream frame = new ByteArrayOutputStream(1024);
        for (; ; ) {
          int value = input.read();
          if (value < 0) throw new IOException("Incomplete UI request frame");
          if (value == '\n') break;
          if (frame.size() >= frameBytes)
            throw new IOException("UI request exceeds the frame budget");
          if (value > 127) throw new IOException("UI request frame must be ASCII base64");
          frame.write(value);
        }
        byte[] response =
            (exchange.apply(frame.toString("US-ASCII")) + "\n").getBytes(StandardCharsets.US_ASCII);
        connection.getOutputStream().write(response);
      } catch (IOException | ErrnoException failure) {
        // Input/peer failure has no authority to admit an operation. Prepared
        // requests remain cancellable through the independent control channel.
        if (closed) return;
      } finally {
        active = null;
      }
    }
  }

  @Override
  public void close() throws IOException {
    closed = true;
    IOException failure = null;
    LocalSocket connection = active;
    try {
      if (connection != null) connection.close();
    } catch (IOException cause) {
      failure = cause;
    }
    try {
      if (listener != null) listener.close();
    } catch (IOException cause) {
      if (failure == null) failure = cause;
      else failure.addSuppressed(cause);
    }
    try {
      binding.close();
    } catch (IOException cause) {
      if (failure == null) failure = cause;
      else failure.addSuppressed(cause);
    }
    if (identity != null) {
      try {
        StructStat current = Os.lstat(path.getAbsolutePath());
        if (current.st_dev != identity.st_dev
            || current.st_ino != identity.st_ino
            || current.st_uid != identity.st_uid
            || !OsConstants.S_ISSOCK(current.st_mode))
          throw new IOException("Runner socket identity changed before cleanup: " + path);
        Os.remove(path.getAbsolutePath());
      } catch (ErrnoException cause) {
        if (cause.errno != OsConstants.ENOENT) {
          IOException wrapped = new IOException("Runner socket cleanup failed: " + path, cause);
          if (failure == null) failure = wrapped;
          else failure.addSuppressed(wrapped);
        }
      } catch (IOException cause) {
        if (failure == null) failure = cause;
        else failure.addSuppressed(cause);
      }
    }
    if (failure != null) throw failure;
  }
}
