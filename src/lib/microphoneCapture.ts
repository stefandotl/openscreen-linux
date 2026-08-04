const VIRTUAL_DEFAULT_DEVICE_IDS = new Set(["default", "communications"]);

function describeMicrophone(deviceId: string | undefined, deviceName: string | undefined) {
	return deviceName?.trim() || deviceId?.trim() || "unknown microphone";
}

export function isConcreteMicrophoneDeviceId(deviceId: string | undefined): deviceId is string {
	const normalizedId = deviceId?.trim();
	return Boolean(normalizedId && !VIRTUAL_DEFAULT_DEVICE_IDS.has(normalizedId));
}

export async function assertSelectedMicrophoneAvailable(
	mediaDevices: MediaDevices,
	deviceId: string | undefined,
	deviceName: string | undefined,
) {
	const description = describeMicrophone(deviceId, deviceName);
	if (!isConcreteMicrophoneDeviceId(deviceId)) {
		throw new Error(
			`Microphone recording requires a specific input device. Select a microphone instead of "Default" (${description}).`,
		);
	}

	const devices = await mediaDevices.enumerateDevices();
	const selectedDevice = devices.find(
		(device) => device.kind === "audioinput" && device.deviceId === deviceId,
	);
	if (!selectedDevice) {
		throw new Error(`Selected microphone "${description}" is no longer available.`);
	}

	return deviceId;
}

export async function acquireSelectedMicrophone(
	mediaDevices: MediaDevices,
	deviceId: string | undefined,
	deviceName: string | undefined,
) {
	const selectedDeviceId = await assertSelectedMicrophoneAvailable(
		mediaDevices,
		deviceId,
		deviceName,
	);

	const stream = await mediaDevices.getUserMedia({
		audio: {
			deviceId: { exact: selectedDeviceId },
			echoCancellation: { exact: false },
			noiseSuppression: { exact: false },
			autoGainControl: { exact: false },
		},
		video: false,
	});
	const audioTracks = stream.getAudioTracks();
	const description = describeMicrophone(deviceId, deviceName);

	if (audioTracks.length !== 1) {
		stream.getTracks().forEach((track) => track.stop());
		throw new Error(
			`Selected microphone "${description}" returned ${audioTracks.length} audio tracks instead of exactly one.`,
		);
	}

	const settings = audioTracks[0].getSettings();
	const actualDeviceId = settings.deviceId;
	if (!actualDeviceId) {
		stream.getTracks().forEach((track) => track.stop());
		throw new Error(
			`The active audio track did not report a device ID for selected microphone "${description}".`,
		);
	}
	if (actualDeviceId !== selectedDeviceId) {
		stream.getTracks().forEach((track) => track.stop());
		throw new Error(
			`Microphone device mismatch: selected "${description}" (${selectedDeviceId}), but Chromium opened ${actualDeviceId}.`,
		);
	}

	const enabledProcessing = [
		["echo cancellation", settings.echoCancellation],
		["noise suppression", settings.noiseSuppression],
		["automatic gain control", settings.autoGainControl],
	]
		.filter(([, enabled]) => enabled !== false)
		.map(([name]) => name);
	if (enabledProcessing.length > 0) {
		stream.getTracks().forEach((track) => track.stop());
		throw new Error(
			`Chromium did not disable ${enabledProcessing.join(", ")} for selected microphone "${description}".`,
		);
	}

	return stream;
}
