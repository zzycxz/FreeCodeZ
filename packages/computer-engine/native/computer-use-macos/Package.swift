// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "FreeCodeZComputerUseMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "FreeCodeZComputerUseMacOSCore",
            targets: ["FreeCodeZComputerUseMacOSCore"]
        ),
        .executable(
            name: "freecodez-computer-use-macos",
            targets: ["FreeCodeZComputerUseMacOS"]
        )
    ],
    targets: [
        .target(
            name: "FreeCodeZComputerUseMacOSCore",
            path: "Sources/FreeCodeZComputerUseMacOSCore"
        ),
        .executableTarget(
            name: "FreeCodeZComputerUseMacOS",
            dependencies: ["FreeCodeZComputerUseMacOSCore"],
            path: "Sources/FreeCodeZComputerUseMacOS"
        ),
        .testTarget(
            name: "FreeCodeZComputerUseMacOSTests",
            dependencies: ["FreeCodeZComputerUseMacOSCore"],
            path: "Tests/FreeCodeZComputerUseMacOSTests"
        )
    ]
)
