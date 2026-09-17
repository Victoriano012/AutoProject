import fs from "fs";
import path from "path";

export interface AttachmentPayload {
  name: string;
  dataUrl: string;
}

/** Decode data-URL attachments into real files under `dir` so the agent can
 * read them (PNGs, PDFs, anything). Returns the written file paths. */
export function writeAttachments(
  dir: string,
  attachments: AttachmentPayload[]
): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const a of attachments) {
    const m = /^data:[^;,]*(;base64)?,(.*)$/.exec(a.dataUrl);
    if (!m) continue;
    const safe = path.basename(a.name).replace(/[^\w.\- ]/g, "_") || "file";
    const buf = m[1]
      ? Buffer.from(m[2], "base64")
      : Buffer.from(decodeURIComponent(m[2]));
    // These files belong to a runtime workspace, not the application bundle.
    const p = path.join(/* turbopackIgnore: true */ dir, safe);
    fs.writeFileSync(p, buf);
    written.push(p);
  }
  return written;
}
