/** Preview URLs for picked images (web only; empty string where unsupported). */
export function makeObjectUrl(blob: Blob): string {
  try {
    return typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : "";
  } catch {
    return "";
  }
}

export function revokeObjectUrl(url: string): void {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // nothing to release
  }
}
