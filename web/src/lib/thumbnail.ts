// Thumbnails for images and videos, made in the browser before encryption.

const MAX_SIDE = 320;
const VIDEO_TIMEOUT_MS = 10_000;

function toJpeg(source: CanvasImageSource, w: number, h: number): Promise<Blob | null> {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.8));
}

async function imageThumb(file: Blob): Promise<Blob | null> {
  const bmp = await createImageBitmap(file);
  try {
    return await toJpeg(bmp, bmp.width, bmp.height);
  } finally {
    bmp.close();
  }
}

function videoThumb(file: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const done = (b: Blob | null) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      resolve(b);
    };
    const timer = setTimeout(() => done(null), VIDEO_TIMEOUT_MS);
    video.muted = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, video.duration / 2 || 0);
    };
    video.onseeked = () => toJpeg(video, video.videoWidth, video.videoHeight).then(done, () => done(null));
    video.onerror = () => done(null);
    video.src = url;
  });
}

/** JPEG thumbnail, or null when the type has none or the browser can't decode it. */
export async function makeThumbnail(file: Blob, type: string): Promise<Blob | null> {
  try {
    if (type.startsWith("image/") && type !== "image/svg+xml") return await imageThumb(file);
    if (type.startsWith("video/")) return await videoThumb(file);
  } catch {}
  return null;
}
