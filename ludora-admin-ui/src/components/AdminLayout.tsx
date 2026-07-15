import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import BuildIcon from '@mui/icons-material/Build';
import CategoryIcon from '@mui/icons-material/Category';
import CloseIcon from '@mui/icons-material/Close';
import ImageSearchIcon from '@mui/icons-material/ImageSearch';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuIcon from '@mui/icons-material/Menu';
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
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Typography,
  useMediaQuery,
  useTheme
} from '@mui/material';
import { type ReactNode, useEffect, useState } from 'react';

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
  | 'operations-image-optimization'
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
      { id: 'operations-item-embeddings', label: 'Item Embeddings', icon: <AutoAwesomeIcon fontSize="small" /> },
      { id: 'operations-image-optimization', label: 'Image Optimization', icon: <ImageSearchIcon fontSize="small" /> }
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
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);

  useEffect(() => {
    setIsMobileDrawerOpen(false);
  }, [activeSection, isMobile]);

  function handleNavigate(section: AdminSection) {
    setIsMobileDrawerOpen(false);
    onNavigate(section);
  }

  return (
    <Box
      sx={{
        bgcolor: 'grey.100',
        display: 'flex',
        minHeight: '100vh',
        '@supports (min-height: 100dvh)': {
          minHeight: '100dvh'
        }
      }}
    >
      <AppBar
        color="inherit"
        elevation={0}
        position="fixed"
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          ml: { md: `${drawerWidth}px`, xs: 0 },
          width: { md: `calc(100% - ${drawerWidth}px)`, xs: '100%' }
        }}
      >
        <Toolbar variant="dense" sx={{ minHeight: 56, px: { sm: 2, xs: 1 } }}>
          {isMobile ? (
            <IconButton
              aria-controls="admin-navigation-drawer"
              aria-expanded={isMobileDrawerOpen}
              aria-label="Open navigation menu"
              color="inherit"
              edge="start"
              sx={{ minHeight: 44, minWidth: 44, mr: 0.5 }}
              onClick={() => setIsMobileDrawerOpen(true)}
            >
              <MenuIcon />
            </IconButton>
          ) : null}
          <Typography
            component="h1"
            noWrap
            variant="h6"
            sx={{ fontSize: { sm: '1rem', xs: '0.95rem' }, fontWeight: 700, minWidth: 0 }}
          >
            Ludora Admin
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Button
            aria-label="Sign out"
            color="inherit"
            size="small"
            sx={{ gap: { sm: 1, xs: 0 }, minHeight: 44, minWidth: { sm: 'auto', xs: 44 }, px: { sm: 1.25, xs: 1 } }}
            onClick={onLogout}
          >
            <LogoutIcon fontSize="small" />
            <Box component="span" sx={{ display: { sm: 'inline', xs: 'none' } }}>
              Sign out
            </Box>
          </Button>
        </Toolbar>
      </AppBar>

      <Drawer
        ModalProps={{ keepMounted: true }}
        open={isMobile ? isMobileDrawerOpen : true}
        slotProps={{ paper: { id: 'admin-navigation-drawer' } }}
        sx={{
          '& .MuiDrawer-paper': {
            borderRightColor: 'divider',
            boxSizing: 'border-box',
            width: drawerWidth
          },
          flexShrink: { md: 0 },
          width: { md: drawerWidth }
        }}
        variant={isMobile ? 'temporary' : 'permanent'}
        onClose={() => setIsMobileDrawerOpen(false)}
      >
        <Toolbar variant="dense" sx={{ alignItems: 'center', minHeight: 56, px: 2 }}>
          <Typography variant="subtitle1" sx={{ flexGrow: 1, fontWeight: 700 }}>
            Admin Console
          </Typography>
          {isMobile ? (
            <IconButton
              aria-label="Close navigation menu"
              edge="end"
              sx={{ minHeight: 44, minWidth: 44 }}
              onClick={() => setIsMobileDrawerOpen(false)}
            >
              <CloseIcon />
            </IconButton>
          ) : null}
        </Toolbar>
        <Divider />
        <List aria-label="Admin navigation" dense component="nav" sx={{ px: 1, py: 1.5 }}>
          {navigationItems.map((item) => (
            <Box key={item.id}>
              <ListItemButton
                component="a"
                href={`#${item.id}`}
                selected={isNavigationItemSelected(item, activeSection)}
                sx={{ borderRadius: 1, mb: 0.5, minHeight: 44 }}
                onClick={(event) => {
                  event.preventDefault();
                  handleNavigate(item.id);
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
                      sx={{ borderRadius: 1, mb: 0.5, minHeight: 44, pl: 3.5 }}
                      onClick={(event) => {
                        event.preventDefault();
                        handleNavigate(child.id);
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

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          p: { md: 3, sm: 2, xs: 1.5 },
          pt: { md: 9, sm: 9, xs: 8.5 },
          width: { md: `calc(100% - ${drawerWidth}px)`, xs: '100%' }
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
