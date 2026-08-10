// 浏览器内图片压缩：把用户选择的图片重编码（优先 WebP，必要时 JPEG），
// 上传前调用，从而大幅减小存储与传输体积、加快页面加载。
//
// 固定参数：最长边 1920px + 质量 0.5；压缩后目标上限 800KB。
// 不做动态质量调节——统一的固定档位既能满足博客展示清晰度，又让体积可控。
//
// 设计要点：
// - 强制开启、忽略开关偏好：任何图片都重编码为更小体积（优先 WebP，
//   浏览器不支持 WebP 编码时回退 JPEG），不再有「关」的路径。
// - SVG / GIF 跳过（矢量不重编码、动图保留动画）。
// - 已经很小且不超边长上限的图跳过，避免重编码开销导致反而变大。
// - 结果超过 800KB 目标时自动降质 + 缩小边长，尽量压到目标以内。
// - 所有尝试都无法得到比原图更小的图时，退回原图（安全兜底）。

export interface CompressImageOptions {
  // 最长边上限（像素），固定 1920。
  maxEdge?: number;
  // WebP 编码质量 0..1，固定 0.5。
  quality?: number;
  // 体积小于等于此值且未超边长上限时跳过压缩，固定 120KB。
  minBytes?: number;
  // 压缩后目标上限（字节）。结果超过此值时继续降质/缩小边长，确保体积可控。
  // 默认 800KB。
  targetMaxBytes?: number;
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

// 按最长边上限把位图绘制到新 canvas，返回 canvas 及实际尺寸。
function drawScaled(
  bitmap: ImageBitmap,
  maxEdge: number,
): { canvas: HTMLCanvasElement; w: number; h: number } | null {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { canvas, w, h };
}

export async function compressImageFile(
  file: File,
  opts: CompressImageOptions = {},
): Promise<File> {
  // 非图片：原样返回（压缩已强制开启，不再受开关控制）
  if (!isImageFileType(file)) return file;

  const lower = (file.name || "").toLowerCase();
  if (lower.endsWith(".svg") || lower.endsWith(".gif")) return file;

  // 固定参数：1920px 长边 + q0.5；压缩后目标上限 800KB。
  const maxEdge = opts.maxEdge ?? 1920;
  const quality = opts.quality ?? 0.5;
  const minBytes = opts.minBytes ?? 120_000;
  const targetMaxBytes = opts.targetMaxBytes ?? 800_000;

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

  // 本来就小且不超边长：跳过，避免无谓重编码
  if (Math.max(width, height) <= maxEdge && file.size <= minBytes) {
    bitmap.close?.();
    return file;
  }

  const tryEncode = (canvas: HTMLCanvasElement, type: string, q: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, q));

  // 编码阶梯：WebP 优先；结果超过 targetMaxBytes 时逐步降质 + 缩小边长，
  // 仍不行则回退 JPEG。任意结果只要小于原图即采用，并优先「达标」（≤目标）。
  // 这样既保证「压缩一定发生」（杜绝大原图直传），又尽量把体积压到 800KB 以内。
  const attempts: Array<{ type: string; q: number; edge: number }> = [
    { type: "image/webp", q: quality, edge: maxEdge },
    { type: "image/jpeg", q: Math.min(0.85, quality + 0.35), edge: maxEdge },
    { type: "image/webp", q: Math.max(0.4, quality - 0.1), edge: Math.round(maxEdge * 0.8) },
    { type: "image/jpeg", q: 0.8, edge: Math.round(maxEdge * 0.8) },
    { type: "image/webp", q: 0.35, edge: Math.round(maxEdge * 0.6) },
    { type: "image/jpeg", q: 0.7, edge: Math.round(maxEdge * 0.6) },
  ];

  let best: { blob: Blob; type: string } | null = null;
  for (const a of attempts) {
    const drawn = drawScaled(bitmap, a.edge);
    if (!drawn) break;
    const blob = await tryEncode(drawn.canvas, a.type, a.q);
    if (!blob) continue;
    if (blob.size < file.size) {
      if (!best || blob.size < best.blob.size) best = { blob, type: a.type };
      if (blob.size <= targetMaxBytes) break; // 已达标，无需更低质
    }
  }
  bitmap.close?.();

  if (!best) return file; // 所有尝试都失败或都不小于原图
  const name = best.type === "image/webp" ? renameToWebp(file.name) : renameToJpeg(file.name);
  return new File([best.blob], name, { type: best.type });
}
