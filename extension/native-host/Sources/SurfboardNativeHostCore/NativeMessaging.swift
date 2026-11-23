import Foundation

public enum NativeHostProtocol {
  public static let maximumMessageBytes = 1_048_576

  public static func decodeLength(_ bytes: Data) -> Int? {
    guard bytes.count == 4 else { return nil }
    let length = bytes.withUnsafeBytes { buffer in
      buffer.loadUnaligned(as: UInt32.self)
    }
    return Int(UInt32(littleEndian: length))
  }

  public static func frame<Message: Encodable>(
    _ message: Message,
    encoder: JSONEncoder = JSONEncoder()
  ) throws -> Data {
    let payload = try encoder.encode(message)
    guard payload.count <= maximumMessageBytes else {
      throw NativeHostError.messageTooLarge(payload.count)
    }

    var length = UInt32(payload.count).littleEndian
    var frame = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
    frame.append(payload)
    return frame
  }
}

public enum NativeHostError: Error {
  case endOfInput
  case readFailed(Int32)
  case invalidLength(Int)
  case messageTooLarge(Int)
  case invalidMessage
  case invalidRequest(String)
  case ptyFailed
  case shellLaunchFailed(Int32)
  case noSession

  public var message: String {
    switch self {
    case .endOfInput:
      "Browser closed the native connection."
    case let .readFailed(code):
      "Unable to read a native message (errno \(code))."
    case let .invalidLength(length):
      "Native message length \(length) is invalid."
    case let .messageTooLarge(length):
      "Native message is too large (\(length) bytes)."
    case .invalidMessage:
      "Browser sent an invalid native message."
    case let .invalidRequest(value):
      value
    case .ptyFailed:
      "Unable to allocate a pseudo-terminal."
    case let .shellLaunchFailed(code):
      "Unable to launch shell (errno \(code))."
    case .noSession:
      "The terminal session is not open."
    }
  }
}

public struct NativeHostRequest: Decodable, Equatable {
  public let type: String
  public let data: String?
  public let cols: Int?
  public let rows: Int?
}

public struct NativeHostResponse: Encodable {
  public let type: String
  public let pid: Int32?
  public let shell: String?
  public let data: String?
  public let status: Int32?
  public let message: String?

  public init(
    type: String,
    pid: Int32? = nil,
    shell: String? = nil,
    data: String? = nil,
    status: Int32? = nil,
    message: String? = nil
  ) {
    self.type = type
    self.pid = pid
    self.shell = shell
    self.data = data
    self.status = status
    self.message = message
  }
}
