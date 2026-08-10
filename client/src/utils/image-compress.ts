// 浏览器内图片压缩：把用户选择的图片重编码为 WebP（限制最长边 + 固定降质），
// 上传前调用，从而大幅减小存储与传输体积、加快页面加载。
//
// 固定参数：最长边 1920px + 质量 0.5，输出稳定在「几百 KB」量级。
// 不做动态质量调节——统一的固定档位既能满足博客展示清晰度，又让体积可控。
//
// 设计要点：
// - 强制开启、忽略开关偏好：任何图片都重编码为更小体积（优先 WebP，
//   浏览器不支持 WebP 编码时回退 JPEG），不再有「关」的路径。
// - SVG / GIF 跳过（矢量不重编码、动图保留动画）。
// - 已经很小且不超边长上限的图跳过，避免 WebP 开销导致反而变大。
// - 压缩后体积没变小也退回原图（安全兜底）。

export interface CompressImageOptions {
  // 最长边上限（像素），固定 1920。
  maxEdge?: number;
  // WebP 编码质量 0..1，固定 0.5（输出稳定在几百 KB 量级）。
  quality?: number;
  // 体积小于等于此值且未超边长上限时跳过压缩，固定 120KB。
  minBytes?: number;
}

function isImageFileType(file: File): boolean {
  return file.type.startsWith("image/");
}

function renameToWebp(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot > 0) return `${name.slice(0, dot)}.webp`;
  return `${name}.webp`;
}

function renameToJpeg(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot > 0) return `${name.slice(0, dot)}.jpeg`;
  return `${name}.jpeg`;
}

export async function compressImageFile(
  file: File,
  opts: CompressImageOptions = {},
): Promise<File> {
  // 非图片：原样返回（压缩已强制开启，不再受开关控制）
  if (!isImageFileType(file)) return file;

  const lower = (file.name || "").toLowerCase();
  if (lower.endsWith(".svg") || lower.endsWith(".gif")) return file;

  // 固定参数：1920px 长边 + q0.5，输出稳定在几百 KB 量级。
  const maxEdge = opts.maxEdge ?? 1920;
  const quality = opts.quality ?? 0.5;
  const minBytes = opts.minBytes ?? 120_000;

  let bitmap: ImageBitmap;
  try {
    if (typeof createImageBitmap !== "function") return file;
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  const { width, height } = bitmap;
  if (!width || !height) {
    bitmap.close?.();
    return file;
  }

  // 本来就小且不超边长：跳过，避免无谓重编码（WebP 对小图可能反而变大）
  if (Math.max(width, height) <= maxEdge && file.size <= minBytes) {
    bitmap.close?.();
    return file;
  }

  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const tryEncode = (type: string, q: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, q));

  // 优先 WebP（体积最小）。若浏览器不支持 WebP 编码（toBlob 返回 null）或
  // WebP 不比原图小，则回退到 JPEG——保证「压缩」一定发生（缩小尺寸 + 有损），
  // 彻底杜绝大原图不经压缩直传 R2 / netpan。
  const webp = await tryEncode("image/webp", quality);
  if (webp && webp.size < file.size) {
    return new File([webp], renameToWebp(file.name), { type: "image/webp" });
  }
  const jpeg = await tryEncode("image/jpeg", Math.min(0.92, quality + 0.42));
  if (jpeg && jpeg.size < file.size) {
    return new File([jpeg], renameToJpeg(file.name), { type: "image/jpeg" });
  }
  return file;
}
