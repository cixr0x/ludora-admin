import { Alert, Box, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { adminApi, type FrontPageCategoryProduct, type FrontPagePreviewCategory } from '../api/client';

type LoadState = 'error' | 'loading' | 'ready';

export function FrontPagePreviewPage() {
  const [categories, setCategories] = useState<FrontPagePreviewCategory[]>([]);
  const [loadError, setLoadError] = useState('');
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    let isActive = true;

    async function loadPreview() {
      setState('loading');
      setLoadError('');
      try {
        const rows = await adminApi.getFrontPagePreview();
        if (isActive) {
          setCategories(rows);
          setState('ready');
        }
      } catch {
        if (isActive) {
          setCategories([]);
          setLoadError('Front page preview could not be loaded.');
          setState('error');
        }
      }
    }

    void loadPreview();
    return () => {
      isActive = false;
    };
  }, []);

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
          Front Page Preview
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Current homepage category assignments.
        </Typography>
      </Box>

      {state === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading front page preview</Typography>
        </Stack>
      ) : null}

      {state === 'error' ? <Alert severity="error">{loadError}</Alert> : null}

      {state === 'ready' && categories.length === 0 ? (
        <Alert severity="info">No front page categories have been configured.</Alert>
      ) : null}

      {state === 'ready' && categories.length > 0 ? (
        <Stack spacing={3.5}>
          {categories.map((category) => (
            <FrontPagePreviewRow category={category} key={String(category.id)} />
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}

function FrontPagePreviewRow({ category }: { category: FrontPagePreviewCategory }) {
  const title = categoryTitle(category);
  const products = Array.isArray(category.products) ? category.products : [];

  return (
    <Box component="section">
      <Stack alignItems="center" direction="row" spacing={1.25} sx={{ minWidth: 0 }}>
        <Typography
          variant="h6"
          sx={{
            fontSize: '1rem',
            fontWeight: 800,
            minWidth: 0,
            overflowWrap: 'anywhere'
          }}
        >
          {title}
        </Typography>
        <Chip label={`${products.length}`} size="small" variant="outlined" />
      </Stack>
      <Box sx={{ borderTop: 1, borderColor: 'divider', mt: 1.25, pt: 1.5 }}>
        {products.length > 0 ? (
          <Box
            aria-label={`${title} products`}
            role="list"
            sx={{
              display: 'flex',
              gap: 2,
              overflowX: 'auto',
              pb: 1,
              scrollSnapType: 'x proximity'
            }}
          >
            {products.map((product) => (
              <Box
                key={String(product.id)}
                sx={{
                  flex: {
                    sm: '0 0 160px',
                    xs: '0 0 136px'
                  },
                  scrollSnapAlign: 'start'
                }}
              >
                <ProductTile product={product} />
              </Box>
            ))}
          </Box>
        ) : (
          <Typography color="text.secondary" variant="body2">
            No assigned products.
          </Typography>
        )}
      </Box>
    </Box>
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
            overflowWrap: 'anywhere',
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

function categoryTitle(category: FrontPagePreviewCategory) {
  const title = String(category.title ?? '').trim();
  const categoryName = String(category.category_name ?? '').trim();
  const translatedCategoryName = String(category.category_name_es ?? '').trim();
  if (!title) {
    return translatedCategoryName || categoryName || `Front page category ${category.id}`;
  }
  if (translatedCategoryName && categoryName && title === categoryName) {
    return translatedCategoryName;
  }
  return title;
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
