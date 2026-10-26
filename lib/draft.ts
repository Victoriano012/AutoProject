"use client";

/**
 * Words handed back to the input box. Dismissing a request — the ✕ on a row of
 * the board's stack, or on a pending bubble in the chat — must not lose what
 * the person typed, and the one box under both views lives in BottomBar, a
 * sibling of neither. So the dismisser says it here and the box picks it up.
 */
const listeners = new Set<(text: string) => void>();

export function takeBackDraft(text: string): void {
  for (const listener of [...listeners]) listener(text);
}

export function onTakeBackDraft(listener: (text: string) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
