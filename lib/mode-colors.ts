import type { Mode } from "./types";

/**
 * What a message looks like, by the mode it was sent in: the board's own
 * column tints (see COLUMNS in components/BoardView.tsx) — yellow, the
 * review column's, for a message to the board (panel); blue, the working
 * column's, for one to the chat (act). One place, because the same message
 * shows up in two views — the chat transcript and the board's request stack —
 * in exactly the same colour: the person reads it as "where this went".
 *
 * A row the person stopped, or one that failed, is not in its mode's colour
 * any more: those states are grey and red wherever they appear.
 */
export interface ModeColors {
  /** The message's background, the only colour it carries in either view. */
  bubble: string;
  /** The spinner on the message being worked on. */
  spinner: string;
  /** The ring on a message still waiting its turn. */
  dot: string;
}

const COLORS: Record<Mode, ModeColors> = {
  panel: {
    bubble: "bg-yellow-50",
    spinner: "border-yellow-200 border-t-yellow-700",
    dot: "border-yellow-200",
  },
  act: {
    bubble: "bg-blue-50",
    spinner: "border-blue-200 border-t-blue-600",
    dot: "border-blue-200",
  },
};

export const modeColors = (mode: Mode): ModeColors => COLORS[mode];
