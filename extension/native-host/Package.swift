// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "surfboard-native-host",
  platforms: [.macOS(.v13)],
  products: [
    .executable(
      name: "surfboard-native-host",
      targets: ["surfboard-native-host"]
    )
  ],
  targets: [
    .target(
      name: "SurfboardNativeHostCore"
    ),
    .executableTarget(
      name: "surfboard-native-host",
      dependencies: ["SurfboardNativeHostCore"]
    ),
    .testTarget(
      name: "SurfboardNativeHostCoreTests",
      dependencies: ["SurfboardNativeHostCore"]
    ),
  ]
)
