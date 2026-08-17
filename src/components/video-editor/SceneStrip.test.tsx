import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SceneStrip from "./SceneStrip";
import type { EditorScene } from "./sceneModel";

const scenes: EditorScene[] = [
	{
		id: "opening",
		name: "Opening",
		media: { screenVideoPath: "/recordings/intro.webm" },
		editor: {} as EditorScene["editor"],
	},
	{
		id: "demo",
		name: "Product demo",
		media: null,
		editor: {} as EditorScene["editor"],
	},
];

function renderSceneStrip(
	onRename = vi.fn(),
	onMergeCut = vi.fn(),
	mergeCuts: Array<{ rightSceneId: string; hasEditorConflicts: boolean }> = [],
) {
	render(
		<SceneStrip
			scenes={scenes}
			activeSceneId="opening"
			onSelect={vi.fn()}
			onAdd={vi.fn()}
			onDelete={vi.fn()}
			onMergeCut={onMergeCut}
			onReorder={vi.fn()}
			onRename={onRename}
			onCollapse={vi.fn()}
			addLabel="Add scene"
			deleteLabel="Delete"
			cancelLabel="Cancel"
			collapseLabel="Collapse scenes"
			reorderLabel="Drag to reorder scene"
			mergeCuts={mergeCuts}
		/>,
	);
}

describe("SceneStrip scene names", () => {
	it("shows the stable scene name as the primary label", () => {
		renderSceneStrip();

		expect(screen.getByText("Opening")).toBeInTheDocument();
		expect(screen.getByText("intro")).toBeInTheDocument();
		expect(screen.getByText("Product demo")).toBeInTheDocument();
		expect(screen.getByText("Empty scene")).toBeInTheDocument();
	});

	it("renames a scene inline and commits with Enter", () => {
		const onRename = vi.fn();
		renderSceneStrip(onRename);

		fireEvent.click(screen.getByRole("button", { name: "Rename scene: Opening" }));
		const input = screen.getByRole("textbox", { name: "Rename scene: Opening" });
		fireEvent.change(input, { target: { value: "  Introduction  " } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(onRename).toHaveBeenCalledWith("opening", "Introduction");
	});

	it("keeps the existing name when editing is canceled", () => {
		const onRename = vi.fn();
		renderSceneStrip(onRename);

		fireEvent.click(screen.getByRole("button", { name: "Rename scene: Opening" }));
		const input = screen.getByRole("textbox", { name: "Rename scene: Opening" });
		fireEvent.change(input, { target: { value: "Changed" } });
		fireEvent.keyDown(input, { key: "Escape" });

		expect(onRename).not.toHaveBeenCalled();
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("shows a removable cut between split scenes and confirms the merge", () => {
		const onMergeCut = vi.fn();
		renderSceneStrip(vi.fn(), onMergeCut, [{ rightSceneId: "demo", hasEditorConflicts: false }]);

		fireEvent.click(screen.getByRole("button", { name: "Remove cut: Opening + Product demo" }));
		expect(screen.getByText("Remove this cut?")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Merge scenes" }));

		expect(onMergeCut).toHaveBeenCalledWith("demo");
	});

	it("warns when the split scenes have conflicting editor settings", () => {
		renderSceneStrip(vi.fn(), vi.fn(), [{ rightSceneId: "demo", hasEditorConflicts: true }]);

		fireEvent.click(screen.getByRole("button", { name: "Remove cut: Opening + Product demo" }));

		expect(screen.getByText(/Both scenes were edited after the split/)).toBeInTheDocument();
	});
});
