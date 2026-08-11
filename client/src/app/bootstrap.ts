import i18n from "i18next";
import Backend from "i18next-http-backend";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { listenSystemMode } from "../utils/darkModeUtils";
import { readBootstrappedClientConfig } from "./bootstrap-config";

let bootstrapped = false;

// 仅记录“用户主动选择”的语言，避免被 LanguageDetector 在旧版本中自动缓存的
// i18nextLng(浏览器探测值，常为 en) 绑架，导致修复后仍显示英文。
const LANGUAGE_OVERRIDE_KEY = "rin_lang_override";

// 语言优先级：用户主动选择(rin_lang_override) > 站点默认语言 > zh-CN
// 这样首次访问即跟随站点语言(中文)，用户手动切换后仍能被记住。
function resolveInitialLanguage(siteLanguage: string): string {
  try {
    const stored = localStorage.getItem(LANGUAGE_OVERRIDE_KEY);
    if (stored && stored.trim().length > 0) {
      return stored.trim();
    }
  } catch {
    // localStorage 不可用(隐私模式/SSR)时忽略，回退到站点语言
  }
  return siteLanguage || "zh-CN";
}

// 构建时通过 Vite `define` 注入的版本号，用于给 locale JSON 请求追加
// `?v=<buildVersion>` 查询参数。locale 文件经 worker 的 [assets] 以
// `cache-control: public, max-age=31536000, immutable` 响应，URL 本身未哈希，
// 因此浏览器会缓存旧 locale 且永不重拉。自 `c04a14a` 起新增的翻页键在
// 已缓存旧 locale 的浏览器上缺失 → 回退英文、且 `page_current`(第 1 / 1 页)消失。
// 每次部署改变版本号即可让请求 URL 变化，绕开 `immutable` 缓存，强制拉取新 locale。
function getLocaleCacheBust(): string | undefined {
  try {
    const v = __RIN_BUILD_VERSION__;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

export function bootstrapApp() {
  if (bootstrapped) {
    return;
  }

  listenSystemMode();

  const bootstrapConfig = readBootstrappedClientConfig();
  const siteLanguage =
    typeof bootstrapConfig?.["site.language"] === "string"
      ? (bootstrapConfig["site.language"] as string)
      : "zh-CN";
  const initialLanguage = resolveInitialLanguage(siteLanguage);

  const localeCacheBust = getLocaleCacheBust();

  i18n
    .use(Backend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      // 显式设定初始语言，绕过 LanguageDetector 的浏览器自动检测，避免默认被强制为英文
      lng: initialLanguage,
      // 最终安全兜底：若 site.language 指向不存在的 locale 文件，回退英文
      fallbackLng: "en",
      interpolation: {
        escapeValue: false,
      },
      backend: {
        // 默认即为 /locales/{{lng}}/translation.json，显式写出便于理解
        loadPath: "/locales/{{lng}}/translation.json",
        // 追加构建版本参数：改变请求 URL，使 `immutable` 缓存只对旧 URL 生效，
        // 已缓存旧 locale 的浏览器也会拉取带新版本号的新 URL，正确显示中文翻页键。
        queryStringParams: localeCacheBust ? { v: localeCacheBust } : undefined,
      },
    });

  bootstrapped = true;
}
