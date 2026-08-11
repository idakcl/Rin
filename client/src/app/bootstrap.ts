import i18n from "i18next";
import Backend from "i18next-http-backend";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { listenSystemMode } from "../utils/darkModeUtils";
import { readBootstrappedClientConfig } from "./bootstrap-config";

let bootstrapped = false;

// 语言优先级：用户手动选择(localStorage，由 LanguageDetector 持久化) > 站点默认语言 > zh-CN
// 这样首次访问即跟随站点语言(中文)，用户手动切换后仍能被记住。
function resolveInitialLanguage(siteLanguage: string): string {
  try {
    const stored = localStorage.getItem("i18nextLng");
    if (stored && stored.trim().length > 0) {
      return stored.trim();
    }
  } catch {
    // localStorage 不可用(隐私模式/SSR)时忽略，回退到站点语言
  }
  return siteLanguage || "zh-CN";
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
    });

  bootstrapped = true;
}
