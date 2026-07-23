import type { ChildProcess } from "node:child_process";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { startup as electronStartup } from "vite-plugin-electron";
import electron from "vite-plugin-electron/simple";

type ProcessWithElectron = NodeJS.Process & { electronApp?: ChildProcess };

// vite-plugin-electron 0.29.1 includes Vite's sibling processes in its Linux tree kill.
// Stop only the Electron main process and let Electron tear down its own children. Keeping
// Electron attached also prevents it from surviving as an orphan after the Vite process exits.
if (process.platform === "linux") {
	electronStartup.exit = async () => {
		const hostProcess = process as ProcessWithElectron;
		const child = hostProcess.electronApp;
		if (!child) return;

		child.removeAllListeners();
		if (!child.pid || child.exitCode !== null) {
			if (hostProcess.electronApp === child) {
				delete hostProcess.electronApp;
			}
			return;
		}

		await new Promise<void>((resolve) => {
			let settled = false;
			let forceTimer: ReturnType<typeof setTimeout>;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(forceTimer);
				resolve();
			};

			child.once("exit", finish);
			forceTimer = setTimeout(() => {
				child.kill("SIGKILL");
				finish();
			}, 3000);

			if (!child.kill("SIGTERM")) {
				finish();
			}
		});

		if (hostProcess.electronApp === child) {
			delete hostProcess.electronApp;
		}
	};
}

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		react(),
		electron({
			main: {
				entry: {
					main: "electron/main.ts",
					parakeetWorker: "electron/captioning/parakeetWorker.ts",
				},
				onstart({ startup }) {
					const env = { ...process.env };
					delete env.ELECTRON_RUN_AS_NODE;
					return startup(["."], {
						env,
					});
				},
				vite: {
					build: {},
				},
			},
			preload: {
				input: path.join(__dirname, "electron/preload.ts"),
			},
			renderer: process.env.NODE_ENV === "test" ? undefined : {},
		}),
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
			// The optional Whisper worker needs browser-safe Transformers.js/ORT imports.
			fs: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			path: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			url: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"onnxruntime-node": path.resolve(__dirname, "src/lib/vite-stubs/onnxruntime-node-stub.ts"),
		},
	},
	optimizeDeps: {
		exclude: ["@xenova/transformers"],
	},
	worker: {
		format: "es",
	},
	build: {
		target: "esnext",
		minify: "terser",
		terserOptions: {
			compress: {
				drop_console: true,
				drop_debugger: true,
				pure_funcs: ["console.log", "console.debug"],
			},
		},
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (id.includes("pixi.js") || id.includes("pixi-filters") || id.includes("@pixi/"))
						return "pixi";
					if (id.includes("react-dom") || id.includes("/react/")) return "react-vendor";
					if (
						id.includes("mediabunny") ||
						id.includes("mp4box") ||
						id.includes("fix-webm-duration")
					)
						return "video-processing";
				},
			},
		},
		chunkSizeWarningLimit: 1000,
	},
});
