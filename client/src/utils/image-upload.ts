import { client } from "../app/runtime";
import { encodeBlurhash } from "./blurhash";
import { uploadToStorageWithProgress, uploadToNetpanWithProgress } from "./upload-with-progress";
import { compressImageFile } from "./image-compress";

export const DEFAULT_IMAGE_MAX_FILE_SIZE = 5 * 1024 * 1024;

// Max size for video uploads routed through the Cloudflare R2 storage endpoint
// (the first "upload image" button also accepts video). Kept in step with the
// netpan 80MB ceiling; Cloudflare Workers caps request bodies around this range.
export const DEFAULT_VIDEO_MAX_FILE_SIZE = 80 * 1024 * 1024;

export type UploadedImageResult = {
  url: string;
  blurhash?: string;
  width?: number;
  height?: number;
};

type ImageMetadata = {
  blurhash?: string;
  width?: number;
  height?: number;
};

type MarkdownImageMetadataResult = {
  content: string;
  updated: number;
  failed: number;
};

export function isImageFile(file: File) {
  return file.type.startsWith("image/");
}

export function isVideoFile(file: File) {
  return file.type.startsWith("video/");
}

export function isAudioFile(file: File) {
  if (file.type.startsWith("audio/")) return true;
  // Fallback for environments that don't report a MIME type for audio files
  // (e.g. some OS/browser combos leave .mp3 with an empty or generic type),
  // so the file picker / validation still accepts them by extension.
  return /\.(mp3|wav|ogg|m4a|aac|flac|wma|webm|opus|mid|midi|amr|caf|aiff|ape)$/i.test(file.name);
}

function toPositiveInteger(value?: string | null) {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function attachImageMetadataToUrl(url: string, metadata: ImageMetadata = {}) {
  const { blurhash, width, height } = metadata;
  if (!blurhash && !width && !height) {
    return url;
  }

  const [baseUrl, fragment = ""] = url.split("#", 2);
  const params = new URLSearchParams(fragment);
  if (blurhash) {
    params.set("blurhash", blurhash);
  }
  if (width) {
    params.set("width", String(width));
  }
  if (height) {
    params.set("height", String(height));
  }
  return `${baseUrl}#${params.toString()}`;
}

export function parseImageUrlMetadata(url?: string | null) {
  if (!url) {
    return {
      src: "",
      blurhash: undefined as string | undefined,
    };
  }

  const [src, fragment = ""] = url.split("#", 2);
  const params = new URLSearchParams(fragment);

  return {
    src,
    blurhash: params.get("blurhash") || undefined,
    width: toPositiveInteger(params.get("width")),
    height: toPositiveInteger(params.get("height")),
  };
}

export function stripImageUrlMetadata(url?: string | null) {
  return parseImageUrlMetadata(url).src;
}

export function buildMarkdownImage(fileName: string, url: string, metadata: ImageMetadata = {}) {
  const safeAlt = fileName.replace(/[[\]]/g, "");
  const safeUrl = url.replace(/\s/g, "%20");
  return `![${safeAlt}](${attachImageMetadataToUrl(safeUrl, metadata)})\n`;
}

// Raw <video> block for the markdown editor. Wrapped in blank lines so the
// rehype-raw renderer treats it as a block-level element.
//
// Two preview fallbacks work together:
//   1. A `poster` URL (preferred) — a real thumbnail image. iOS Safari
//      ignores the `#t=` trick but honours the `poster` attribute, so this
//      is what makes the first frame show on iPhone/iPad.
//   2. The media fragment `#t=0.1` — desktop browsers (Chrome/Firefox/Safari)
//      seek to ~0.1s and paint that frame as a static preview even without a
//      poster. Harmless when a poster is already supplied.
export function buildMarkdownVideo(_fileName: string, url: string, posterUrl?: string) {
  let safeUrl = url.replace(/\s/g, "%20");
  if (!safeUrl.includes("#")) {
    safeUrl += "#t=0.1";
  }
  const posterAttr = posterUrl
    ? ` poster="${posterUrl.replace(/\s/g, "%20")}"`
    : "";
  return `\n<video src="${safeUrl}"${posterAttr} controls preload="metadata" style="max-width:100%"></video>\n`;
}

// Raw <audio> block for the markdown editor. `autoplay` controls whether the
// audio starts playing when the article is opened. Wrapped in blank lines so
// the rehype-raw renderer treats it as a block-level element.
export function buildMarkdownAudio(fileName: string, url: string, autoplay = false) {
  const safeUrl = url.replace(/\s/g, "%20");
  const autoplayAttr = autoplay ? " autoplay" : "";
  // data-name carries the original filename so the custom audio player can
  // display it above the progress bar. Escaped for safe use in an attribute.
  const safeName = fileName
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `\n<audio data-name="${safeName}" src="${safeUrl}" controls${autoplayAttr} preload="metadata"></audio>\n`;
}

// Markdown download link for a generic file uploaded via netpan.
export function buildMarkdownFile(fileName: string, url: string) {
  const safeName = fileName.replace(/[[\]]/g, "");
  const safeUrl = url.replace(/\s/g, "%20");
  return `\n[${safeName}](${safeUrl})\n`;
}

async function loadImage(file: File) {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Failed to load image"));
      element.src = objectUrl;
    });
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function loadImageFromUrl(url: string) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.crossOrigin = "anonymous";
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    element.src = url;
  });
  return image;
}

export async function generateImageMetadata(file: File) {
  if (!isImageFile(file)) {
    return {};
  }

  const image = await loadImage(file);
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (!longestSide) {
    return {};
  }

  const scale = Math.min(1, 48 / longestSide);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return {};
  }

  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  return {
    blurhash: encodeBlurhash(imageData.data, width, height, 4, 3),
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
}

export async function generateImageMetadataFromUrl(url: string): Promise<ImageMetadata> {
  const { src, blurhash, width, height } = parseImageUrlMetadata(url);
  if (blurhash && width && height) {
    return { blurhash, width, height };
  }

  const image = await loadImageFromUrl(src);
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (!longestSide) {
    return {
      blurhash,
      width: width || undefined,
      height: height || undefined,
    };
  }

  const scale = Math.min(1, 48 / longestSide);
  const canvas = document.createElement("canvas");
  const canvasWidth = Math.max(1, Math.round(image.naturalWidth * scale));
  const canvasHeight = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return {
      blurhash,
      width: width || image.naturalWidth || undefined,
      height: height || image.naturalHeight || undefined,
    };
  }

  context.drawImage(image, 0, 0, canvasWidth, canvasHeight);
  const imageData = context.getImageData(0, 0, canvasWidth, canvasHeight);

  return {
    blurhash: blurhash || encodeBlurhash(imageData.data, canvasWidth, canvasHeight, 4, 3),
    width: width || image.naturalWidth || undefined,
    height: height || image.naturalHeight || undefined,
  };
}

export async function enrichMarkdownImageMetadata(content: string): Promise<MarkdownImageMetadataResult> {
  const markdownPattern = /!\[(.*?)\]\((\S+?)(?:\s+"[^"]*")?\)/g;
  const htmlPattern = /<img\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*?)>/gi;
  const markdownMatches = [...content.matchAll(markdownPattern)].map((match) => ({
    type: "markdown" as const,
    fullMatch: match[0],
    alt: match[1] || "",
    rawUrl: match[2],
  }));
  const htmlMatches = [...content.matchAll(htmlPattern)].map((match) => ({
    type: "html" as const,
    fullMatch: match[0],
    beforeSrc: match[1] || "",
    rawUrl: match[2],
    afterSrc: match[3] || "",
  }));
  const matches = [...markdownMatches, ...htmlMatches];

  if (matches.length === 0) {
    return { content, updated: 0, failed: 0 };
  }

  let nextContent = content;
  let updated = 0;
  let failed = 0;

  for (const match of matches) {
    const { fullMatch, rawUrl } = match;
    if (!fullMatch || !rawUrl) {
      continue;
    }

    const existing = parseImageUrlMetadata(rawUrl);
    if (existing.blurhash && existing.width && existing.height) {
      continue;
    }

    try {
      const metadata = await generateImageMetadataFromUrl(rawUrl);
      if (!metadata.blurhash || !metadata.width || !metadata.height) {
        failed += 1;
        continue;
      }

      const nextUrl = attachImageMetadataToUrl(existing.src, metadata);
      const replacement = match.type === "markdown"
        ? `![${match.alt}](${nextUrl})`
        : `<img${match.beforeSrc}src="${nextUrl}"${match.afterSrc}>`;
      if (replacement !== fullMatch) {
        nextContent = nextContent.replace(fullMatch, replacement);
        updated += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return {
    content: nextContent,
    updated,
    failed,
  };
}

export async function uploadImageFile(
  file: File,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
  onCompressedSize?: (size: number) => void,
): Promise<UploadedImageResult> {
  const [uploadResult, metadataResult] = await Promise.allSettled([
    // 上传前先压缩（受全局开关控制；非图片/关开关时原样返回）。
    // 元数据仍用原图算，保证占位尺寸与宽高比正确。
    // 压缩完成后立即回调 compressed.size，让上传窗口把「显示大小」更新为
    // 实际将要传输的压缩后体积（而非原图体积），避免标签 3MB、实则传几百 KB 的误导。
    compressImageFile(file).then((compressed) => {
      onCompressedSize?.(compressed.size);
      return uploadToStorageWithProgress(compressed, compressed.name, onProgress, signal);
    }),
    generateImageMetadata(file),
  ]);

  if (uploadResult.status === "rejected") {
    throw uploadResult.reason instanceof Error
      ? uploadResult.reason
      : new Error("Upload failed");
  }

  const url = uploadResult.value;
  if (!url) {
    throw new Error("Invalid upload response");
  }

  return {
    url,
    ...(metadataResult.status === "fulfilled" ? metadataResult.value : {}),
  };
}

// Upload an arbitrary file directly to the user's private netpan (Sanyue
// ImgHub / CloudFlare-ImgBed) and return the public URL. Shows upload progress
// via `onProgress` (0..100). See upload-with-progress.ts for the XHR impl.
export async function uploadVideoToNetpan(
  file: File,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return uploadToNetpanWithProgress(file, onProgress, signal);
}

// Generic file upload (audio, documents, archives, etc.) backed by netpan.
export async function uploadFileToNetpan(
  file: File,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  // 图片在上传前压缩（受全局开关控制；非图片原样返回）。
  const toUpload = await compressImageFile(file);
  return uploadToNetpanWithProgress(toUpload, onProgress, signal);
}

// ---------------------------------------------------------------------------
// Video poster (thumbnail) helpers
// ---------------------------------------------------------------------------

// Options for `generateVideoPosterBlob`.
export interface VideoPosterOptions {
  // Seconds into the video to grab the frame from. 0.5s tends to skip any
  // pure-black intro frames while staying close to the literal first frame.
  seekTo?: number;
  // Longest edge of the generated JPEG, in pixels. The poster is tiny so we
  // keep it small to save bandwidth.
  maxWidth?: number;
  // JPEG quality 0..1.
  quality?: number;
  // Hard timeout (ms). If the video host is slow or CORS-tants, we bail.
  timeoutMs?: number;
}

// Pull a single frame out of a cross-origin video and return it as a JPEG
// Blob. Returns `null` on any failure (CORS taint, decode error, timeout,
// unsupported codec) — callers should treat that as "no poster" rather than
// an error.
//
// REQUIRES the video URL to serve `Access-Control-Allow-Origin` matching the
// page origin (or `*`). Both R2 (rinx.hello.nyc.mn) and netpan (*.1234.nyc.mn)
// satisfy this for the current deployments.
export async function generateVideoPosterBlob(
  videoUrl: string,
  options: VideoPosterOptions = {},
): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const { seekTo = 0.5, maxWidth = 480, quality = 0.8, timeoutMs = 8000 } = options;

  return await new Promise<Blob | null>((resolve) => {
    let settled = false;
    const finish = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        // ignore
      }
      if (video.parentNode) video.parentNode.removeChild(video);
      resolve(blob);
    };

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    // Off-screen but still attached — some browsers (incl. mobile Safari)
    // refuse to load metadata for a detached video element.
    video.style.position = "fixed";
    video.style.left = "-9999px";
    video.style.top = "-9999px";
    video.style.width = "1px";
    video.style.height = "1px";

    const timer = setTimeout(() => finish(null), timeoutMs);

    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      const duration = isFinite(video.duration) ? video.duration : 0;
      const t = duration > 0 ? Math.min(seekTo, Math.max(0, duration - 0.05)) : seekTo;
      try {
        video.currentTime = t > 0 ? t : 0.001;
      } catch {
        finish(null);
      }
    };
    video.onseeked = () => {
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) {
          finish(null);
          return;
        }
        const scale = Math.min(1, maxWidth / vw);
        const w = Math.max(1, Math.round(vw * scale));
        const h = Math.max(1, Math.round(vh * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          finish(null);
          return;
        }
        ctx.drawImage(video, 0, 0, w, h);
        canvas.toBlob(
          (blob) => finish(blob || null),
          "image/jpeg",
          quality,
        );
      } catch {
        // CORS-tainted canvas or other SecurityError → no poster.
        finish(null);
      }
    };

    video.src = videoUrl;
    document.body.appendChild(video);
  });
}

// Upload an arbitrary Blob (used for generated video posters) to the
// Cloudflare R2 storage endpoint and return the public URL. Returns `null`
// on failure so callers can fall back to "no poster".
export async function uploadBlobToR2(blob: Blob, filename: string): Promise<string | null> {
  try {
    // client.storage.upload expects a File (which extends Blob) — wrap the
    // canvas blob so the upload FormData picks up the filename + MIME type.
    const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
    const response = await client.storage.upload(file, filename);
    const data = response?.data;
    if (typeof data === "string") return data;
    if (data && typeof (data as { url?: unknown }).url === "string") {
      return (data as { url: string }).url;
    }
    return null;
  } catch {
    return null;
  }
}

// Convenience: generate a poster from `videoUrl` and upload it to R2.
// Returns the poster URL, or `null` if any step failed.
export async function attachVideoPoster(videoUrl: string): Promise<string | null> {
  const blob = await generateVideoPosterBlob(videoUrl);
  if (!blob) return null;
  const ext = blob.type.includes("png") ? "png" : "jpg";
  const name = `video-poster-${Date.now()}.${ext}`;
  return uploadBlobToR2(blob, name);
}
