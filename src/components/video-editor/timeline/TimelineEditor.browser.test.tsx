import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { I18nProvider } from "@/contexts/I18nContext";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";
import { type AnnotationRegion, DEFAULT_ANNOTATION_STYLE } from "../types";
import TimelineEditor from "./TimelineEditor";
import "@/index.css";

vi.mock("@/contexts/ShortcutsContext", () => ({
	useShortcuts: () => ({ shortcuts: DEFAULT_SHORTCUTS, isMac: false }),
}));

function annotation(id: string, startMs: number, endMs: number, caption = false): AnnotationRegion {
	return {
		id,
		content: id,
		startMs,
		endMs,
		type: "text",
		annotationSource: caption ? "auto-caption" : undefined,
		position: { x: 10, y: 60 },
		size: { width: 80, height: 20 },
		zIndex: 1,
		style: DEFAULT_ANNOTATION_STYLE,
	};
}

describe("content track interactions", () => {
	it("shows independent caption/text rows, keeps their time alignment and exposes media imports", async () => {
		await page.viewport(1200, 700);
		const container = document.createElement("div");
		container.style.cssText =
			"width:1000px;height:520px;display:flex;color:white;background:#09090b";
		document.body.append(container);
		const root = createRoot(container);
		const addAudio = vi.fn();
		const addImage = vi.fn();
		const addText = vi.fn();
		const captions = vi.fn();
		function Harness() {
			const [selected, setSelected] = useState<string | null>(null);
			return (
				<I18nProvider>
					<TimelineEditor
						videoDuration={10}
						currentTime={1}
						aspectRatio="16:9"
						videoUrl="file:///tmp/source.mp4"
						zoomRegions={[]}
						onZoomAdded={() => undefined}
						onZoomSpanChange={() => undefined}
						onZoomDelete={() => undefined}
						selectedZoomId={null}
						onSelectZoom={() => undefined}
						onAspectRatioChange={() => undefined}
						annotationRegions={[
							annotation("Title", 1000, 4000),
							annotation("Callout", 2000, 5000),
							annotation("First subtitle", 0, 3000, true),
							annotation("Second subtitle", 3000, 6000, true),
							annotation("Third subtitle", 6000, 9000, true),
						]}
						selectedAnnotationId={selected}
						onSelectAnnotation={setSelected}
						onAnnotationAdded={addText}
						onImportAudio={addAudio}
						onImportImage={addImage}
						onGenerateCaptions={captions}
						captionsLabel="Create subtitles"
					/>
					<output hidden>{selected}</output>
				</I18nProvider>
			);
		}
		try {
			await act(async () => root.render(<Harness />));
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			);
			expect(container.querySelectorAll('[data-track-id^="row-text-"]')).toHaveLength(2);
			expect(container.querySelectorAll('[data-track-id^="row-captions-"]')).toHaveLength(1);
			expect(container.querySelectorAll('[data-track-id^="row-audio-"]')).toHaveLength(0);
			const textRow = container.querySelector('[data-track-id="row-text-0"]')!;
			const captionRow = container.querySelector('[data-track-id="row-captions-0"]')!;
			expect(textRow.getBoundingClientRect().left).toBe(captionRow.getBoundingClientRect().left);
			const firstCaption = captionRow.querySelector('[role="button"]')!;
			expect(firstCaption.getBoundingClientRect().left).toBeCloseTo(
				captionRow.getBoundingClientRect().left,
				0,
			);
			await page.getByText("Callout", { exact: true }).click();
			expect(container.querySelector("output")?.textContent).toBe("Callout");
			await page.getByRole("button", { name: "Create subtitles", exact: true }).click();
			expect(captions).toHaveBeenCalledOnce();
			await page.getByRole("button", { name: "Add", exact: true }).click();
			expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
			await page.getByRole("menuitem", { name: "Import audio" }).click();
			expect(addAudio).toHaveBeenCalledOnce();
			await page.getByRole("button", { name: "Add", exact: true }).click();
			await page.getByRole("menuitem", { name: "Text", exact: true }).click();
			expect(addText).toHaveBeenCalledWith({ start: 1000, end: 2000 });
			await page.screenshot({ element: container, path: "/tmp/videtio-content-tracks.png" });
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
