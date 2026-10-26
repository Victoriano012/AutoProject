/** Feather-style stroke icons for the toolbar's action buttons, sized to
 * match GearIcon. */

function Svg({ size = 20, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function PlusIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Svg>
  );
}

/** Feather "grid": 2×2 rounded squares — auto-layout. */
export function LayoutIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </Svg>
  );
}

export function PlayIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <polygon points="5 3 19 12 5 21 5 3" />
    </Svg>
  );
}

/** Ring spinner marking work in progress; sized by the caller's class. The
 * ring colour is a prop rather than part of `className` so it can't lose to
 * the default in the stylesheet's own order (a populate spins violet). */
export function Spinner({
  className = "h-3.5 w-3.5",
  color = "border-blue-400",
}: {
  className?: string;
  color?: string;
}) {
  return (
    <span
      aria-hidden
      className={`${className} block animate-spin rounded-full border ${color} border-t-transparent`}
    />
  );
}

/** Feather "arrow-right": the mirror of "arrow-left", so descending into a
 * ticket's board reads as the opposite of the breadcrumb's step back. */
export function ArrowRightIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </Svg>
  );
}

/** Stop a running agent. A sized square, not the ◼ glyph: font rendering made
 * it tiny. One control, so every stop in the app looks the same. */
export function StopSquare({
  onClick,
  title = "Stop",
}: {
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="h-3 w-3 rounded-[3px] bg-red-600 hover:bg-red-500"
    />
  );
}

/** Open palm: this ticket is holding a file, so other tickets wait for it.
 * Filled rather than stroked — at 12px a stroked hand is a smudge. */
export function HandIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className="shrink-0"
    >
      <path d="M4.5 11h15v4A7 7 0 0 1 12.5 22h-1A7 7 0 0 1 4.5 15z" />
      <rect x="5.2" y="5.5" width="3.6" height="7" rx="1.8" />
      <rect x="10.2" y="3" width="3.6" height="9.5" rx="1.8" />
      <rect x="15.2" y="5.5" width="3.6" height="7" rx="1.8" />
    </svg>
  );
}

/** Feather "message-square": say something more to this card's agent. Stroked
 * a little heavier than the 20px icons, since it is drawn at card size. */
export function NoteIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M21 14.5a2.5 2.5 0 0 1-2.5 2.5H8l-4.5 4V5.5A2.5 2.5 0 0 1 6 3h12.5A2.5 2.5 0 0 1 21 5.5z" />
    </svg>
  );
}

export function StopIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </Svg>
  );
}

/** Feather "trello"-style board: three columns — the mode button's way of
 * saying "back to the board" while the chat is up. */
export function BoardIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </Svg>
  );
}

/** Feather "rotate-cw": re-check something that may have changed elsewhere. */
export function RefreshIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </Svg>
  );
}

/** Feather "message-circle": the chat, offered while the board is showing. */
export function ChatIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </Svg>
  );
}
