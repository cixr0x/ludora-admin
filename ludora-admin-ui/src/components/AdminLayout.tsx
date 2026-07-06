import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import BuildIcon from '@mui/icons-material/Build';
import CategoryIcon from '@mui/icons-material/Category';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuOpenIcon from '@mui/icons-material/MenuOpen';
import StorefrontIcon from '@mui/icons-material/Storefront';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import UpdateIcon from '@mui/icons-material/Update';
import ViewCarouselIcon from '@mui/icons-material/ViewCarousel';
import ViewListIcon from '@mui/icons-material/ViewList';
import {
  AppBar,
  Box,
  Button,
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
  | 'operations-store-discovery'
  | 'operations-store-item-discovery'
  | 'operations-store-item-update'
  | 'operations-item-embeddings'
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
  children?: NavigationItem[];
};

const drawerWidth = 248;

const navigationItems: NavigationItem[] = [
  { id: 'store-candidates', label: 'Store Candidates', icon: <StorefrontIcon fontSize="small" /> },
  { id: 'stores', label: 'Stores', icon: <StorefrontIcon fontSize="small" /> },
  { id: 'listings', label: 'Store Items', icon: <ViewListIcon fontSize="small" /> },
  { id: 'reviews', label: 'Review Tasks', icon: <AssignmentTurnedInIcon fontSize="small" /> },
  {
    id: 'operations-store-discovery',
    label: 'Operations',
    icon: <BuildIcon fontSize="small" />,
    children: [
      { id: 'operations-store-discovery', label: 'Store Discovery', icon: <TravelExploreIcon fontSize="small" /> },
      { id: 'operations-store-item-discovery', label: 'Store Item Discovery', icon: <Inventory2Icon fontSize="small" /> },
      { id: 'operations-store-item-update', label: 'Store Item Update', icon: <UpdateIcon fontSize="small" /> },
      { id: 'operations-item-embeddings', label: 'Item Embeddings', icon: <AutoAwesomeIcon fontSize="small" /> }
    ]
  },
  { id: 'items', label: 'Items', icon: <CategoryIcon fontSize="small" /> },
  { id: 'front-page-category-options', label: 'Add Front Page Category', icon: <AddCircleIcon fontSize="small" /> },
  { id: 'front-page-categories', label: 'Front Page Categories', icon: <CategoryIcon fontSize="small" /> },
  { id: 'front-page-preview', label: 'Front Page Preview', icon: <ViewCarouselIcon fontSize="small" /> },
  { id: 'offer-reviews', label: 'Store Item Review', icon: <ViewListIcon fontSize="small" /> }
];

function isNavigationItemSelected(item: NavigationItem, activeSection: AdminSection) {
  return item.id === activeSection || Boolean(item.children?.some((child) => child.id === activeSection));
}

type AdminLayoutProps = {
  activeSection: AdminSection;
  children: ReactNode;
  onLogout: () => void;
  onNavigate: (section: AdminSection) => void;
};

export function AdminLayout({ activeSection, children, onLogout, onNavigate }: AdminLayoutProps) {
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
          <Box sx={{ flexGrow: 1 }} />
          <Button color="inherit" size="small" startIcon={<LogoutIcon fontSize="small" />} onClick={onLogout}>
            Sign out
          </Button>
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
            <Box key={item.id}>
              <ListItemButton
                component="a"
                href={`#${item.id}`}
                selected={isNavigationItemSelected(item, activeSection)}
                sx={{ borderRadius: 1, mb: 0.5 }}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(item.id);
                }}
              >
                <ListItemIcon sx={{ minWidth: 36 }}>{item.icon}</ListItemIcon>
                <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 14 }} />
              </ListItemButton>
              {item.children ? (
                <List dense disablePadding sx={{ mb: 0.5 }}>
                  {item.children.map((child) => (
                    <ListItemButton
                      component="a"
                      href={`#${child.id}`}
                      key={child.id}
                      selected={activeSection === child.id}
                      sx={{ borderRadius: 1, mb: 0.5, pl: 3.5 }}
                      onClick={(event) => {
                        event.preventDefault();
                        onNavigate(child.id);
                      }}
                    >
                      <ListItemIcon sx={{ minWidth: 32 }}>{child.icon}</ListItemIcon>
                      <ListItemText primary={child.label} primaryTypographyProps={{ fontSize: 13 }} />
                    </ListItemButton>
                  ))}
                </List>
              ) : null}
            </Box>
          ))}
        </List>
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, p: 3, pt: 9 }}>
        {children}
      </Box>
    </Box>
  );
}
