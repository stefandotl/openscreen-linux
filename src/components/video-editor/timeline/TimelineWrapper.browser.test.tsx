import { useTimelineContext } from "dnd-timeline";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import Item from "./Item";
import Row from "./Row";
import TimelineWrapper from "./TimelineWrapper";

function Track({ span }: { span: { start: number; end: number } }) {
	const { setTimelineRef, style } = useTimelineContext();
	return (
		<div ref={setTimelineRef} style={{ ...style, width: 800, height: 50 }}>
			<Row id="trim">
				<Item id="trim-1" rowId="trim" span={span} variant="trim">
					Trim
				</Item>
			</Row>
		</div>
	);
}

function Harness({
	initial,
	range,
}: {
	initial: { start: number; end: number };
	range: { start: number; end: number };
}) {
	const [span, setSpan] = useState(initial);
	return (
		<I18nProvider>
			<TimelineWrapper
				range={range}
				videoDuration={10}
				minItemDurationMs={100}
				minVisibleRangeMs={1000}
				onRangeChange={() => undefined}
				hasOverlap={() => false}
				allRegionSpans={[{ id: "trim-1", ...span, rowId: "trim" }]}
				onItemSpanChange={(_, value) => setSpan(value)}
			>
				<Track span={span} />
				<output>{JSON.stringify(span)}</output>
			</TimelineWrapper>
		</I18nProvider>
	);
}

async function nextFrame() {
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

describe("timeline pointer resize", () => {
	it.each([
		{
			initial: { start: 1000, end: 3000 },
			range: { start: 0, end: 10000 },
			edge: "left",
			delta: -160,
			expected: { start: 0, end: 3000 },
		},
		{
			initial: { start: 7000, end: 9000 },
			range: { start: 0, end: 10000 },
			edge: "right",
			delta: 160,
			expected: { start: 7000, end: 10000 },
		},
		{
			initial: { start: 3000, end: 4500 },
			range: { start: 2000, end: 5000 },
			edge: "right",
			delta: 800 / 3,
			expected: { start: 3000, end: 5500 },
		},
	])("anchors the opposite edge when resizing $edge in $range", async ({
		initial,
		range,
		edge,
		delta,
		expected,
	}) => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(<Harness initial={initial} range={range} />);
			});
			await nextFrame();
			await nextFrame();
			const cap = container.querySelector(`[title="Resize ${edge}"]`) as HTMLElement;
			expect(cap).not.toBeNull();
			const item = cap.closest('[role="button"]') as HTMLElement;
			const rect = item.getBoundingClientRect();
			const clientX = edge === "left" ? rect.left + 2 : rect.right - 2;
			const pointer = {
				bubbles: true,
				pointerId: 1,
				pointerType: "mouse",
				isPrimary: true,
				button: 0,
				buttons: 1,
				clientY: rect.top + 15,
			};
			await act(async () => {
				cap.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX }));
			});
			await act(async () => {
				window.dispatchEvent(
					new PointerEvent("pointermove", { ...pointer, clientX: clientX + delta }),
				);
			});
			await act(async () => {
				window.dispatchEvent(
					new PointerEvent("pointerup", { ...pointer, buttons: 0, clientX: clientX + delta }),
				);
			});
			const actual = JSON.parse(container.querySelector("output")!.textContent!);
			expect(actual.start).toBeCloseTo(expected.start, 5);
			expect(actual.end).toBeCloseTo(expected.end, 5);
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
