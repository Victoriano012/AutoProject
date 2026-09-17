"use client";

import { useEffect, useRef } from "react";

/** 4 lines of text-sm (20px line-height) + py-2 (16px) + 2px border. */
const MAX_HEIGHT = 98;

/** The one input bar shared by BoardView, ChatPanel and TicketPanel: grows
 * with the text up to 4 lines, then scrolls. Enter sends, Shift+Enter breaks. */
export default function ChatInput({
  value,
  onChange,
  onSend,
  disabled = false,
  placeholder,
  sendTitle = "Send",
  onHistory,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
  sendTitle?: string;
  /** Arrow up from the very start / down from the very end: the caller walks
   * its history (a shell's recall). Anywhere else the arrows move as usual, so
   * on the first or last line they first reach the text's edge, and only the
   * next press goes on to the neighbouring prompt. */
  onHistory?: (dir: "back" | "forward") => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto"; // shrink so scrollHeight reflects the content
    const h = Math.min(el.scrollHeight + 2, MAX_HEIGHT); // +2: border-box height includes borders
    el.style.height = `${h}px`;
    el.style.overflowY = h >= MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  return (
    <div className="relative min-w-0 flex-1">
      <textarea
        ref={ref}
        rows={1}
        className="block w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 pr-10 font-mono text-sm outline-none focus:border-zinc-500 disabled:opacity-50"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          } else if (onHistory && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            const el = e.currentTarget;
            const edge =
              e.key === "ArrowUp" ? el.selectionStart === 0 : el.selectionEnd === el.value.length;
            if (!edge) return;
            e.preventDefault();
            onHistory(e.key === "ArrowUp" ? "back" : "forward");
            // The recalled prompt is edited from its end, as in a shell; the
            // value lands on the next render, hence the frame's wait.
            requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
          }
        }}
      />
      <button
        className="absolute right-1.5 bottom-[5px] flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800 text-white hover:bg-zinc-700 disabled:opacity-40"
        onClick={onSend}
        disabled={disabled || !value.trim()}
        title={sendTitle}
      >
        ↑
      </button>
    </div>
  );
}
