// swift-tools-version: 5.9

import PackageDescription

let package = Package(
	name: "VidetioScreenCaptureKitHelper",
	platforms: [
		.macOS(.v13)
	],
	products: [
		.executable(
			name: "videtio-screencapturekit-helper",
			targets: ["VidetioScreenCaptureKitHelper"]
		),
		.executable(
			name: "videtio-macos-cursor-helper",
			targets: ["VidetioMacOSCursorHelper"]
		)
	],
	targets: [
		.executableTarget(
			name: "VidetioScreenCaptureKitHelper",
			dependencies: ["MicrophoneDeviceMatching"],
			path: "Sources/VidetioScreenCaptureKitHelper"
		),
		.executableTarget(
			name: "VidetioMacOSCursorHelper",
			path: "Sources/VidetioMacOSCursorHelper"
		),
		.testTarget(
			name: "MicrophoneDeviceMatchingTests",
			dependencies: ["MicrophoneDeviceMatching"],
			path: "Tests/MicrophoneDeviceMatchingTests"
		),
		.target(
			name: "MicrophoneDeviceMatching",
			path: "Sources/MicrophoneDeviceMatching"
		)
	]
)
