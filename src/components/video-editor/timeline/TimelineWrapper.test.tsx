import { act, cleanup, render } from "@testing-library/react";
import type { DragEndEvent, ResizeMoveEvent, Span, TimelineContextProps } from "dnd-timeline";
import { afterEach, describe, expect, it, vi } from "vitest";
import TimelineWrapper from "./TimelineWrapper";

const mocks = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("dnd-timeline", () => ({
	TimelineContext: (props: TimelineContextProps) => {
		mocks.context(props);
		return props.children;
	},
	useTimelineContext: () => ({
		sidebarWidth: 0,
		direction: "ltr",
		range: { start: 0, end: 10000 },
		valueToPixels: (n: number) => n,
	}),
}));
afterEach(cleanup);

function setup(
	original: Span,
	siblings: { id: string; start: number; end: number; rowId?: string }[] = [],
	range = { start: 0, end: 10000 },
	mergeableTrimIds: string[] = [],
) {
	const onItemSpanChange = vi.fn();
	const allRegionSpans = [{ id: "trim", ...original, rowId: "trim" }, ...siblings];
	render(
		<TimelineWrapper
			range={range}
			videoDuration={10}
			minItemDurationMs={100}
			minVisibleRangeMs={1000}
			onRangeChange={vi.fn()}
			onItemSpanChange={onItemSpanChange}
			hasOverlap={(span, excludeId) =>
				allRegionSpans.some(
					(region) =>
						region.id !== excludeId &&
						region.rowId === "trim" &&
						span.end > region.start &&
						span.start < region.end,
				)
			}
			allRegionSpans={allRegionSpans}
			mergeableTrimIds={mergeableTrimIds}
		>
			<div />
		</TimelineWrapper>,
	);
	const resize = (direction: "start" | "end", span: Span) => {
		const event: ResizeMoveEvent = {
			active: {
				id: "trim",
				data: { current: { span: original, getSpanFromResizeEvent: () => span } },
			},
			direction,
			delta: { x: 0 },
			activatorEvent: new Event("pointermove"),
		};
		const props = mocks.context.mock.calls.at(-1)?.[0] as TimelineContextProps;
		act(() => {
			props.onResizeMove?.(event);
			props.onResizeEnd?.(event);
		});
	};
	const drag = (span: Span) => {
		const event: DragEndEvent = {
			active: {
				id: "trim",
				data: { current: { span: original, getSpanFromDragEvent: () => span } },
			},
			over: { id: "trim" },
			delta: { x: 0 },
			activatorEvent: new Event("pointermove"),
		};
		const props = mocks.context.mock.calls.at(-1)?.[0] as TimelineContextProps;
		act(() => props.onDragEnd?.(event));
	};
	return { resize, drag, onItemSpanChange };
}

describe("timeline resize boundaries", () => {
	it("does not snap a handle that was clicked without moving", () => {
		const original = { start: 40, end: 3000 };
		const { resize, onItemSpanChange } = setup(original);
		resize("start", original);
		expect(onItemSpanChange).toHaveBeenLastCalledWith("trim", original);
	});
	it("keeps the right edge fixed when the left handle is dragged past zero", () => {
		const { resize, onItemSpanChange } = setup({ start: 1000, end: 3000 });
		resize("start", { start: -500, end: 3000 });
		expect(onItemSpanChange).toHaveBeenLastCalledWith("trim", { start: 0, end: 3000 });
	});
	it("keeps the left edge fixed when the right handle passes the recording end", () => {
		const { resize, onItemSpanChange } = setup({ start: 7000, end: 9000 });
		resize("end", { start: 7000, end: 11000 });
		expect(onItemSpanChange).toHaveBeenLastCalledWith("trim", { start: 7000, end: 10000 });
	});
	it.each([
		"start",
		"end",
	] as const)("does not move the opposite edge when the %s handle crosses it", (direction) => {
		const { resize, onItemSpanChange } = setup({ start: 1000, end: 3000 });
		resize(
			direction,
			direction === "start" ? { start: 4000, end: 3000 } : { start: 1000, end: 500 },
		);
		expect(onItemSpanChange).toHaveBeenLastCalledWith(
			"trim",
			direction === "start" ? { start: 2900, end: 3000 } : { start: 1000, end: 1100 },
		);
	});
	it("uses actual recording bounds when resized beyond the zoomed viewport", () => {
		const { resize, onItemSpanChange } = setup({ start: 3000, end: 4500 }, [], {
			start: 2000,
			end: 5000,
		});
		resize("end", { start: 3000, end: 5500 });
		expect(onItemSpanChange).toHaveBeenLastCalledWith("trim", { start: 3000, end: 5500 });
	});
	it("stops at a trim neighbour without being constrained by other tracks", () => {
		const { resize, onItemSpanChange } = setup({ start: 3000, end: 4500 }, [
			{ id: "zoom", start: 4600, end: 5500, rowId: "zoom" },
			{ id: "next-trim", start: 6000, end: 7000, rowId: "trim" },
		]);
		resize("end", { start: 3000, end: 8000 });
		expect(onItemSpanChange).toHaveBeenLastCalledWith("trim", { start: 3000, end: 6000 });
	});
	it("extends across several editable trims in one resize", () => {
		const { resize, onItemSpanChange } = setup(
			{ start: 1000, end: 2000 },
			[
				{ id: "second", start: 3000, end: 4000, rowId: "trim" },
				{ id: "third", start: 5000, end: 6000, rowId: "trim" },
			],
			undefined,
			["trim", "second", "third"],
		);
		resize("end", { start: 1000, end: 5500 });
		expect(onItemSpanChange).toHaveBeenLastCalledWith("trim", { start: 1000, end: 5500 });
	});
	it("merges the whole path when dragged past several editable trims", () => {
		const { drag, onItemSpanChange } = setup(
			{ start: 1000, end: 2000 },
			[
				{ id: "second", start: 3000, end: 4000, rowId: "trim" },
				{ id: "third", start: 5000, end: 6000, rowId: "trim" },
			],
			undefined,
			["trim", "second", "third"],
		);
		drag({ start: 6500, end: 7500 });
		expect(onItemSpanChange).toHaveBeenLastCalledWith("trim", { start: 1000, end: 7500 });
	});
	it("merges the whole path when dragged left across several trims", () => {
		const { drag, onItemSpanChange } = setup(
			{ start: 7000, end: 8000 },
			[
				{ id: "first", start: 2000, end: 3000, rowId: "trim" },
				{ id: "second", start: 4500, end: 5500, rowId: "trim" },
			],
			undefined,
			["trim", "first", "second"],
		);
		drag({ start: 1000, end: 2000 });
		expect(onItemSpanChange).toHaveBeenLastCalledWith("trim", { start: 1000, end: 8000 });
	});
	it("still moves a trim normally when no other trim is crossed", () => {
		const { drag, onItemSpanChange } = setup(
			{ start: 1000, end: 2000 },
			[{ id: "later", start: 6000, end: 7000, rowId: "trim" }],
			undefined,
			["trim", "later"],
		);
		drag({ start: 3000, end: 4000 });
		expect(onItemSpanChange).toHaveBeenLastCalledWith("trim", { start: 3000, end: 4000 });
	});
	it("keeps locked scene boundaries when a trim is resized", () => {
		const { resize, onItemSpanChange } = setup(
			{ start: 1000, end: 2000 },
			[
				{ id: "second", start: 3000, end: 4000, rowId: "trim" },
				{ id: "locked", start: 5000, end: 6000, rowId: "trim" },
			],
			undefined,
			["trim", "second"],
		);
		resize("end", { start: 1000, end: 7000 });
		expect(onItemSpanChange).toHaveBeenLastCalledWith("trim", { start: 1000, end: 5000 });
	});
	it("does not join trims across a locked scene boundary", () => {
		const { drag, onItemSpanChange } = setup(
			{ start: 1000, end: 2000 },
			[
				{ id: "locked", start: 5000, end: 6000, rowId: "trim" },
				{ id: "other-scene", start: 7000, end: 8000, rowId: "trim" },
			],
			undefined,
			["trim", "other-scene"],
		);
		drag({ start: 7000, end: 8000 });
		expect(onItemSpanChange).not.toHaveBeenCalled();
	});
});
