import { useTimelineContext } from "dnd-timeline";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { mergeConnectedTrimRegions } from "../trimRegions";
import Item from "./Item";
import Row from "./Row";
import TimelineWrapper from "./TimelineWrapper";

type BrowserTrim = { id: string; startMs: number; endMs: number };

function MergeTrack({ trims }: { trims: BrowserTrim[] }) {
	const { setTimelineRef, style } = useTimelineContext();
	return (
		<div ref={setTimelineRef} style={{ ...style, width: 800, height: 50 }}>
			<Row id="trim">
				{trims.map((trim) => (
					<Item
						key={trim.id}
						id={trim.id}
						rowId="trim"
						span={{ start: trim.startMs, end: trim.endMs }}
						variant="trim"
					>
						{trim.id}
					</Item>
				))}
			</Row>
			<output>{JSON.stringify(trims)}</output>
		</div>
	);
}

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

	it("joins three trims when one handle is dragged across the other two", async () => {
		function MergeHarness() {
			const [trims, setTrims] = useState([
				{ id: "first", startMs: 1000, endMs: 2000 },
				{ id: "second", startMs: 3000, endMs: 4000 },
				{ id: "third", startMs: 5000, endMs: 6000 },
			]);
			return (
				<I18nProvider>
					<TimelineWrapper
						range={{ start: 0, end: 10000 }}
						videoDuration={10}
						minItemDurationMs={100}
						minVisibleRangeMs={1000}
						onRangeChange={() => undefined}
						hasOverlap={() => true}
						allRegionSpans={trims.map((trim) => ({
							id: trim.id,
							start: trim.startMs,
							end: trim.endMs,
							rowId: "trim",
						}))}
						mergeableTrimIds={trims.map((trim) => trim.id)}
						onItemSpanChange={(id, span) =>
							setTrims((previous) =>
								mergeConnectedTrimRegions(
									previous.map((trim) =>
										trim.id === id
											? { ...trim, startMs: Math.round(span.start), endMs: Math.round(span.end) }
											: trim,
									),
									{ preferredId: id, mergeTouching: true },
								),
							)
						}
					>
						<MergeTrack trims={trims} />
					</TimelineWrapper>
				</I18nProvider>
			);
		}
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<MergeHarness />));
			await nextFrame();
			await nextFrame();
			const cap = container.querySelector('[title="Resize right"]') as HTMLElement;
			const rect = cap.getBoundingClientRect();
			expect(rect.width).toBeGreaterThan(0);
			expect(rect.left).toBeGreaterThan(0);
			const pointer = {
				bubbles: true,
				pointerId: 2,
				pointerType: "mouse",
				isPrimary: true,
				button: 0,
				buttons: 1,
				clientY: rect.top + 5,
			};
			await act(async () => {
				cap.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: rect.left + 2 }));
			});
			await act(async () => {
				window.dispatchEvent(
					new PointerEvent("pointermove", { ...pointer, clientX: rect.left + 362 }),
				);
			});
			await act(async () => {
				window.dispatchEvent(
					new PointerEvent("pointerup", { ...pointer, buttons: 0, clientX: rect.left + 362 }),
				);
			});
			expect(JSON.parse(container.querySelector("output")!.textContent!)).toEqual([
				{ id: "first", startMs: 1000, endMs: 6500 },
			]);
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
