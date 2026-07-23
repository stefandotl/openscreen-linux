import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceSelector } from "./SourceSelector";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (namespace: string) => {
		if (namespace === "common") {
			return (key: string) => {
				if (key === "actions.cancel") return "Cancel";
				if (key === "actions.share") return "Share";
				if (key === "actions.reload") return "Reload";
				return key;
			};
		}

		return (key: string, vars?: Record<string, string>) => {
			if (key === "sourceSelector.loading") return "Loading sources...";
			if (key === "sourceSelector.emptyTitle") return "No screens or windows found";
			if (key === "sourceSelector.emptyDescription") {
				return "If you just granted screen recording permission, reload this picker. On macOS you may need to reopen OpenScreen.";
			}
			if (key === "sourceSelector.loadFailedDescription") {
				return "OpenScreen could not load capture sources. Reload this picker and try again.";
			}
			if (key === "sourceSelector.screens") return `Screens (${vars?.count ?? "0"})`;
			if (key === "sourceSelector.windows") return `Windows (${vars?.count ?? "0"})`;
			return key;
		};
	},
}));

describe("SourceSelector", () => {
	beforeEach(() => {
		localStorage.clear();
		window.electronAPI = {
			...window.electronAPI,
			getSources: vi.fn().mockResolvedValue([]),
			selectSource: vi.fn(),
			getSelectedSource: vi.fn().mockResolvedValue(null),
		} as typeof window.electronAPI;
	});

	it("shows a retry state when no capture sources are available", async () => {
		render(<SourceSelector />);

		await screen.findByText("No screens or windows found");
		expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
	});

	it("reloads capture sources from the empty state", async () => {
		const getSources = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					id: "screen:1:0",
					name: "Display 1",
					thumbnail: "data:image/png;base64,abc",
					display_id: "1",
					appIcon: null,
				},
			]);
		window.electronAPI = {
			...window.electronAPI,
			getSources,
			selectSource: vi.fn(),
			getSelectedSource: vi.fn().mockResolvedValue(null),
		} as typeof window.electronAPI;

		render(<SourceSelector />);

		await screen.findByText("No screens or windows found");
		fireEvent.click(screen.getByRole("button", { name: "Reload" }));

		await waitFor(() => {
			expect(screen.getByText("Display 1")).toBeInTheDocument();
		});
		expect(getSources).toHaveBeenCalledTimes(2);
	});

	it("preselects the active source and persists a confirmed choice", async () => {
		const source = {
			id: "screen:2:0",
			name: "Display 2",
			thumbnail: "data:image/png;base64,abc",
			display_id: "2",
			appIcon: null,
		};
		window.electronAPI = {
			...window.electronAPI,
			getSources: vi.fn().mockResolvedValue([source]),
			getSelectedSource: vi.fn().mockResolvedValue(source),
			selectSource: vi.fn().mockResolvedValue(source),
		} as typeof window.electronAPI;

		render(<SourceSelector />);

		await screen.findByText("Display 2");
		const shareButton = screen.getByRole("button", { name: "Share" });
		expect(shareButton).toBeEnabled();
		fireEvent.click(shareButton);

		await waitFor(() => {
			expect(window.electronAPI.selectSource).toHaveBeenCalledWith(source);
		});
	});
});
