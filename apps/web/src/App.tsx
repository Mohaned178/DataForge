import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { CHAOS_PROFILE_KIND, SCENARIO_KIND } from './documents/kinds';
import { AggregatePage, EventRedirect } from './pages/aggregate/AggregatePage';
import { ExecutionPage } from './pages/execution/ExecutionPage';
import { ExecutionsPage } from './pages/ExecutionsPage';
import { DocumentListPage, DocumentPage, NewDocumentPage, NewVersionPage } from './pages/documents/DocumentPages';
import { NewExecutionPage, NewRunPage } from './pages/launch/LaunchPages';
import { RunPage } from './pages/RunPage';
import { RunsPage } from './pages/RunsPage';

function NotFoundPage() {
  return (
    <>
      <h1>Page not found</h1>
      <p>
        There is no such page. Go to the <Link to="/executions">executions</Link> or the <Link to="/runs">runs</Link>.
      </p>
    </>
  );
}

/** The routes, without a router: the browser wraps them in BrowserRouter, the tests in MemoryRouter. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/executions" replace />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/new" element={<NewRunPage />} />
        <Route path="runs/:runId" element={<RunPage />} />
        <Route path="executions" element={<ExecutionsPage />} />
        <Route path="executions/new" element={<NewExecutionPage />} />
        <Route path="executions/:executionId" element={<ExecutionPage />} />
        <Route path="scenarios" element={<DocumentListPage kind={SCENARIO_KIND} />} />
        <Route path="scenarios/new" element={<NewDocumentPage kind={SCENARIO_KIND} />} />
        <Route path="scenarios/:id" element={<DocumentPage kind={SCENARIO_KIND} />} />
        <Route path="scenarios/:id/versions/new" element={<NewVersionPage kind={SCENARIO_KIND} />} />
        <Route path="chaos-profiles" element={<DocumentListPage kind={CHAOS_PROFILE_KIND} />} />
        <Route path="chaos-profiles/new" element={<NewDocumentPage kind={CHAOS_PROFILE_KIND} />} />
        <Route path="chaos-profiles/:id" element={<DocumentPage kind={CHAOS_PROFILE_KIND} />} />
        <Route path="chaos-profiles/:id/versions/new" element={<NewVersionPage kind={CHAOS_PROFILE_KIND} />} />
        <Route path="executions/:executionId/aggregates/:aggregateId" element={<AggregatePage />} />
        <Route path="executions/:executionId/events/:eventId" element={<EventRedirect />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
