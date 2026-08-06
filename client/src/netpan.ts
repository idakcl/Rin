// netpan (Sanyue ImgHub / CloudFlare-ImgBed) 私人网盘配置
// 写作编辑框的「上传视频」按钮会把视频直传到这里。
//
// Token 仅通过「构建期环境变量」VITE_NETPAN_UPLOAD_TOKEN 注入，不写入源码/仓库。
// 获取方式：netpan 后台 → API Tokens → 新建一个拥有 `upload` 权限的 Token，
// 然后在仓库 Secrets 中添加 VITE_NETPAN_UPLOAD_TOKEN（值即该 Token）。
// 同时需由 Build 工作流把该 Secret 透传给客户端构建（见 .github/workflows/build.yml）。
//
// 后端上传接口基于 CloudFlare-ImgBed，POST multipart 表单字段为 `file`，
// 鉴权头为 `Authorization: Bearer <token>`，返回 JSON 数组 [{ src, publicUrl }]。

export const NETPAN_UPLOAD_URL = "https://netpan.1234.nyc.mn/upload";
export const NETPAN_BASE_URL = "https://netpan.1234.nyc.mn";

// 仅从构建期环境变量读取；未设置时为空字符串（上传前会被显式拦截并提示）。
export const NETPAN_UPLOAD_TOKEN: string =
  (import.meta.env?.VITE_NETPAN_UPLOAD_TOKEN as string | undefined) ?? "";

// 视频大小上限：留余量给 Cloudflare Worker 的请求体上限（约 100MB）。
export const NETPAN_MAX_FILE_SIZE = 80 * 1024 * 1024;
