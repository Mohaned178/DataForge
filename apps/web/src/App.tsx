import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { AggregatePage, EventRedirect } from './pages/aggregate/AggregatePage';
import { ExecutionPage } from './pages/execution/ExecutionPage';
import { ExecutionsPage } from './pages/ExecutionsPage';
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
        <Route path="runs/:runId" element={<RunPage />} />
        <Route path="executions" element={<ExecutionsPage />} />
        <Route path="executions/:executionId" element={<ExecutionPage />} />
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
