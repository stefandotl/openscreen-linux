export type MacScreenAccessResolution = {
	granted: boolean;
	status: string;
};

export function resolveMacScreenAccessProbe(
	reportedStatus: string,
	availableSourceCount: number,
): MacScreenAccessResolution {
	if (reportedStatus === "granted" || availableSourceCount > 0) {
		return {
			granted: true,
			status: "granted",
		};
	}

	return {
		granted: false,
		status: reportedStatus,
	};
}
