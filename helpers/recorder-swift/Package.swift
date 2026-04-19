// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "stash-recorder",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "stash-recorder",
            path: "Sources/stash-recorder"
        )
    ]
)
