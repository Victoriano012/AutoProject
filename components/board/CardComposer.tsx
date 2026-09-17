import { useEffect, useRef } from "react";

/** 10 lines of text-xs (16px line-height) + py-1 (8px) + 2px border. */
const COMPOSER_MAX_HEIGHT = 170;

/** The box a card opens for a message to its agent — the review column's ✕ and
 * the note button on a card in flight both use this one. Grows with the text up
 * to ten lines and then scrolls; Enter sends, Shift+Enter is a newline, and
 * Escape or a press anywhere outside closes it with the draft intact. */
export default function CardComposer({
  value,
  onChange,
  onSend,
  onClose,
  placeholder,
  tone,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
  placeholder: string;
  tone: "reject" | "note";
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const skin =
    tone === "reject"
      ? {
          border: "border-red-300 focus:border-red-400",
          send: "bg-red-500 hover:bg-red-400",
        }
      : {
          border: "border-violet-300 focus:border-violet-400",
          send: "bg-violet-500 hover:bg-violet-400",
        };

  // The box mounts fresh on every open, so a restored multi-line draft comes
  // back at the height it had — same growth as ChatInput.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto"; // shrink so scrollHeight reflects the content
    const h = Math.min(el.scrollHeight + 2, COMPOSER_MAX_HEIGHT);
    el.style.height = `${h}px`;
    el.style.overflowY = h >= COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  return (
    // items-end: Send sits level with the last line of a grown box.
    <div ref={boxRef} className="flex items-end gap-1.5">
      <textarea
        autoFocus
        ref={inputRef}
        rows={1}
        className={`block min-w-0 flex-1 resize-none rounded-md border bg-white px-2 py-1 text-xs outline-none ${skin.border}`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
          if (e.key === "Escape") onClose();
        }}
      />
      <button
        className={`rounded-md px-2 py-1 text-xs text-white ${skin.send}`}
        onClick={onSend}
      >
        Send
      </button>
    </div>
  );
}
