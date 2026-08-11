import { useEffect, useRef, useState } from "react";
import { ConfigWrapper } from "@rin/config";
import type { Profile } from "../state/profile";
import { defaultClientConfig } from "../state/config";
import { applyThemeColor } from "../utils/theme-color";
import { readBootstrappedClientConfig } from "./bootstrap-config";
import { client } from "./runtime";

function applyViewportScaling() {
  const highResolutionThreshold = 2560;
  document.documentElement.style.fontSize = window.screen.width >= highResolutionThreshold ? "125%" : "100%";
}

export function useAppBootstrap() {
  const initializedRef = useRef(false);
  const [profile, setProfile] = useState<Profile | undefined | null>(undefined);
  const [config, setConfig] = useState<ConfigWrapper>(new ConfigWrapper({}, new Map()));

  useEffect(() => {
    applyViewportScaling();

    if (initializedRef.current) {
      return;
    }

    const updateClientConfig = (nextConfig: Record<string, unknown>) => {
      sessionStorage.setItem("config", JSON.stringify(nextConfig));
      setConfig(new ConfigWrapper(nextConfig, defaultClientConfig));
      applyThemeColor(typeof nextConfig["theme.color"] === "string" ? nextConfig["theme.color"] : undefined);
    };

    client.user.profile().then(({ data, error }) => {
      if (data) {
        setProfile({
          id: data.id,
          avatar: data.avatar || "",
          permission: data.permission,
          name: data.username,
        });
      } else if (error) {
        setProfile(null);
      }
    });

    const cachedConfig = sessionStorage.getItem("config");
    const bootstrappedConfig = readBootstrappedClientConfig();

    if (bootstrappedConfig) {
      updateClientConfig(bootstrappedConfig);
    } else if (cachedConfig) {
      const configObject = JSON.parse(cachedConfig) as Record<string, unknown>;
      setConfig(new ConfigWrapper(configObject, defaultClientConfig));
      applyThemeColor(typeof configObject["theme.color"] === "string" ? configObject["theme.color"] : undefined);
    }

    initializedRef.current = true;
  }, []);

  // 设置保存后（settings.tsx 经由 window.dispatchEvent(new Event("storage")) 通知），
  // 重新读取 sessionStorage 中的最新客户端配置，使全局 config（以及 useSiteConfig）即时生效，
  // 无需整页刷新。注意：手动派发的 storage 事件 key 为空，因此这里无条件重读 sessionStorage。
  // feeds 为传统分页：page_size 经 useSiteConfig().pageSize 作为每页条数，保存设置后
  // feeds.tsx 用新的 limit 重新按 ?page 拉取对应页，列表即时按新每页数量分页。
  useEffect(() => {
    const handleStorage = () => {
      try {
        const cached = sessionStorage.getItem("config");
        if (!cached) return;
        const configObject = JSON.parse(cached) as Record<string, unknown>;
        setConfig(new ConfigWrapper(configObject, defaultClientConfig));
        applyThemeColor(typeof configObject["theme.color"] === "string" ? configObject["theme.color"] : undefined);
      } catch {
        // 解析失败时保持现状
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return { config, profile };
}
