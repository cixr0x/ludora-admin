import { Box, CircularProgress, CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { useEffect, useState } from 'react';
import { adminApi, setUnauthorizedHandler, type AdminIdentity, type FrontPageCategoryOption, type LoginInput } from './api/client';
import { AdminLayout, type AdminSection } from './components/AdminLayout';
import { LoginPage } from './components/LoginPage';
import { FrontPageCategoriesPage } from './pages/FrontPageCategoriesPage';
import { FrontPageCategoryOptionsPage } from './pages/FrontPageCategoryOptionsPage';
import { FrontPageCategoryProductsPage } from './pages/FrontPageCategoryProductsPage';
import { FrontPagePreviewPage } from './pages/FrontPagePreviewPage';
import { ItemsPage } from './pages/ItemsPage';
import { ListingCandidatesPage } from './pages/ListingCandidatesPage';
import { OfferReviewPage } from './pages/OfferReviewPage';
import { OperationsPage } from './pages/OperationsPage';
import { ReviewTasksPage } from './pages/ReviewTasksPage';
import { StoreCandidatesPage } from './pages/StoreCandidatesPage';
import { StoreItemDiscoveryLogPage } from './pages/StoreItemDiscoveryLogPage';
import { StoreItemUpdateHistoryPage } from './pages/StoreItemUpdateHistoryPage';
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

type AuthState =
  | { status: 'checking' }
  | { admin: AdminIdentity; status: 'authenticated' }
  | { error: string | null; status: 'unauthenticated' };

const adminSections: AdminSection[] = [
  'store-candidates',
  'stores',
  'listings',
  'reviews',
  'operations',
  'operations-store-discovery',
  'operations-store-item-discovery',
  'operations-store-item-update',
  'operations-item-embeddings',
  'operations-image-optimization',
  'items',
  'front-page-category-options',
  'front-page-category-products',
  'front-page-categories',
  'front-page-preview',
  'offer-reviews'
];

const routeAliases: Partial<Record<string, AdminSection>> = {
  operations: 'operations-store-discovery',
  'front-page-review': 'front-page-preview'
};

function parseAdminRoute(hash = window.location.hash): AdminRoute {
  const rawHash = hash.replace(/^#/, '');
  const [rawSection, rawQuery = ''] = rawHash.split('?');
  const aliasedSection = routeAliases[rawSection] ?? rawSection;
  const section = adminSections.includes(aliasedSection as AdminSection)
    ? (aliasedSection as AdminSection)
    : 'store-candidates';

  return {
    params: new URLSearchParams(rawQuery),
    section
  };
}

function routeHash(section: AdminSection) {
  return `#${section}`;
}

function frontPageCategoryProductsHash(option: FrontPageCategoryOption) {
  const params = new URLSearchParams({
    category_id: String(option.category_id),
    category_type: option.category_type,
    name: String(option.name_es ?? '').trim() || String(option.name ?? '').trim()
  });
  return `#front-page-category-products?${params.toString()}`;
}

function itemHash(itemId: string) {
  const params = new URLSearchParams({ id: itemId });
  return `#items?${params.toString()}`;
}

function renderSection(
  route: AdminRoute,
  navigate: (section: AdminSection) => void,
  navigateToFrontPageCategoryProducts: (option: FrontPageCategoryOption) => void,
  navigateToItem: (itemId: string) => void
) {
  const selectedId = route.params.get('id') ?? undefined;

  switch (route.section) {
    case 'store-candidates':
      return <StoreCandidatesPage />;
    case 'stores':
      return <StoresPage />;
    case 'listings':
      return (
        <ListingCandidatesPage
          selectedCandidateId={selectedId}
          onClearSelectedCandidateId={() => navigate('listings')}
          onOpenItem={navigateToItem}
        />
      );
    case 'reviews':
      return <ReviewTasksPage />;
    case 'operations':
    case 'operations-store-discovery':
      return <OperationsPage operation="store_discovery" />;
    case 'operations-store-item-discovery':
      return selectedId || route.params.get('job_id') ? (
        <StoreItemDiscoveryLogPage
          jobId={route.params.get('job_id') ?? selectedId ?? ''}
          onBack={() => navigate('operations-store-item-discovery')}
        />
      ) : (
        <OperationsPage operation="item_discovery" />
      );
    case 'operations-store-item-update':
      return route.params.get('run_id') ? (
        <StoreItemUpdateHistoryPage
          runId={route.params.get('run_id') ?? ''}
          onBack={() => navigate('operations-store-item-update')}
        />
      ) : (
        <OperationsPage operation="item_update" />
      );
    case 'operations-item-embeddings':
      return <OperationsPage operation="item_embeddings" />;
    case 'operations-image-optimization':
      return <OperationsPage operation="image_optimization" />;
    case 'items':
      return <ItemsPage selectedItemId={selectedId} onClearSelectedItemId={() => navigate('items')} />;
    case 'front-page-category-options':
      return <FrontPageCategoryOptionsPage onOpenProducts={navigateToFrontPageCategoryProducts} />;
    case 'front-page-category-products':
      return (
        <FrontPageCategoryProductsPage
          categoryId={route.params.get('category_id') ?? undefined}
          categoryType={route.params.get('category_type') ?? undefined}
          name={route.params.get('name') ?? undefined}
          onBack={() => navigate('front-page-category-options')}
        />
      );
    case 'front-page-categories':
      return <FrontPageCategoriesPage />;
    case 'front-page-preview':
      return <FrontPagePreviewPage />;
    case 'offer-reviews':
      return <OfferReviewPage />;
  }
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>({ status: 'checking' });
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [route, setRoute] = useState<AdminRoute>(() => parseAdminRoute());

  useEffect(() => {
    let isActive = true;
    setUnauthorizedHandler(() => {
      setAuthState({ error: null, status: 'unauthenticated' });
    });
    adminApi
      .getCurrentAdmin()
      .then((admin) => {
        if (isActive) {
          setAuthState({ admin, status: 'authenticated' });
        }
      })
      .catch(() => {
        if (isActive) {
          setAuthState({ error: null, status: 'unauthenticated' });
        }
      });

    return () => {
      isActive = false;
      setUnauthorizedHandler(null);
    };
  }, []);

  useEffect(() => {
    function handleHashChange() {
      setRoute(parseAdminRoute());
    }

    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  function navigate(section: AdminSection) {
    navigateToHash(routeHash(section));
  }

  function navigateToHash(nextHash: string) {
    if (window.location.hash === nextHash) {
      setRoute(parseAdminRoute(nextHash));
      return;
    }

    window.location.hash = nextHash;
  }

  async function handleLogin(input: LoginInput) {
    setIsLoggingIn(true);
    setAuthState({ error: null, status: 'unauthenticated' });
    try {
      const admin = await adminApi.login(input);
      setAuthState({ admin, status: 'authenticated' });
    } catch (error) {
      setAuthState({
        error: error instanceof Error ? error.message : 'Unable to sign in',
        status: 'unauthenticated'
      });
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function handleLogout() {
    try {
      await adminApi.logout();
    } finally {
      setAuthState({ error: null, status: 'unauthenticated' });
    }
  }

  function navigateToFrontPageCategoryProducts(option: FrontPageCategoryOption) {
    navigateToHash(frontPageCategoryProductsHash(option));
  }

  function navigateToItem(itemId: string) {
    navigateToHash(itemHash(itemId));
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {authState.status === 'checking' ? (
        <Box sx={{ alignItems: 'center', display: 'flex', justifyContent: 'center', minHeight: '100vh' }}>
          <CircularProgress aria-label="Checking admin session" />
        </Box>
      ) : authState.status === 'unauthenticated' ? (
        <LoginPage error={authState.error} isSubmitting={isLoggingIn} onSubmit={handleLogin} />
      ) : (
        <AdminLayout activeSection={route.section} onLogout={handleLogout} onNavigate={navigate}>
          {renderSection(route, navigate, navigateToFrontPageCategoryProducts, navigateToItem)}
        </AdminLayout>
      )}
    </ThemeProvider>
  );
}
