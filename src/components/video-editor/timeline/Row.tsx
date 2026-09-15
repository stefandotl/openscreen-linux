import type { RowDefinition } from "dnd-timeline";
import { useRow } from "dnd-timeline";

interface RowProps extends RowDefinition {
	children: React.ReactNode;
	hint?: string;
	label?: string;
	isEmpty?: boolean;
	background?: React.ReactNode;
}

/**
 * A horizontal timeline lane. Wraps dnd-timeline's `useRow` and adds an optional
 * `background` layer, an empty-state hint label, and a minimum height.
 */
export default function Row({ id, children, hint, isEmpty, background, label }: RowProps) {
	const { setNodeRef, rowWrapperStyle, rowStyle } = useRow({ id });

	return (
		<div
			data-track-id={id}
			aria-label={label}
			className="border-b border-white/[0.055] bg-[#101116] relative overflow-hidden"
			style={{ ...rowWrapperStyle, flexDirection: "column", minHeight: 36 }}
		>
			{label && (
				<div className="px-2 py-1 text-[10px] font-semibold text-slate-400 select-none">
					{label}
				</div>
			)}
			{background}
			{isEmpty && hint && (
				<div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none z-10">
					<span className="text-[11px] text-white/[0.12] font-medium">{hint}</span>
				</div>
			)}
			<div ref={setNodeRef} style={{ ...rowStyle, minHeight: 36 }}>
				{children}
			</div>
		</div>
	);
}
