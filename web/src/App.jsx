import React, { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import { api, clearAdminToken, resetCsrfToken } from "./api.js";
import Login from "./pages/Login.jsx";
import Overview from "./pages/Overview.jsx";
import Routing from "./pages/Routing.jsx";
import Recommendations from "./pages/Recommendations.jsx";
import Requests from "./pages/Requests.jsx";
import Settings from "./pages/Settings.jsx";
import Docs from "./pages/Docs.jsx";
import Models from "./pages/Models.jsx";
import ModelEvals from "./pages/ModelEvals.jsx";
import Budgets from "./pages/Budgets.jsx";
import Audit from "./pages/Audit.jsx";
import Governance from "./pages/Governance.jsx";
import Applications from "./pages/Applications.jsx";
import ApplicationDetail from "./pages/ApplicationDetail.jsx";
import Users from "./pages/Users.jsx";

export default function App() {
  const [status, setStatus] = useState(null);
  // null = probing, "open" = no auth needed / authed, "login" = needs to sign in
  const [authState, setAuthState] = useState(null);
  // "adminkey" (default) | "oidc" | "trusted-header" — which Login.jsx renders
  const [authMode, setAuthMode] = useState("adminkey");
  const [user, setUser] = useState(null); // { id, email, role } once authed under oidc/trusted-header

  // Always re-fetch the real auth mode before showing Login — its default value
  // is only ever correct by accident (e.g. never updated if the very first
  // refreshStatus() call succeeds, since that path has no reason to touch it).
  const goToLogin = async () => {
    try { setAuthMode((await api.authMode()).mode); } catch { /* keep prior value */ }
    setAuthState("login");
  };

  const refreshStatus = () =>
    api.status()
      .then(async (s) => {
        setStatus(s);
        setAuthState("open");
        try { setUser((await api.currentUser()).user); } catch { setUser(null); }
      })
      .catch((e) => {
        if (e.status !== 401) return;
        return goToLogin();
      });
  useEffect(() => { refreshStatus(); }, []);

  const signOut = async () => {
    try { await api.logout(); } catch { /* ignore — still clear local state */ }
    clearAdminToken();
    resetCsrfToken();
    setStatus(null);
    setUser(null);
    await goToLogin();
  };

  if (authState === "login") return <Login mode={authMode} onAuthed={refreshStatus} />;
  if (authState === null) return null; // probing — avoid a flash of either state

  return (
    <Layout status={status} user={user} onSignOut={signOut}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/applications" element={<Applications />} />
        <Route path="/applications/:name" element={<ApplicationDetail />} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/routing" element={<Routing onChange={refreshStatus} />} />
        <Route path="/recommendations" element={<Recommendations />} />
        <Route path="/budgets" element={<Budgets onChange={refreshStatus} />} />
        <Route path="/models" element={<Models />} />
        <Route path="/evals" element={<ModelEvals />} />
        <Route path="/settings" element={<Settings onChange={refreshStatus} />} />
        <Route path="/governance" element={<Governance />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/users" element={<Users />} />
        <Route path="/docs" element={<Docs />} />

        {/* Redirects for old / deep links. */}
        <Route path="/rules" element={<Navigate to="/routing" replace />} />
        <Route path="/views" element={<Navigate to="/?tab=dimensions" replace />} />
      </Routes>
    </Layout>
  );
}
