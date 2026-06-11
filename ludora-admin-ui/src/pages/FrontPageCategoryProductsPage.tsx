import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { adminApi, type FrontPageCategoryInput, type FrontPageCategoryProduct } from '../api/client';

type LoadState = 'error' | 'loading' | 'ready';
type FrontPageCategoryType = FrontPageCategoryInput['category_type'];

type FrontPageCategoryProductsPageProps = {
  categoryId?: string;
  categoryType?: string;
  name?: string;
  onBack?: () => void;
};

export function FrontPageCategoryProductsPage({
  categoryId,
  categoryType,
  name,
  onBack
}: FrontPageCategoryProductsPageProps) {
  const [loadError, setLoadError] = useState('');
  const [products, setProducts] = useState<FrontPageCategoryProduct[]>([]);
  const [state, setState] = useState<LoadState>('loading');

  const selectedName = (name ?? '').trim();
  const heading = `${selectedName || 'Selected Taxonomy'} Products`;
  const numericCategoryId = Number(categoryId);
  const typedCategoryType = parseCategoryType(categoryType);
  const hasValidSelection = Boolean(typedCategoryType && Number.isInteger(numericCategoryId) && numericCategoryId > 0);

  useEffect(() => {
    let isActive = true;

    async function loadProducts() {
      if (!typedCategoryType || !Number.isInteger(numericCategoryId) || numericCategoryId <= 0) {
        setProducts([]);
        setLoadError('Category selection is missing.');
        setState('error');
        return;
      }

      setState('loading');
      setLoadError('');
      try {
        const rows = await adminApi.getFrontPageCategoryProducts(typedCategoryType, numericCategoryId);
        if (isActive) {
          setProducts(rows);
          setState('ready');
        }
      } catch {
        if (isActive) {
          setProducts([]);
          setLoadError('Products could not be loaded.');
          setState('error');
        }
      }
    }

    void loadProducts();
    return () => {
      isActive = false;
    };
  }, [hasValidSelection, numericCategoryId, typedCategoryType]);

  function handleBack() {
    if (onBack) {
      onBack();
      return;
    }
    window.location.hash = '#front-page-category-options';
  }

  return (
    <Stack spacing={2}>
      <Stack
        alignItems={{ xs: 'stretch', sm: 'center' }}
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        spacing={1.5}
      >
        <Box>
          <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
            {heading}
          </Typography>
          <Typography color="text.secondary" variant="body2">
            {taxonomyLabel(typedCategoryType)} {categoryId ? `#${categoryId}` : ''}
          </Typography>
        </Box>
        <Button
          aria-label="Back to Add Front Page Category"
          startIcon={<ArrowBackIcon />}
          variant="outlined"
          onClick={handleBack}
        >
          Back to Add Front Page Category
        </Button>
      </Stack>

      {state === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading products</Typography>
        </Stack>
      ) : null}

      {state === 'error' ? <Alert severity="error">{loadError}</Alert> : null}

      {state === 'ready' && products.length === 0 ? (
        <Alert severity="info">No products are linked to this row.</Alert>
      ) : null}

      {state === 'ready' && products.length > 0 ? (
        <Box
          aria-label={`${selectedName || 'Taxonomy'} products`}
          role="list"
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))'
          }}
        >
          {products.map((product) => (
            <ProductTile key={String(product.id)} product={product} />
          ))}
        </Box>
      ) : null}
    </Stack>
  );
}

function ProductTile({ product }: { product: FrontPageCategoryProduct }) {
  const label = productLabel(product);
  const imageUrl = productImage(product);

  return (
    <Box
      role="listitem"
      sx={{
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        minWidth: 0,
        overflow: 'hidden'
      }}
    >
      {imageUrl ? (
        <Box
          alt={label}
          component="img"
          src={imageUrl}
          sx={{
            aspectRatio: '1 / 1',
            bgcolor: 'grey.100',
            display: 'block',
            objectFit: 'cover',
            width: '100%'
          }}
        />
      ) : (
        <Box
          sx={{
            alignItems: 'center',
            aspectRatio: '1 / 1',
            bgcolor: 'grey.100',
            color: 'text.secondary',
            display: 'flex',
            justifyContent: 'center',
            px: 1,
            textAlign: 'center'
          }}
        >
          <Typography variant="body2">No image</Typography>
        </Box>
      )}
      <Box sx={{ minHeight: 54, px: 1.25, py: 1 }}>
        <Typography
          variant="body2"
          sx={{
            display: '-webkit-box',
            fontWeight: 700,
            lineHeight: 1.25,
            overflow: 'hidden',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 2
          }}
        >
          {label}
        </Typography>
      </Box>
    </Box>
  );
}

function parseCategoryType(value: string | undefined): FrontPageCategoryType | undefined {
  if (value === 'category' || value === 'family' || value === 'mechanic') {
    return value;
  }
  return undefined;
}

function productLabel(product: FrontPageCategoryProduct) {
  const nameEs = String(product.canonical_name_es ?? '').trim();
  const name = String(product.canonical_name ?? '').trim();
  return nameEs || name || `Item ${product.id}`;
}

function productImage(product: FrontPageCategoryProduct) {
  const imageUrlEs = String(product.image_url_es ?? '').trim();
  const imageUrl = String(product.image_url ?? '').trim();
  return imageUrlEs || imageUrl;
}

function taxonomyLabel(categoryType: FrontPageCategoryType | undefined) {
  if (categoryType === 'category') {
    return 'Category';
  }
  if (categoryType === 'family') {
    return 'Family';
  }
  if (categoryType === 'mechanic') {
    return 'Mechanic';
  }
  return 'Taxonomy';
}
