import { AppProviders } from "./app/providers";
import { AppRoutes } from "./app/routes";
import { useAppBootstrap } from "./app/use-app-bootstrap";
import { ScrollToTop } from "./components/scroll-to-top";
import { UploadProgressLayer } from "./components/upload-progress-layer";

function App() {
  const { config, profile } = useAppBootstrap();

  return (
    <AppProviders config={config} profile={profile}>
      <ScrollToTop />
      <AppRoutes />
      <UploadProgressLayer />
    </AppProviders>
  )
}

export default App
