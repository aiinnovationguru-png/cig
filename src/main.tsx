import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import "./index.css";
const App = React.lazy(() => import("./App"));
const WebApp = React.lazy(() => import("./WebApp"));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <React.Suspense fallback={<div className="p-8 text-sm text-slate-500">Caricamento CIG…</div>}>
      {isTauri() ? <App /> : <WebApp />}
    </React.Suspense>
  </React.StrictMode>,
);
