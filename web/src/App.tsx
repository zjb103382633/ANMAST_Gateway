import { Routes, Route, Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./auth";
import { RefreshProvider } from "./refresh";
import MainLayout from "./layout/MainLayout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Monitor from "./pages/Monitor";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Routing from "./pages/Routing";
import ModelTest from "./pages/ModelTest";
import Skills from "./pages/Skills";
import Mcp from "./pages/Mcp";
import ApiKeys from "./pages/ApiKeys";
import Logs from "./pages/Logs";
import Conversations from "./pages/Conversations";
import Settings from "./pages/Settings";
import Usage from "./pages/Usage";
import Compression from "./pages/Compression";

function RequireAuth({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <RefreshProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <MainLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="monitor" element={<Monitor />} />
          <Route path="usage" element={<Usage />} />
          <Route path="providers" element={<Providers />} />
          <Route path="models" element={<Models />} />
          <Route path="routing" element={<Routing />} />
          <Route path="model-test" element={<ModelTest />} />
          <Route path="skills" element={<Skills />} />
          <Route path="mcp" element={<Mcp />} />
          <Route path="keys" element={<ApiKeys />} />
          <Route path="logs" element={<Logs />} />
          <Route path="conversations" element={<Conversations />} />
          <Route path="settings" element={<Settings />} />
          <Route path="compression" element={<Compression />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </RefreshProvider>
  );
}
