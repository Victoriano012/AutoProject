"use client";

import { useState } from "react";
import { Attachment } from "@/lib/types";

const MAX_SIZE = 3 * 1024 * 1024; // Limit request size and keep project context manageable

/** Appends files to `existing`, skipping oversized ones (with an alert). */
export async function addFiles(
  existing: Attachment[],
  list: FileList | null
): Promise<Attachment[]> {
  if (!list) return existing;
  const next = [...existing];
  for (const f of Array.from(list)) {
    if (f.size > MAX_SIZE) {
      alert(`"${f.name}" is over 3 MB — choose a smaller file.`);
      continue;
    }
    next.push(await fileToAttachment(f));
  }
  return next;
}

function fileToAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        mediaType: file.type || "application/octet-stream",
        dataUrl: r.result as string,
      });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export default function AttachmentEditor({
  attachments,
  onChange,
  label = "Context files",
}: {
  attachments: Attachment[];
  onChange: (attachments: Attachment[]) => void;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add(list: FileList | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { onChange(await addFiles(attachments, list)); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not read this file"); }
    finally { setBusy(false); }
  }

  return (
    <div className="text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-zinc-700">{label}</span>
        <label className="cursor-pointer inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white hover:border-violet-400 hover:text-violet-600 px-2.5 py-1 font-medium text-zinc-600 shadow-sm transition-colors">
          <span className="text-sm leading-none">＋</span> Add file
          <input
            type="file"
            disabled={busy}
            multiple
            className="hidden"
            onChange={(e) => {
              void add(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {error && <p role="alert" className="mt-1 text-red-600">{error}</p>}
      {attachments.map((a) => (
        <div key={a.id} className="mt-1 flex items-center gap-2">
          <span className="min-w-0 truncate text-zinc-700">📎 {a.name}</span>
          <button
            className="shrink-0 text-zinc-400 hover:text-red-500"
            title="Remove"
            disabled={busy}
            onClick={() => onChange(attachments.filter((x) => x.id !== a.id))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
