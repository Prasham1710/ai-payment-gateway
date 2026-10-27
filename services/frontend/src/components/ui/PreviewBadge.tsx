import { FlaskConical } from 'lucide-react';

/**
 * Marks a screen (or part of one) whose data is simulated in the browser rather than served by a
 * gateway backend. With a note it renders as a full-width banner; without one, as a small pill.
 */
export default function PreviewBadge({ note }: { note?: string }) {
  const pill = (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-600/70 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-300">
      <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
      Simulated preview
    </span>
  );

  if (!note) {
    return (
      <span role="note" aria-label="Simulated preview">
        {pill}
      </span>
    );
  }

  return (
    <div
      role="note"
      aria-label={`Simulated preview: ${note}`}
      className="flex w-full flex-col gap-2 rounded-xl border border-amber-700/60 bg-amber-950/30 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3"
    >
      {pill}
      <span className="text-xs leading-relaxed text-amber-100/90">{note}</span>
    </div>
  );
}
