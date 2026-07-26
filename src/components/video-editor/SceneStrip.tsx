import { Film, GripVertical, PanelLeftClose, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { EditorScene } from "./sceneModel";

interface SceneStripProps {
	scenes: EditorScene[];
	activeSceneId: string | null;
	onSelect: (sceneId: string) => void;
	onAdd: () => void;
	onDelete: (sceneId: string) => void;
	onReorder: (sceneId: string, targetIndex: number) => void;
	onCollapse: () => void;
	addLabel: string;
	deleteLabel: string;
	cancelLabel: string;
	collapseLabel: string;
	reorderLabel: string;
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
	onReorder,
	onCollapse,
	addLabel,
	deleteLabel,
	cancelLabel,
	collapseLabel,
	reorderLabel,
}: SceneStripProps) {
	const [pendingDeleteSceneId, setPendingDeleteSceneId] = useState<string | null>(null);
	const [draggedSceneId, setDraggedSceneId] = useState<string | null>(null);
	const [dropIndex, setDropIndex] = useState<number | null>(null);
	const pendingDeleteScene = scenes.find((scene) => scene.id === pendingDeleteSceneId) ?? null;

	const confirmDelete = () => {
		if (!pendingDeleteSceneId) return;
		onDelete(pendingDeleteSceneId);
		setPendingDeleteSceneId(null);
	};

	const finishDrag = () => {
		setDraggedSceneId(null);
		setDropIndex(null);
	};

	const dropScene = (event: React.DragEvent) => {
		event.preventDefault();
		if (draggedSceneId !== null && dropIndex !== null) {
			onReorder(draggedSceneId, dropIndex);
		}
		finishDrag();
	};

	return (
		<aside className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-[#0c0d0f]">
			<div className="flex h-11 flex-shrink-0 items-center justify-between border-b border-white/[0.07] px-3">
				<div className="flex min-w-0 items-baseline gap-2">
					<span className="text-[11px] font-semibold tracking-wide text-white/70">Scenes</span>
					<span className="text-[9px] tabular-nums text-white/30">{scenes.length}</span>
				</div>
				<button
					type="button"
					onClick={onCollapse}
					className="flex h-7 w-7 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-white/[0.08] hover:text-white"
					aria-label={collapseLabel}
					title={collapseLabel}
				>
					<PanelLeftClose size={15} />
				</button>
			</div>
			<div
				className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-2 py-2 custom-scrollbar"
				onDrop={dropScene}
			>
				{scenes.map((scene, index) => {
					const isActive = scene.id === activeSceneId;
					return (
						<div key={scene.id} className="relative min-w-0">
							<div
								className={`h-0.5 rounded-full bg-[#34B27B] transition-opacity ${
									dropIndex === index ? "my-1 opacity-100" : "opacity-0"
								}`}
							/>
							<div
								draggable
								onDragStart={(event) => {
									event.dataTransfer.effectAllowed = "move";
									event.dataTransfer.setData("text/plain", scene.id);
									setDraggedSceneId(scene.id);
									setDropIndex(index);
								}}
								onDragOver={(event) => {
									event.preventDefault();
									event.dataTransfer.dropEffect = "move";
									const bounds = event.currentTarget.getBoundingClientRect();
									setDropIndex(event.clientY < bounds.top + bounds.height / 2 ? index : index + 1);
								}}
								onDragEnd={finishDrag}
								className={`group relative flex min-w-0 items-center rounded-lg border transition-all ${
									draggedSceneId === scene.id ? "opacity-40" : "opacity-100"
								} ${
									isActive
										? "border-[#34B27B]/45 bg-[#34B27B]/12 shadow-[inset_2px_0_0_#34B27B]"
										: "border-transparent bg-white/[0.025] hover:border-white/[0.08] hover:bg-white/[0.055]"
								}`}
								aria-label={`${reorderLabel}: ${scene.name}`}
							>
								<GripVertical
									size={13}
									className="ml-1 flex-shrink-0 cursor-grab text-white/20 group-hover:text-white/45 active:cursor-grabbing"
									aria-hidden="true"
								/>
								<button
									type="button"
									onClick={() => onSelect(scene.id)}
									className="flex min-h-[58px] min-w-0 flex-1 items-center gap-2 px-1.5 py-2 text-left"
									aria-label={`${scene.name}: ${sceneLabel(scene)}`}
								>
									<div
										className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md ${
											isActive ? "bg-[#34B27B]/20 text-[#6ee7ad]" : "bg-black/35 text-white/35"
										}`}
									>
										<Film size={14} />
									</div>
									<span className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span
											className={`truncate text-[10px] font-medium ${
												isActive ? "text-white/90" : "text-white/55"
											}`}
										>{`Scene ${index + 1}`}</span>
										<span className="truncate text-[9px] text-white/30">
											{scene.media ? sceneLabel(scene) : "Empty"}
										</span>
									</span>
								</button>
								{scenes.length > 1 && (
									<button
										type="button"
										onClick={() => setPendingDeleteSceneId(scene.id)}
										className="mr-1.5 hidden h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-white/30 hover:bg-red-500/10 hover:text-red-300 group-hover:flex"
										aria-label={`${deleteLabel}: ${scene.name}`}
										title={deleteLabel}
									>
										<Trash2 size={12} />
									</button>
								)}
							</div>
						</div>
					);
				})}
				<div
					className={`h-2 flex-shrink-0 rounded-full border-t-2 border-[#34B27B] ${
						dropIndex === scenes.length ? "mt-1 opacity-100" : "opacity-0"
					}`}
					onDragOver={(event) => {
						event.preventDefault();
						setDropIndex(scenes.length);
					}}
				/>
			</div>
			<div className="flex-shrink-0 border-t border-white/[0.07] p-2">
				<button
					type="button"
					onClick={onAdd}
					className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/[0.14] text-[10px] font-medium text-white/40 transition-colors hover:border-[#34B27B]/50 hover:bg-[#34B27B]/10 hover:text-[#6ee7ad]"
					aria-label={addLabel}
					title={addLabel}
				>
					<Plus size={14} />
					<span>Add scene</span>
				</button>
			</div>
			<Dialog
				open={pendingDeleteScene !== null}
				onOpenChange={(open) => !open && setPendingDeleteSceneId(null)}
			>
				<DialogContent className="max-w-sm border-white/10 bg-[#09090b]">
					<DialogHeader>
						<DialogTitle>Delete scene?</DialogTitle>
						<DialogDescription className="text-white/60">
							{pendingDeleteScene
								? `This will permanently remove ${pendingDeleteScene.name} and its editor settings.`
								: "This scene will be removed."}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<button
							type="button"
							onClick={() => setPendingDeleteSceneId(null)}
							className="rounded-md bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
						>
							{cancelLabel}
						</button>
						<button
							type="button"
							onClick={confirmDelete}
							className="rounded-md bg-red-500/85 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
						>
							{deleteLabel}
						</button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</aside>
	);
}
