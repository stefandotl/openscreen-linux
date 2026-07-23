export type CameraDeviceIdentity = {
	deviceId: string;
	label: string;
};

export function selectPreferredCameraDevice<T extends CameraDeviceIdentity>(
	devices: readonly T[],
	preferredDeviceId: string | undefined,
	preferredDeviceName: string | undefined,
): T | undefined {
	return (
		devices.find((device) => device.deviceId === preferredDeviceId) ??
		devices.find((device) => device.label === preferredDeviceName) ??
		devices[0]
	);
}
