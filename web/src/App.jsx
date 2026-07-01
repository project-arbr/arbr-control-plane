import React, { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import { api, clearAdminToken } from "./api.js";
import Login from "./pages/Login.jsx";
import Overview from "./pages/Overview.jsx";
import Routing from "./pages/Routing.jsx";
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

export default function App() {
  const [status, setStatus] = useState(null);
  // null = probing, "open" = no auth needed / authed, "login" = needs the admin key
  const [authState, setAuthState] = useState(null);

  const refreshStatus = () =>
    api.status()
      .then((s) => { setStatus(s); setAuthState("open"); })
      .catch((e) => { if (e.status === 401) setAuthState("login"); });
  useEffect(() => { refreshStatus(); }, []);

  const signOut = () => { clearAdminToken(); setStatus(null); setAuthState("login"); };

  if (authState === "login") return <Login onAuthed={refreshStatus} />;
  if (authState === null) return null; // probing — avoid a flash of either state

  return (
    <Layout status={status} onSignOut={signOut}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/applications" element={<Applications />} />
        <Route path="/applications/:name" element={<ApplicationDetail />} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/routing" element={<Routing onChange={refreshStatus} />} />
        <Route path="/budgets" element={<Budgets onChange={refreshStatus} />} />
        <Route path="/models" element={<Models />} />
        <Route path="/evals" element={<ModelEvals />} />
        <Route path="/settings" element={<Settings onChange={refreshStatus} />} />
        <Route path="/governance" element={<Governance />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/docs" element={<Docs />} />

        {/* Redirects for old / deep links — pages now live as sub-tabs. */}
        <Route path="/rules" element={<Navigate to="/routing" replace />} />
        <Route path="/recommendations" element={<Navigate to="/routing?tab=recommendations" replace />} />
        <Route path="/views" element={<Navigate to="/?tab=dimensions" replace />} />
      </Routes>
    </Layout>
  );
}
