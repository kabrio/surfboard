import Darwin
import Foundation
import SurfboardNativeHostCore

private let sendLock = NSLock()
private let decoder = JSONDecoder()
private let encoder = JSONEncoder()
nonisolated(unsafe) private var session: PtySession?

func readExactly(_ count: Int) throws -> Data {
  var result = Data()
  result.reserveCapacity(count)

  while result.count < count {
    var buffer = [UInt8](repeating: 0, count: count - result.count)
    let amount = buffer.withUnsafeMutableBytes { bytes in
      Darwin.read(STDIN_FILENO, bytes.baseAddress, bytes.count)
    }
    if amount > 0 {
      result.append(contentsOf: buffer.prefix(amount))
      continue
    }
    if amount == 0 {
      throw NativeHostError.endOfInput
    }
    if errno == EINTR {
      continue
    }
    throw NativeHostError.readFailed(errno)
  }

  return result
}

func readRequest() throws -> NativeHostRequest {
  let lengthData = try readExactly(4)
  guard let length = NativeHostProtocol.decodeLength(lengthData) else {
    throw NativeHostError.invalidMessage
  }
  guard length > 0, length <= NativeHostProtocol.maximumMessageBytes else {
    throw NativeHostError.invalidLength(length)
  }
  let payload = try readExactly(length)
  do {
    return try decoder.decode(NativeHostRequest.self, from: payload)
  } catch {
    throw NativeHostError.invalidMessage
  }
}

func send(_ response: NativeHostResponse) {
  let frame: Data
  do {
    frame = try NativeHostProtocol.frame(response, encoder: encoder)
  } catch {
    return
  }

  sendLock.lock()
  defer { sendLock.unlock() }
  frame.withUnsafeBytes { bytes in
    var offset = 0
    while offset < bytes.count {
      let count = Darwin.write(
        STDOUT_FILENO,
        bytes.baseAddress?.advanced(by: offset),
        bytes.count - offset
      )
      if count > 0 {
        offset += count
      } else if count < 0 && errno == EINTR {
        continue
      } else {
        return
      }
    }
  }
}

func sendError(_ error: Error) {
  let nativeError = error as? NativeHostError
  send(
    NativeHostResponse(
      type: "error",
      message: nativeError?.message ?? "Unexpected native host error."
    )
  )
}

func openSession(_ request: NativeHostRequest) throws {
  guard session == nil else {
    throw NativeHostError.invalidRequest("The terminal session is already open.")
  }
  let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
  let cols = min(max(request.cols ?? 80, 2), 1_000)
  let rows = min(max(request.rows ?? 24, 1), 500)
  let created = try PtySession(shell: shell, cols: cols, rows: rows)
  session = created
  send(
    NativeHostResponse(
      type: "opened",
      pid: created.pid,
      shell: URL(fileURLWithPath: shell).lastPathComponent
    )
  )
  created.beginReading(
    output: { data in
      send(
        NativeHostResponse(
          type: "data",
          data: data.base64EncodedString()
        )
      )
    },
    exited: { status in
      send(NativeHostResponse(type: "exited", status: status))
    }
  )
}

defer { session?.close() }

while true {
  do {
    let request = try readRequest()
    switch request.type {
    case "open":
      try openSession(request)
    case "input":
      guard
        let encoded = request.data,
        let data = Data(base64Encoded: encoded)
      else {
        throw NativeHostError.invalidRequest("Terminal input is not valid base64.")
      }
      guard let session else { throw NativeHostError.noSession }
      try session.write(data)
    case "resize":
      guard let cols = request.cols, let rows = request.rows else {
        throw NativeHostError.invalidRequest("Terminal resize is missing dimensions.")
      }
      guard let session else { throw NativeHostError.noSession }
      try session.resize(
        cols: min(max(cols, 2), 1_000),
        rows: min(max(rows, 1), 500)
      )
    case "close":
      session?.close()
      session = nil
      send(NativeHostResponse(type: "closed"))
      exit(0)
    default:
      throw NativeHostError.invalidRequest(
        "Unknown native host request: \(request.type)"
      )
    }
  } catch NativeHostError.endOfInput {
    break
  } catch {
    sendError(error)
  }
}
