import MicrophoneDeviceMatching
import XCTest

final class MicrophoneDeviceMatchingTests: XCTestCase {
	func testMatchesChromiumBuiltInSuffixToNativeDeviceName() {
		let result = uniqueDeviceNameMatch(
			candidateNames: ["MacBook Air-Mikrofon", "Studio Display Microphone"],
			requestedName: "MacBook Air-Mikrofon (Built-in)"
		)

		XCTAssertEqual(result, .match(0))
	}

	func testMatchesLocalizedMicrophoneWord() {
		let result = uniqueDeviceNameMatch(
			candidateNames: ["MacBook Air Microphone", "Studio Display Microphone"],
			requestedName: "MacBook Air-Mikrofon (Built-in)"
		)

		XCTAssertEqual(result, .match(0))
	}

	func testPrefersExactMatchOverPartialMatch() {
		let result = uniqueDeviceNameMatch(
			candidateNames: ["Studio Microphone", "Studio Microphone Pro"],
			requestedName: "Studio Microphone Pro"
		)

		XCTAssertEqual(result, .match(1))
	}

	func testRejectsAmbiguousMatches() {
		let result = uniqueDeviceNameMatch(
			candidateNames: ["USB Microphone", "USB Microphone"],
			requestedName: "USB Microphone (Built-in)"
		)

		XCTAssertEqual(result, .ambiguous)
	}

	func testRejectsUnrelatedDeviceNames() {
		let result = uniqueDeviceNameMatch(
			candidateNames: ["Studio Display Microphone"],
			requestedName: "MacBook Air-Mikrofon (Built-in)"
		)

		XCTAssertEqual(result, .none)
	}
}
