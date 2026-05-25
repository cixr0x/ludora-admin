import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { useState } from 'react';
import { AdminLayout, type AdminSection } from './components/AdminLayout';
import { ListingCandidatesPage } from './pages/ListingCandidatesPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { ReviewTasksPage } from './pages/ReviewTasksPage';
import { StoreCandidatesPage } from './pages/StoreCandidatesPage';

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

function renderSection(section: AdminSection) {
  switch (section) {
    case 'stores':
      return <StoreCandidatesPage />;
    case 'listings':
      return <ListingCandidatesPage />;
    case 'reviews':
      return <ReviewTasksPage />;
    case 'items':
      return <PlaceholderPage title="Items" description="Item administration will be added as the catalog workflow comes online." />;
    case 'offers':
      return <PlaceholderPage title="Offers" description="Offer administration will be added after the offer ingestion workflow is available." />;
  }
}

export default function App() {
  const [activeSection, setActiveSection] = useState<AdminSection>('stores');

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AdminLayout activeSection={activeSection} onNavigate={setActiveSection}>
        {renderSection(activeSection)}
      </AdminLayout>
    </ThemeProvider>
  );
}
