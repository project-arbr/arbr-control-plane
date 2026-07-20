import React, { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import { api, clearAdminToken } from "./api.js";
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

  const refreshStatus = () =>
    api.status()
      .then(async (s) => {
        setStatus(s);
        setAuthState("open");
        try { setUser((await api.currentUser()).user); } catch { setUser(null); }
      })
      .catch(async (e) => {
        if (e.status !== 401) return;
        try { setAuthMode((await api.authMode()).mode); } catch { /* keep default */ }
        setAuthState("login");
      });
  useEffect(() => { refreshStatus(); }, []);

  const signOut = async () => {
    try { await api.logout(); } catch { /* ignore — still clear local state */ }
    clearAdminToken();
    setStatus(null);
    setUser(null);
    setAuthState("login");
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
