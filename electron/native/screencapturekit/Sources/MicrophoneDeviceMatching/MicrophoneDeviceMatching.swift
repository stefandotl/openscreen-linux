import Foundation

public enum UniqueDeviceNameMatch: Equatable {
	case match(Int)
	case ambiguous
	case none
}

private func normalizedDeviceName(_ value: String) -> String {
	let folded = value.folding(
		options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
		locale: .current
	)
	let words = folded.unicodeScalars.split { !CharacterSet.alphanumerics.contains($0) }
	return words.map(String.init).joined(separator: " ")
}

private func canonicalMicrophoneName(_ value: String) -> String {
	var words = normalizedDeviceName(value).split(separator: " ").map(String.init)

	if Array(words.suffix(2)) == ["built", "in"] {
		words.removeLast(2)
	} else if words.last == "integriert" {
		words.removeLast()
	}

	return words.map { $0 == "mikrofon" ? "microphone" : $0 }.joined(separator: " ")
}

private func deviceNameMatchScore(candidateName: String, requestedName: String) -> Int {
	let candidate = normalizedDeviceName(candidateName)
	let requested = normalizedDeviceName(requestedName)
	guard !candidate.isEmpty, !requested.isEmpty else {
		return 0
	}

	if candidate == requested {
		return 1_000
	}
	if candidate.contains(requested) || requested.contains(candidate) {
		return 900
	}

	let canonicalCandidate = canonicalMicrophoneName(candidateName)
	let canonicalRequested = canonicalMicrophoneName(requestedName)
	guard !canonicalCandidate.isEmpty, !canonicalRequested.isEmpty else {
		return 0
	}
	if canonicalCandidate == canonicalRequested {
		return 800
	}
	if canonicalCandidate.contains(canonicalRequested) || canonicalRequested.contains(canonicalCandidate) {
		return 700
	}

	return 0
}

public func uniqueDeviceNameMatch(
	candidateNames: [String],
	requestedName: String
) -> UniqueDeviceNameMatch {
	var bestIndex: Int?
	var bestScore = 0
	var bestMatchIsAmbiguous = false

	for (index, candidateName) in candidateNames.enumerated() {
		let score = deviceNameMatchScore(candidateName: candidateName, requestedName: requestedName)
		if score > bestScore {
			bestIndex = index
			bestScore = score
			bestMatchIsAmbiguous = false
		} else if score > 0, score == bestScore {
			bestMatchIsAmbiguous = true
		}
	}

	guard let bestIndex else {
		return .none
	}
	return bestMatchIsAmbiguous ? .ambiguous : .match(bestIndex)
}
