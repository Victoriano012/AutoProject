import type { Mode } from "./types";

/**
 * What a message looks like, by the mode it was sent in: amber for the board
 * (panel), sky for the chat (act). One place, because the same message shows
 * up in two views — the chat transcript and the board's request stack — in
 * exactly the same colour: the person reads it as "where this went".
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
    bubble: "bg-amber-100",
    spinner: "border-amber-300 border-t-amber-700",
    dot: "border-amber-300",
  },
  act: {
    bubble: "bg-sky-100",
    spinner: "border-sky-300 border-t-sky-700",
    dot: "border-sky-300",
  },
};

export const modeColors = (mode: Mode): ModeColors => COLORS[mode];
