/**
 * An image the curator attaches to an event they add: either a link to an image already online
 * (https, so every email client will load it) or a file on this computer. The pipeline runs on the
 * curator's own machine, so a path such as C:\Users\bader\Pictures\poster.png can be read.
 *
 * A local file is shown in the preview inline, and uploaded to the email platform only when the
 * newsletter is approved, so the email itself always points at a hosted copy.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif" };

/** The first bytes each type starts with, so a renamed file is caught rather than trusted. */
const SIGNATURES: Record<string, number[][]> = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/gif": [[0x47, 0x49, 0x46, 0x38]],
};

export interface LocalImage {
  path: string;
  name: string;
  mime: string;
  bytes: Buffer;
}

export function isImageUrl(ref: string): boolean {
  return /^https:\/\//i.test(ref);
}

/**
 * The image reference as it should be stored, or why it cannot be used. Nothing is guessed: a link
 * must be https, and a file must exist, be a jpg, png or gif by its content, and be small enough.
 */
export function checkImage(raw: string): { ref: string } | { error: string } {
  const ref = raw.trim().replace(/^"(.*)"$/, "$1");
  if (!ref) return { error: "Give a link to the image (https://...) or the full path of an image file on this computer." };
  if (/^http:\/\//i.test(ref)) return { error: "Use an https:// link for the image; many email clients will not load http:// images." };
  if (isImageUrl(ref)) {
    try {
      new URL(ref);
    } catch {
      return { error: "That image link is not a valid address." };
    }
    return { ref };
  }
  if (!isAbsolute(ref)) return { error: "Give the full path of the image file, for example C:\\Users\\you\\Pictures\\poster.png, or an https:// link." };
  const mime = TYPES[extname(ref).toLowerCase()];
  if (!mime) return { error: "The image must be a .jpg, .png or .gif file." };
  let size: number;
  try {
    const st = statSync(ref);
    if (!st.isFile()) return { error: `${ref} is not a file.` };
    size = st.size;
  } catch {
    return { error: `No file found at ${ref}.` };
  }
  if (size > MAX_IMAGE_BYTES) return { error: `The image is ${(size / 1024 / 1024).toFixed(1)} MB; keep it under ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` };
  const head = readFileSync(ref).subarray(0, 8);
  if (!SIGNATURES[mime]!.some((sig) => sig.every((b, i) => head[i] === b))) {
    return { error: `${basename(ref)} does not look like a ${mime.slice(6).toUpperCase()} image.` };
  }
  return { ref };
}

/** A local image file's contents, for the preview or the upload. Throws if it has gone. */
export function readLocalImage(path: string): LocalImage {
  const mime = TYPES[extname(path).toLowerCase()];
  if (!mime) throw new Error(`${path} is not a .jpg, .png or .gif file`);
  return { path, name: basename(path), mime, bytes: readFileSync(path) };
}

/** A local image inline, for the preview page, which never reads the file system itself. */
export function dataUri(img: LocalImage): string {
  return `data:${img.mime};base64,${img.bytes.toString("base64")}`;
}
