import { useEffect, useRef, useState } from "react";

const CAMERA_REFRESH_INTERVAL_MS = 2_000;

export interface CameraDevice {
	deviceId: string;
	label: string;
	groupId: string;
}

export function useCameraDevices(enabled: boolean = false) {
	const [devices, setDevices] = useState<CameraDevice[]>([]);
	const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const selectedDeviceIdRef = useRef(selectedDeviceId);
	selectedDeviceIdRef.current = selectedDeviceId;

	useEffect(() => {
		if (!enabled) return;
		let mounted = true;
		let enumerationInFlight = false;

		const loadDevices = async (showLoading = true) => {
			if (enumerationInFlight) return;
			enumerationInFlight = true;
			try {
				if (showLoading) {
					setIsLoading(true);
				}
				setError(null);

				// Enumerate without requesting a second stream; the recorder handles
				// the real acquisition. Unlabeled devices fall back to their device ID.
				const allDevices = await navigator.mediaDevices.enumerateDevices();
				const videoInputs = allDevices
					.filter((device) => device.kind === "videoinput")
					.map((device) => ({
						deviceId: device.deviceId,
						label: device.label || `Camera ${device.deviceId.slice(0, 8)}`,
						groupId: device.groupId,
					}));

				if (mounted) {
					setDevices(videoInputs);
					const currentId = selectedDeviceIdRef.current;
					const stillAvailable = videoInputs.some((d) => d.deviceId === currentId);
					if (!currentId || !stillAvailable) {
						setSelectedDeviceId(videoInputs[0]?.deviceId ?? "");
					}
					setIsLoading(false);
				}
			} catch (err) {
				if (mounted) {
					setError(err instanceof Error ? err.message : "Failed to load cameras");
					setIsLoading(false);
				}
			} finally {
				enumerationInFlight = false;
			}
		};

		void loadDevices();

		const handleDeviceChange = () => void loadDevices();
		navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
		// v4l2loopback devices can switch from output-only to capture-capable without
		// emitting Chromium's devicechange event. Refresh quietly so virtual cameras
		// such as DroidCam appear as soon as their producer starts writing frames.
		const refreshTimer = window.setInterval(
			() => void loadDevices(false),
			CAMERA_REFRESH_INTERVAL_MS,
		);
		return () => {
			mounted = false;
			window.clearInterval(refreshTimer);
			navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
		};
	}, [enabled]);

	return { devices, selectedDeviceId, setSelectedDeviceId, isLoading, error };
}
