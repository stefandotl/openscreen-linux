export type WebcamTrackEndState = {
	effectCancelled: boolean;
	acquisitionId: number;
	currentAcquisitionId: number;
	streamIsCurrent: boolean;
	recordingIsFinalizing: boolean;
	recordingIsRestarting: boolean;
};

export function isUnexpectedWebcamTrackEnd({
	effectCancelled,
	acquisitionId,
	currentAcquisitionId,
	streamIsCurrent,
	recordingIsFinalizing,
	recordingIsRestarting,
}: WebcamTrackEndState) {
	return (
		!effectCancelled &&
		acquisitionId === currentAcquisitionId &&
		streamIsCurrent &&
		!recordingIsFinalizing &&
		!recordingIsRestarting
	);
}
