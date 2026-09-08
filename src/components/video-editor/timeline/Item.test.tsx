import { render, screen } from "@testing-library/react";
import type { UseItemProps } from "dnd-timeline";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import Item, {
	TIMELINE_ITEM_EDGE_WIDTH_PX,
	TIMELINE_ITEM_MIN_WIDTH_PX,
	TIMELINE_ITEM_RESIZE_HANDLE_WIDTH_PX,
} from "./Item";

const mocks = vi.hoisted(() => ({
	useItem: vi.fn(),
}));

vi.mock("dnd-timeline", () => ({
	useItem: mocks.useItem,
}));

describe("timeline Item interaction geometry", () => {
	it("keeps resize hit areas on the visible edge caps and leaves a draggable center", () => {
		mocks.useItem.mockReturnValue({
			setNodeRef: vi.fn(),
			attributes: {},
			listeners: {},
			itemStyle: { width: 120 },
			itemContentStyle: {},
		});

		const { container } = render(
			<I18nProvider>
				<Item id="trim-1" rowId="row-trim" span={{ start: 1000, end: 2000 }} variant="trim">
					Trim
				</Item>
			</I18nProvider>,
		);

		const useItemProps = mocks.useItem.mock.calls.at(-1)?.[0] as UseItemProps;
		expect(useItemProps.resizeHandleWidth).toBe(TIMELINE_ITEM_EDGE_WIDTH_PX * 2);
		expect(useItemProps.resizeHandleWidth).toBe(TIMELINE_ITEM_RESIZE_HANDLE_WIDTH_PX);

		const item = container.firstElementChild as HTMLElement;
		expect(item.style.minWidth).toBe(`${TIMELINE_ITEM_MIN_WIDTH_PX}px`);
		expect(screen.getByTitle("Resize left").style.width).toBe(`${TIMELINE_ITEM_EDGE_WIDTH_PX}px`);
		expect(screen.getByTitle("Resize right").style.width).toBe(`${TIMELINE_ITEM_EDGE_WIDTH_PX}px`);
	});
});
