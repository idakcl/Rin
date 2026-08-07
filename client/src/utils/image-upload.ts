import { client } from "../app/runtime";
import { encodeBlurhash } from "./blurhash";
import { NETPAN_UPLOAD_URL, NETPAN_UPLOAD_TOKEN, NETPAN_BASE_URL } from "../netpan";

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
// A media fragment (`#t=0.1`) is appended so browsers seek to ~0.1s and paint
// that frame as a static preview BEFORE the user presses play — no separate
// poster image (and no backend thumbnail job) required. `preload="metadata"`
// keeps bandwidth low while still letting the preview frame decode.
export function buildMarkdownVideo(_fileName: string, url: string) {
  let safeUrl = url.replace(/\s/g, "%20");
  if (!safeUrl.includes("#")) {
    safeUrl += "#t=0.1";
  }
  return `\n<video src="${safeUrl}" controls preload="metadata" style="max-width:100%"></video>\n`;
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

export async function uploadImageFile(file: File): Promise<UploadedImageResult> {
  const [uploadResult, metadataResult] = await Promise.allSettled([
    client.storage.upload(file, file.name),
    generateImageMetadata(file),
  ]);

  if (uploadResult.status === "rejected") {
    throw uploadResult.reason instanceof Error
      ? uploadResult.reason
      : new Error("Upload failed");
  }

  const { data, error } = uploadResult.value;
  if (error) {
    throw new Error(error.value);
  }

  const url =
    typeof data === "string"
      ? data
      : data?.url;

  if (!url) {
    throw new Error("Invalid upload response");
  }

  return {
    url,
    ...(metadataResult.status === "fulfilled" ? metadataResult.value : {}),
  };
}

// Upload an arbitrary file directly to the user's private netpan (Sanyue
// ImgHub / CloudFlare-ImgBed) and return the public URL. The endpoint accepts
// a multipart `file` field and an `Authorization: Bearer <token>` header, and
// responds with a JSON array like [{ src: "/file/xxx", publicUrl: "https://..." }].
async function uploadToNetpan(file: File): Promise<string> {
  if (!NETPAN_UPLOAD_TOKEN) {
    throw new Error("未配置 netpan 上传 Token：请在仓库 Secrets 中添加 VITE_NETPAN_UPLOAD_TOKEN（需 upload 权限），并重新运行 Build");
  }

  const form = new FormData();
  form.append("file", file);

  const response = await fetch(NETPAN_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NETPAN_UPLOAD_TOKEN}`,
    },
    body: form,
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 120);
    } catch {
      // ignore
    }
    throw new Error(`netpan 上传失败 (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  const data = await response.json();
  const item = Array.isArray(data) ? data[0] : data;
  const raw = item?.publicUrl || item?.src;
  if (!raw) {
    throw new Error("netpan 返回缺少文件 URL");
  }
  return raw.startsWith("http") ? raw : `${NETPAN_BASE_URL}${raw}`;
}

export async function uploadVideoToNetpan(file: File): Promise<string> {
  return uploadToNetpan(file);
}

// Generic file upload (audio, documents, archives, etc.) backed by netpan.
export async function uploadFileToNetpan(file: File): Promise<string> {
  return uploadToNetpan(file);
}
