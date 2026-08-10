import type { ReactNode } from "react";
import { Suspense, useContext } from "react";
import { lazyWithRetry } from "./lazy-with-retry";
import type { DefaultParams, PathPattern } from "wouter";
import { Route, Switch } from "wouter";
import { AdminLayout } from "../components/admin-layout";
import Footer from "../components/footer";
import { Header } from "../components/header";
import { Padding } from "../components/padding";
import { getHeaderLayoutDefinition } from "../components/site-header/layout-registry";
import { Tips, TipsPage } from "../components/tips";
import useTableOfContents from "../hooks/useTableOfContents";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { ErrorPage } from "../page/error";
import { FeedsPage } from "../page/feeds";
import { FeedPage, TOCHeader } from "../page/feed";

// 路由级代码分割：除首页 FeedsPage、文章页 FeedPage 外，其余页面按需懒加载，
// 把 monaco(写作页)、各后台页、timeline/moments 等移出首屏 bundle。
const CallbackPage = lazyWithRetry(() => import("../page/callback").then((m) => ({ default: m.CallbackPage })));
const CompatTasksPage = lazyWithRetry(() => import("../page/compat-tasks").then((m) => ({ default: m.CompatTasksPage })));
const FriendsPage = lazyWithRetry(() => import("../page/friends").then((m) => ({ default: m.FriendsPage })));
const HealthPage = lazyWithRetry(() => import("../page/health").then((m) => ({ default: m.HealthPage })));
const HashtagPage = lazyWithRetry(() => import("../page/hashtag").then((m) => ({ default: m.HashtagPage })));
const HashtagsPage = lazyWithRetry(() => import("../page/hashtags").then((m) => ({ default: m.HashtagsPage })));
const LoginPage = lazyWithRetry(() => import("../page/login").then((m) => ({ default: m.LoginPage })));
const MomentsPage = lazyWithRetry(() => import("../page/moments").then((m) => ({ default: m.MomentsPage })));
const ProfilePage = lazyWithRetry(() => import("../page/profile").then((m) => ({ default: m.ProfilePage })));
const QueueStatusPage = lazyWithRetry(() => import("../page/queue-status").then((m) => ({ default: m.QueueStatusPage })));
const SearchPage = lazyWithRetry(() => import("../page/search").then((m) => ({ default: m.SearchPage })));
const Settings = lazyWithRetry(() => import("../page/settings").then((m) => ({ default: m.Settings })));
const TimelinePage = lazyWithRetry(() => import("../page/timeline").then((m) => ({ default: m.TimelinePage })));
const WritingPage = lazyWithRetry(() => import("../page/writing").then((m) => ({ default: m.WritingPage })));
const PostsManagePage = lazyWithRetry(() => import("../page/posts-manage").then((m) => ({ default: m.PostsManagePage })));
import { ProfileContext } from "../state/profile";
import { tryInt } from "../utils/int";
import { useTranslation } from "react-i18next";

export function AppRoutes() {
  const { t } = useTranslation();

  return (
    <Switch>
      <AppRoute path="/">
        <FeedsPage />
      </AppRoute>

      <AppRoute path="/timeline">
        <TimelinePage />
      </AppRoute>

      <AppRoute path="/moments">
        <MomentsPage />
      </AppRoute>

      <AppRoute path="/friends">
        <FriendsPage />
      </AppRoute>

      <AppRoute path="/hashtags">
        <HashtagsPage />
      </AppRoute>

      <AppRoute path="/hashtag/:name">
        {(params) => <HashtagPage name={params.name || ""} />}
      </AppRoute>

      <AppRoute path="/search/:keyword">
        {(params) => <SearchPage keyword={params.keyword || ""} />}
      </AppRoute>

      <AdminRoute path="/admin/settings" requirePermission title={t("settings.title")} description={t("admin.settings_description")}>
        <Settings />
      </AdminRoute>

      <AdminRoute path="/admin/health" requirePermission title={t("health.title")} description={t("admin.health_description")}>
        <HealthPage />
      </AdminRoute>

      <AdminRoute path="/admin/queue-status" requirePermission title={t("queue_status.title")} description={t("admin.queue_status_description")}>
        <QueueStatusPage />
      </AdminRoute>

      <AdminRoute path="/admin/compat-tasks" requirePermission title={t("compat_tasks.title")} description={t("admin.compat_tasks_description")}>
        <CompatTasksPage />
      </AdminRoute>

      <AdminRoute path="/admin/writing" requirePermission title={t("writing")} description={t("admin.writing_description")}>
        <WritingPage />
      </AdminRoute>

      <AdminRoute path="/admin/writing/:id" requirePermission title={t("writing")} description={t("admin.writing_description")}>
        {({ id }) => <WritingPage key={id} id={tryInt(0, id)} />}
      </AdminRoute>

      <AdminRoute path="/admin/posts" requirePermission title={t("admin.posts.title")} description={t("admin.posts.description")}>
        <PostsManagePage />
      </AdminRoute>

      <AppRoute path="/callback">
        <CallbackPage />
      </AppRoute>

      <AppRoute path="/login">
        <LoginPage />
      </AppRoute>

      <AppRoute path="/profile">
        <ProfilePage />
      </AppRoute>

      <TocRoute path="/feed/:id">
        {(params, toc, cleanup) => <FeedPage id={params.id || ""} TOC={toc} clean={cleanup} />}
      </TocRoute>

      <TocRoute path="/:alias">
        {(params, toc, cleanup) => <FeedPage id={params.alias || ""} TOC={toc} clean={cleanup} />}
      </TocRoute>

      <AppRoute path="/user/github">
        <TipsPage>
          <Tips value={t("error.api_url")} type="error" />
        </TipsPage>
      </AppRoute>

      <AppRoute path="/*/user/github">
        <TipsPage>
          <Tips value={t("error.api_url_slash")} type="error" />
        </TipsPage>
      </AppRoute>

      <AppRoute path="/user/github/callback">
        <TipsPage>
          <Tips value={t("error.github_callback")} type="error" />
        </TipsPage>
      </AppRoute>

      <AppRoute>
        <ErrorPage error={t("error.not_found")} />
      </AppRoute>
    </Switch>
  );
}

function AppRoute({
  path,
  children,
  headerComponent,
  paddingClassName,
  requirePermission,
}: {
  path?: PathPattern;
  children: ReactNode | ((params: DefaultParams) => ReactNode);
  headerComponent?: ReactNode;
  paddingClassName?: string;
  requirePermission?: boolean;
}) {
  const profile = useContext(ProfileContext);
  const siteConfig = useSiteConfig();
  const { t } = useTranslation();

  const content =
    requirePermission && !profile?.permission ? <ErrorPage error={t("error.permission_denied")} /> : children;

  return (
    <Route path={path}>
      {(params) => {
        const resolvedContent = typeof content === "function" ? content(params) : content;
        const layoutDefinition = getHeaderLayoutDefinition(siteConfig.headerLayout);

        return layoutDefinition.renderRouteShell({
          header: <Header>{headerComponent}</Header>,
          content: (
            <Padding className={paddingClassName}>
              <Suspense fallback={<RouteLoading />}>{resolvedContent}</Suspense>
            </Padding>
          ),
          footer: <Footer />,
          paddingClassName,
        });
      }}
    </Route>
  );
}

function AdminRoute({
  path,
  children,
  requirePermission,
  title,
  description,
}: {
  path: PathPattern;
  children: ReactNode | ((params: DefaultParams) => ReactNode);
  requirePermission?: boolean;
  title: string;
  description: string;
}) {
  const profile = useContext(ProfileContext);
  const { t } = useTranslation();
  const content =
    requirePermission && !profile?.permission ? <ErrorPage error={t("error.permission_denied")} /> : children;

  return (
    <Route path={path}>
      {(params) => (
        <AdminLayout title={title} description={description}>
          {/* 后台页（Health/QueueStatus/CompatTasks/Settings/Writing 等）已改为 lazyWithRetry()（带失败自动重试），
              必须套一层 Suspense 接住挂起，否则点进后台时懒加载组件挂起会抛
              React #426 "suspended while responding to synchronous input" 白屏。
              与前台 AppRoute 保持一致的写法。 */}
          <Suspense fallback={<RouteLoading />}>
            {typeof content === "function" ? content(params) : content}
          </Suspense>
        </AdminLayout>
      )}
    </Route>
  );
}

function TocRoute({
  path,
  children,
}: {
  path: PathPattern;
  children: (params: DefaultParams, toc: () => JSX.Element, cleanup: (id: string) => void) => ReactNode;
}) {
  const { TOC, cleanup } = useTableOfContents(".toc-content");

  return (
    <AppRoute path={path} headerComponent={TOCHeader({ TOC })} paddingClassName="mx-4">
      {(params) => children(params, TOC, cleanup)}
    </AppRoute>
  );
}

// 路由级懒加载（含写作页 / monaco 等大 chunk）加载中 / 重试期间的占位。
// 替代原来的 `fallback={null}` 白屏，让用户明确看到「正在加载」而非误判为卡死。
function RouteLoading() {
  return (
    <div className="flex min-h-[40vh] w-full items-center justify-center">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600 dark:border-neutral-700 dark:border-t-neutral-300"
        role="status"
        aria-label="Loading"
      />
    </div>
  );
}
