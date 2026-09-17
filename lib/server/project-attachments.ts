import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Attachment, Project } from "../types";

type StoredAttachment = Omit<Attachment, "dataUrl"> & { dataUrl?: string; storageKey?: string };
const assetDir = (dir: string) => path.join(dir, ".autoproject", "attachments");

const attachmentCache = new WeakMap<Attachment, { value: StoredAttachment; key: string; data: string }>();

function externalize(attachment: Attachment): { value: StoredAttachment; key: string; data: string } {
  const cached = attachmentCache.get(attachment);
  if (cached) return cached;
  const key = createHash("sha256").update(attachment.dataUrl).digest("hex");
  const { dataUrl, ...metadata } = attachment;
  const result = { value: { ...metadata, storageKey: key }, key, data: dataUrl };
  attachmentCache.set(attachment, result);
  return result;
}

/** Preserve the public attachment contract while keeping immutable payloads
 * out of frequently rewritten project snapshots. Content addressing also
 * reuses a payload attached to multiple tickets. */
export function prepareAttachments(dir: string, project: Project): {
  project: Project; assets: Map<string, string>;
} {
  const assets = new Map<string, string>();
  const convert = (attachments?: Attachment[]) => attachments?.map((attachment) => {
    const { value, key, data } = externalize(attachment);
    assets.set(path.join(assetDir(dir), key), data);
    return value as Attachment;
  });
  return {
    project: {
      ...project,
      attachments: convert(project.attachments),
      tickets: project.tickets.map((ticket) => ({ ...ticket, attachments: convert(ticket.attachments) })),
    },
    assets,
  };
}

export function hydrateAttachments(dir: string, project: Project): Project {
  const hydrate = (attachments?: Attachment[]) => attachments?.map((attachment) => {
    const stored = attachment as StoredAttachment;
    if (typeof stored.dataUrl === "string") return attachment; // older inline snapshots
    if (!stored.storageKey || !/^[a-f0-9]{64}$/.test(stored.storageKey)) {
      throw new Error("Invalid stored attachment reference");
    }
    const { storageKey, ...metadata } = stored;
    return { ...metadata, dataUrl: fs.readFileSync(path.join(assetDir(dir), storageKey), "utf8") } as Attachment;
  });
  return { ...project, attachments: hydrate(project.attachments), tickets: project.tickets.map((ticket) => ({ ...ticket, attachments: hydrate(ticket.attachments) })) };
}

export function writeAssetsSync(assets: Map<string, string>): void {
  for (const [file, data] of assets) {
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}

export async function writeAssets(assets: Map<string, string>): Promise<void> {
  for (const [file, data] of assets) {
    try { await fsp.access(file); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fsp.open(temporary, "wx", 0o600);
      try { await handle.writeFile(data); await handle.sync(); }
      finally { await handle.close(); }
      await fsp.rename(temporary, file);
    } finally { await fsp.rm(temporary, { force: true }); }
  }
}
