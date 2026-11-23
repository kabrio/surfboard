import Foundation
import Testing
@testable import SurfboardNativeHostCore

private struct Probe: Codable {
  let type: String
}

struct NativeMessagingTests {
  @Test func decodesLittleEndianLength() {
    let bytes = Data([0x78, 0x56, 0x34, 0x12])
    #expect(NativeHostProtocol.decodeLength(bytes) == 0x1234_5678)
  }

  @Test func framesJSONPayload() throws {
    let frame = try NativeHostProtocol.frame(Probe(type: "open"))
    let length = NativeHostProtocol.decodeLength(frame.prefix(4).data)
    #expect(length == frame.count - 4)
    #expect(String(data: frame.dropFirst(4), encoding: .utf8) == #"{"type":"open"}"#)
  }

  @Test func decodesNativeRequest() throws {
    let request = try JSONDecoder().decode(
      NativeHostRequest.self,
      from: Data(#"{"type":"resize","cols":120,"rows":40}"#.utf8)
    )
    #expect(
      request
        == NativeHostRequest(type: "resize", data: nil, cols: 120, rows: 40)
    )
  }
}

private extension Data.SubSequence {
  var data: Data {
    Data(self)
  }
}
