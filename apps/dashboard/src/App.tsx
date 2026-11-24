/**
 * Root application component.
 *
 * Routing:
 *   /login       - LoginPage (public, redirects to / if authenticated)
 *   /            - ShellPage (requires auth, redirects to /login if not)
 *     index      - DefaultRoute: always /home (the unified landing screen)
 *     *          - NotFoundPage (unknown route, rendered inside the shell)
 *
 * Auth gate: driven by a single TanStack Query call to GET /auth/me.
 * A 401 response means unauthenticated (useMe sets isError; data undefined).
 * While the initial /auth/me query is in flight, a blank screen is shown
 * (no flash of login page for already-authenticated users).
 *
 * NOTE: /auth/verify is NOT a client route. The server owns that path.
 * After a successful verify, the server redirects to / (this component).
 */
import { Routes, Route, Navigate } from "react-router-dom";
import { useMe } from "./auth.js";
import LoginPage from "./pages/LoginPage.js";
import ShellPage from "./pages/ShellPage.js";
import HomePage from "./pages/HomePage.js";
import FlowsPage from "./pages/FlowsPage.js";
import FlowEditorPage from "./pages/FlowEditorPage.js";
import ApprovalsPage from "./pages/ApprovalsPage.js";
import PeoplePage from "./pages/PeoplePage.js";
import PersonPage from "./pages/PersonPage.js";
import LifecyclePage from "./pages/LifecyclePage.js";
import AnalyticsPage from "./pages/AnalyticsPage.js";
import KbPage from "./pages/KbPage.js";
import KbNewPage from "./pages/KbNewPage.js";
import KbDetailPage from "./pages/KbDetailPage.js";
import SettingsLayout from "./pages/settings/SettingsLayout.js";
import ProfileSettings from "./pages/settings/ProfileSettings.js";
import TeamSettings from "./pages/settings/TeamSettings.js";
import LlmSettings from "./pages/settings/LlmSettings.js";
import TransportSettings from "./pages/settings/TransportSettings.js";
import PaceSettings from "./pages/settings/PaceSettings.js";
import BrandingSettings from "./pages/settings/BrandingSettings.js";
import PostalSettings from "./pages/settings/PostalSettings.js";
import NotFoundPage from "./pages/NotFoundPage.js";
import IntegratePage from "./pages/IntegratePage.js";
import SentLogPage from "./pages/SentLogPage.js";
import SentLogDetailPage from "./pages/SentLogDetailPage.js";
import SuppressionsPage from "./pages/SuppressionsPage.js";

/**
 * Default landing route. Always redirects to /home, which handles the
 * setup vs operational mode split internally. This preserves backwards
 * compatibility: anyone landing on / still gets routed to the right place.
 */
function DefaultRoute() {
  return <Navigate to="/home" replace />;
}

export default function App() {
  const { data: me, isLoading } = useMe();

  // While the initial session check is in flight, render nothing.
  // This prevents a flash of the login page for authenticated users.
  if (isLoading) {
    return null;
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          me ? <Navigate to="/" replace /> : <LoginPage />
        }
      />
      <Route
        path="/"
        element={
          me ? <ShellPage me={me} /> : <Navigate to="/login" replace />
        }
      >
        {/* Default child: always routes to /home, the unified landing. */}
        <Route index element={<DefaultRoute />} />
        <Route path="home" element={<HomePage />} />
        <Route path="integrate" element={<IntegratePage />} />
        <Route path="flows" element={<FlowsPage />} />
        <Route path="flows/new" element={<FlowEditorPage />} />
        <Route path="flows/:id/edit" element={<FlowEditorPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="people" element={<PeoplePage />} />
        <Route path="people/:id" element={<PersonPage />} />
        <Route path="lifecycle" element={<LifecyclePage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="sent" element={<SentLogPage />} />
        <Route path="sent/:id" element={<SentLogDetailPage />} />
        <Route path="sent/suppressions" element={<SuppressionsPage />} />
        <Route path="kb" element={<KbPage />} />
        <Route path="kb/new" element={<KbNewPage />} />
        <Route path="kb/:id" element={<KbDetailPage />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="/settings/profile" replace />} />
          <Route path="profile" element={<ProfileSettings />} />
          <Route path="team" element={<TeamSettings />} />
          <Route path="llm" element={<LlmSettings />} />
          <Route path="transport" element={<TransportSettings />} />
          <Route path="pace" element={<PaceSettings />} />
          <Route path="branding" element={<BrandingSettings />} />
          <Route path="postal" element={<PostalSettings />} />
        </Route>
        {/* Unknown route inside the shell: the chrome persists, only the
            content region reports the miss. */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
