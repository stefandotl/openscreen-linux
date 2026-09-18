import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import VideoPlayback from "./VideoPlayback";

describe("VideoPlayback preview preparation", () => {
	it("does not give the media element an empty source while preview media is preparing", () => {
		const markup = renderToStaticMarkup(
			<VideoPlayback
				videoPath="file:///recordings/source.webm"
				webcamLayoutPreset="picture-in-picture"
				onDurationChange={vi.fn()}
				onTimeUpdate={vi.fn()}
				currentTime={0}
				onPlayStateChange={vi.fn()}
				onError={vi.fn()}
				zoomRegions={[]}
				selectedZoomId={null}
				onSelectZoom={vi.fn()}
				onZoomFocusChange={vi.fn()}
				isPlaying={false}
				aspectRatio="16:9"
			/>,
		);

		expect(markup).toContain("<video");
		expect(markup).not.toContain('src=""');
		expect(markup).not.toContain('src="file:///recordings/source.webm"');
	});
});
