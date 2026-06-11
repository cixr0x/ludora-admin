import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { useEffect, useState } from 'react';
import { AdminLayout, type AdminSection } from './components/AdminLayout';
import type { FrontPageCategoryOption } from './api/client';
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
  'front-page-category-options',
  'front-page-category-products',
  'front-page-categories',
  'front-page-preview',
  'offer-reviews'
];

const routeAliases: Partial<Record<string, AdminSection>> = {
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
    name: String(option.name ?? '').trim() || String(option.name_es ?? '').trim()
  });
  return `#front-page-category-products?${params.toString()}`;
}

function renderSection(
  route: AdminRoute,
  navigate: (section: AdminSection) => void,
  navigateToFrontPageCategoryProducts: (option: FrontPageCategoryOption) => void
) {
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
    navigateToHash(routeHash(section));
  }

  function navigateToHash(nextHash: string) {
    if (window.location.hash === nextHash) {
      setRoute(parseAdminRoute(nextHash));
      return;
    }

    window.location.hash = nextHash;
  }

  function navigateToFrontPageCategoryProducts(option: FrontPageCategoryOption) {
    navigateToHash(frontPageCategoryProductsHash(option));
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AdminLayout activeSection={route.section} onNavigate={navigate}>
        {renderSection(route, navigate, navigateToFrontPageCategoryProducts)}
      </AdminLayout>
    </ThemeProvider>
  );
}
