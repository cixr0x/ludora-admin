import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { useEffect, useState } from 'react';
import { AdminLayout, type AdminSection } from './components/AdminLayout';
import { ItemsPage } from './pages/ItemsPage';
import { ListingCandidatesPage } from './pages/ListingCandidatesPage';
import { OfferReviewPage } from './pages/OfferReviewPage';
import { OperationsPage } from './pages/OperationsPage';
import { ReviewTasksPage } from './pages/ReviewTasksPage';
import { StoreCandidatesPage } from './pages/StoreCandidatesPage';
import { StoresPage } from './pages/StoresPage';

const theme = createTheme({
  palette: {
    background: {
      default: '#f5f6f8'
    }
  },
  shape: {
    borderRadius: 6
  },
  typography: {
    fontFamily: ['Inter', 'Roboto', 'Arial', 'sans-serif'].join(',')
  }
});

type AdminRoute = {
  params: URLSearchParams;
  section: AdminSection;
};

const adminSections: AdminSection[] = [
  'store-candidates',
  'stores',
  'listings',
  'reviews',
  'operations',
  'items',
  'offer-reviews'
];

function parseAdminRoute(hash = window.location.hash): AdminRoute {
  const rawHash = hash.replace(/^#/, '');
  const [rawSection, rawQuery = ''] = rawHash.split('?');
  const section = adminSections.includes(rawSection as AdminSection) ? (rawSection as AdminSection) : 'store-candidates';

  return {
    params: new URLSearchParams(rawQuery),
    section
  };
}

function routeHash(section: AdminSection) {
  return `#${section}`;
}

function renderSection(route: AdminRoute, navigate: (section: AdminSection) => void) {
  const selectedId = route.params.get('id') ?? undefined;

  switch (route.section) {
    case 'store-candidates':
      return <StoreCandidatesPage />;
    case 'stores':
      return <StoresPage />;
    case 'listings':
      return <ListingCandidatesPage selectedCandidateId={selectedId} onClearSelectedCandidateId={() => navigate('listings')} />;
    case 'reviews':
      return <ReviewTasksPage />;
    case 'operations':
      return <OperationsPage />;
    case 'items':
      return <ItemsPage selectedItemId={selectedId} onClearSelectedItemId={() => navigate('items')} />;
    case 'offer-reviews':
      return <OfferReviewPage />;
  }
}

export default function App() {
  const [route, setRoute] = useState<AdminRoute>(() => parseAdminRoute());

  useEffect(() => {
    function handleHashChange() {
      setRoute(parseAdminRoute());
    }

    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  function navigate(section: AdminSection) {
    const nextHash = routeHash(section);
    if (window.location.hash === nextHash) {
      setRoute(parseAdminRoute(nextHash));
      return;
    }

    window.location.hash = nextHash;
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AdminLayout activeSection={route.section} onNavigate={navigate}>
        {renderSection(route, navigate)}
      </AdminLayout>
    </ThemeProvider>
  );
}
