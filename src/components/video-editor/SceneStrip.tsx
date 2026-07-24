import { Film, Plus, Trash2 } from "lucide-react";
import type { EditorScene } from "./sceneModel";

interface SceneStripProps {
	scenes: EditorScene[];
	activeSceneId: string | null;
	onSelect: (sceneId: string) => void;
	onAdd: () => void;
	onDelete: (sceneId: string) => void;
	addLabel: string;
	deleteLabel: string;
}

function sceneLabel(scene: EditorScene) {
	if (scene.media?.screenVideoPath) {
		const fileName = scene.media.screenVideoPath.split(/[\\/]/).pop();
		if (fileName) return fileName.replace(/\.[^.]+$/, "");
	}
	return scene.name;
}

export default function SceneStrip({
	scenes,
	activeSceneId,
	onSelect,
	onAdd,
	onDelete,
	addLabel,
	deleteLabel,
}: SceneStripProps) {
	return (
		<aside className="flex w-[88px] shrink-0 flex-col gap-2 border-r border-white/[0.08] bg-[#0b0b0d] p-2">
			<div className="flex flex-col gap-2 overflow-y-auto">
				{scenes.map((scene, index) => {
					const isActive = scene.id === activeSceneId;
					return (
						<div key={scene.id} className="group relative">
							<button
								type="button"
								onClick={() => onSelect(scene.id)}
								className={`flex min-h-[66px] w-full flex-col items-center justify-center gap-1 rounded-lg border px-1.5 py-2 text-center transition-colors ${
									isActive
										? "border-[#34B27B]/70 bg-[#34B27B]/15 text-white"
										: "border-white/[0.08] bg-white/[0.03] text-white/50 hover:border-white/20 hover:bg-white/[0.06] hover:text-white/80"
								}`}
								aria-label={`${scene.name}: ${sceneLabel(scene)}`}
							>
								<div className="flex h-7 w-10 items-center justify-center rounded bg-black/50 text-white/50">
									<Film size={15} />
								</div>
								<span className="max-w-full truncate text-[9px] font-medium">{`Scene ${index + 1}`}</span>
								<span className="max-w-full truncate text-[8px] text-white/35">
									{scene.media ? sceneLabel(scene) : "Empty"}
								</span>
							</button>
							{scenes.length > 1 && (
								<button
									type="button"
									onClick={() => onDelete(scene.id)}
									className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-white/10 bg-[#17171a] text-white/40 hover:text-red-300 group-hover:flex"
									aria-label={`${deleteLabel}: ${scene.name}`}
									title={deleteLabel}
								>
									<Trash2 size={9} />
								</button>
							)}
						</div>
					);
				})}
			</div>
			<button
				type="button"
				onClick={onAdd}
				className="mt-auto flex min-h-[42px] w-full items-center justify-center rounded-lg border border-dashed border-white/20 text-white/50 transition-colors hover:border-[#34B27B]/70 hover:bg-[#34B27B]/10 hover:text-[#6ee7ad]"
				aria-label={addLabel}
				title={addLabel}
			>
				<Plus size={17} />
			</button>
		</aside>
	);
}
