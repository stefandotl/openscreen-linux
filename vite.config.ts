import type { ChildProcess } from "node:child_process";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { startup as electronStartup } from "vite-plugin-electron";
import electron from "vite-plugin-electron/simple";

type ProcessWithElectron = NodeJS.Process & { electronApp?: ChildProcess };

// vite-plugin-electron 0.29.1 includes Vite's sibling processes in its Linux tree kill,
// so restarting Electron also kills Vite's esbuild service. A detached process group keeps
// Electron and its helpers isolated while preserving main-process hot restarts.
if (process.platform === "linux") {
	electronStartup.exit = async () => {
		const hostProcess = process as ProcessWithElectron;
		const child = hostProcess.electronApp;
		if (!child) return;

		delete hostProcess.electronApp;
		child.removeAllListeners();
		const pid = child.pid;
		if (!pid || child.exitCode !== null) return;

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
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					// The process group already exited.
				}
				finish();
			}, 3000);

			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				finish();
			}
		});
	};
}

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		react(),
		electron({
			main: {
				entry: "electron/main.ts",
				onstart({ startup }) {
					const env = { ...process.env };
					delete env.ELECTRON_RUN_AS_NODE;
					return startup(["."], {
						env,
						detached: process.platform === "linux",
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
			// @xenova/transformers: env.js statically imports fs/path/url; onnx.js imports
			// onnxruntime-node (must not be bundled in the renderer — it requires fs).
			fs: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			path: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			url: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"onnxruntime-node": path.resolve(__dirname, "src/lib/vite-stubs/onnxruntime-node-stub.ts"), // re-exports web ORT
		},
	},
	optimizeDeps: {
		exclude: ["@xenova/transformers"],
	},
	// The captioning worker dynamically imports @xenova/transformers, which makes the
	// worker bundle code-split — unsupported by the default "iife" worker format.
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
