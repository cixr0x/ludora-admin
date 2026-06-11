import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import BuildIcon from '@mui/icons-material/Build';
import CategoryIcon from '@mui/icons-material/Category';
import MenuOpenIcon from '@mui/icons-material/MenuOpen';
import StorefrontIcon from '@mui/icons-material/Storefront';
import ViewCarouselIcon from '@mui/icons-material/ViewCarousel';
import ViewListIcon from '@mui/icons-material/ViewList';
import {
  AppBar,
  Box,
  Divider,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Typography
} from '@mui/material';
import type { ReactNode } from 'react';

export type AdminSection =
  | 'store-candidates'
  | 'stores'
  | 'listings'
  | 'reviews'
  | 'operations'
  | 'items'
  | 'front-page-category-options'
  | 'front-page-category-products'
  | 'front-page-preview'
  | 'front-page-categories'
  | 'offer-reviews';

type NavigationItem = {
  id: AdminSection;
  label: string;
  icon: ReactNode;
};

const drawerWidth = 248;

const navigationItems: NavigationItem[] = [
  { id: 'store-candidates', label: 'Store Candidates', icon: <StorefrontIcon fontSize="small" /> },
  { id: 'stores', label: 'Stores', icon: <StorefrontIcon fontSize="small" /> },
  { id: 'listings', label: 'Store Items', icon: <ViewListIcon fontSize="small" /> },
  { id: 'reviews', label: 'Review Tasks', icon: <AssignmentTurnedInIcon fontSize="small" /> },
  { id: 'operations', label: 'Operations', icon: <BuildIcon fontSize="small" /> },
  { id: 'items', label: 'Items', icon: <CategoryIcon fontSize="small" /> },
  { id: 'front-page-category-options', label: 'Add Front Page Category', icon: <AddCircleIcon fontSize="small" /> },
  { id: 'front-page-categories', label: 'Front Page Categories', icon: <CategoryIcon fontSize="small" /> },
  { id: 'front-page-preview', label: 'Front Page Preview', icon: <ViewCarouselIcon fontSize="small" /> },
  { id: 'offer-reviews', label: 'Store Item Review', icon: <ViewListIcon fontSize="small" /> }
];

type AdminLayoutProps = {
  activeSection: AdminSection;
  children: ReactNode;
  onNavigate: (section: AdminSection) => void;
};

export function AdminLayout({ activeSection, children, onNavigate }: AdminLayoutProps) {
  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'grey.100' }}>
      <AppBar
        color="inherit"
        elevation={0}
        position="fixed"
        sx={{ borderBottom: 1, borderColor: 'divider', ml: `${drawerWidth}px`, width: `calc(100% - ${drawerWidth}px)` }}
      >
        <Toolbar variant="dense" sx={{ minHeight: 56 }}>
          <MenuOpenIcon color="action" fontSize="small" sx={{ mr: 1.5 }} />
          <Typography component="h1" variant="h6" sx={{ fontSize: '1rem', fontWeight: 700 }}>
            Ludora Admin
          </Typography>
        </Toolbar>
      </AppBar>

      <Drawer
        open
        variant="permanent"
        sx={{
          '& .MuiDrawer-paper': {
            boxSizing: 'border-box',
            width: drawerWidth,
            borderRightColor: 'divider'
          },
          flexShrink: 0,
          width: drawerWidth
        }}
      >
        <Toolbar variant="dense" sx={{ alignItems: 'center', minHeight: 56, px: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            Admin Console
          </Typography>
        </Toolbar>
        <Divider />
        <List dense component="nav" sx={{ px: 1, py: 1.5 }}>
          {navigationItems.map((item) => (
            <ListItemButton
              component="a"
              href={`#${item.id}`}
              key={item.id}
              selected={activeSection === item.id}
              sx={{ borderRadius: 1, mb: 0.5 }}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(item.id);
              }}
            >
              <ListItemIcon sx={{ minWidth: 36 }}>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 14 }} />
            </ListItemButton>
          ))}
        </List>
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, p: 3, pt: 9 }}>
        {children}
      </Box>
    </Box>
  );
}
