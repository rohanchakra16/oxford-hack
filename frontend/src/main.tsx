/**
 * Application entry wiring (shared file, owned by Person 5 for now; see docs/frontend-integration.md).
 * /diagnostics -> Person 5's developer diagnostics page. Everything else -> Person 4's product app.
 */
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';

const Diagnostics = lazy(() => import('./diagnostics/DiagnosticsPage'));
const ProductApp = lazy(() => import('./product/App'));

const isDiagnostics = window.location.pathname.replace(/\/+$/, '') === '/diagnostics';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>{isDiagnostics ? <Diagnostics /> : <ProductApp />}</Suspense>
  </StrictMode>,
);
