import Darwin
import Foundation

public final class PtySession: @unchecked Sendable {
  private let masterDescriptor: Int32
  private let processID: pid_t
  private let outputQueue = DispatchQueue(
    label: "com.kabrio.surfboard-terminal.pty"
  )
  private let stateLock = NSLock()
  private var closed = false

  public let shell: String

  public var pid: Int32 {
    Int32(processID)
  }

  public init(shell: String, cols: Int, rows: Int) throws {
    var master: Int32 = -1
    var size = winsize(
      ws_row: UInt16(clamping: rows),
      ws_col: UInt16(clamping: cols),
      ws_xpixel: 0,
      ws_ypixel: 0
    )
    let processID = shell.withCString { shellCString in
      forkpty(&master, nil, nil, &size).andThenChild {
        setenv("TERM", "xterm-256color", 1)
        setenv("COLORTERM", "truecolor", 1)
        var arguments: [UnsafeMutablePointer<CChar>?] = [
          strdup(shellCString),
          strdup("-l"),
          nil,
        ]
        _ = arguments.withUnsafeMutableBufferPointer { buffer in
          execv(shellCString, buffer.baseAddress)
        }
        Darwin._exit(127)
      }
    }
    guard processID > 0, master >= 0 else {
      throw NativeHostError.ptyFailed
    }
    self.masterDescriptor = master
    self.processID = processID
    self.shell = shell
  }

  public func beginReading(
    output: @escaping @Sendable (Data) -> Void,
    exited: @escaping @Sendable (Int32) -> Void
  ) {
    outputQueue.async { [weak self] in
      guard let self else { return }
      var buffer = [UInt8](repeating: 0, count: 16_384)
      while !self.isClosed {
        let count = buffer.withUnsafeMutableBytes { bytes in
          Darwin.read(
            self.masterDescriptor,
            bytes.baseAddress,
            bytes.count
          )
        }
        if count > 0 {
          output(Data(buffer.prefix(count)))
          continue
        }
        if count < 0 && errno == EINTR {
          continue
        }
        if self.isClosed {
          return
        }

        var status: Int32 = 0
        while waitpid(self.processID, &status, 0) < 0 && errno == EINTR {}
        exited(self.exitStatus(status))
        self.markClosed()
        return
      }
    }
  }

  public func write(_ data: Data) throws {
    guard !isClosed else { throw NativeHostError.noSession }
    try data.withUnsafeBytes { bytes in
      var offset = 0
      while offset < bytes.count {
        let count = Darwin.write(
          masterDescriptor,
          bytes.baseAddress?.advanced(by: offset),
          bytes.count - offset
        )
        if count > 0 {
          offset += count
          continue
        }
        if count < 0 && errno == EINTR {
          continue
        }
        throw NativeHostError.readFailed(errno)
      }
    }
  }

  public func resize(cols: Int, rows: Int) throws {
    guard !isClosed else { throw NativeHostError.noSession }
    var size = winsize(
      ws_row: UInt16(clamping: rows),
      ws_col: UInt16(clamping: cols),
      ws_xpixel: 0,
      ws_ypixel: 0
    )
    guard ioctl(masterDescriptor, TIOCSWINSZ, &size) == 0 else {
      throw NativeHostError.readFailed(errno)
    }
  }

  public func close() {
    guard !isClosed else { return }
    markClosed()
    kill(-processID, SIGHUP)
    kill(processID, SIGTERM)
    Darwin.close(masterDescriptor)
    var status: Int32 = 0
    waitpid(processID, &status, WNOHANG)
  }

  private var isClosed: Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return closed
  }

  private func markClosed() {
    stateLock.lock()
    closed = true
    stateLock.unlock()
  }

  private func exitStatus(_ status: Int32) -> Int32 {
    if (status & 0x7f) == 0 {
      return (status >> 8) & 0xff
    }
    return 128 + (status & 0x7f)
  }
}

private extension pid_t {
  func andThenChild(_ operation: () -> Never) -> pid_t {
    if self == 0 {
      operation()
    }
    return self
  }
}
