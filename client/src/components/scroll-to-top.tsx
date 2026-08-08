import { useEffect } from "react";
import { useLocation } from "wouter";

// 路由切换时把页面滚回顶部。
// 注意：只按 pathname 判定，不能把整个 location（含 search）作为依赖，
// 否则点击「下一页」(?page=N) 会触发这里把页面重置到顶部，
// 覆盖 feeds.tsx 里深链 ?page=N 的「预热后滚到底部」逻辑。
export function ScrollToTop() {
  const [location] = useLocation();
  const pathname = location.split("?")[0];
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}
