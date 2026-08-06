# Deterministic Store Item Schedule Order Design

## Goal

Keep each product in a consistent relative position within its store's daily 20-hour update schedule. This prevents the interval between two refreshes from varying dramatically when a product receives an early random slot one day and a late random slot the next day.

## Design

The daily schedule query will rank eligible products within each store by `store_items.id` instead of PostgreSQL `random()`. For a store with `N` eligible products, each product's update time will continue to use:

```text
window start + 20 hours * (stable rank + store phase) / N
```

The rank is zero-based and deterministic. Because store-item identifiers increase over time, newly discovered products naturally enter after existing products in the store's relative order.

The existing random per-store phase remains unchanged. It shifts the store's evenly spaced grid by less than one product interval, preventing identical boundary alignment between stores without allowing individual products to jump between distant positions in the window.

## Unchanged Behavior

- The automatic scheduler remains eligible once daily after 03:00 America/Mexico_City time.
- Manual redistribution continues to execute the same scheduling query as the automatic scheduler.
- The schedule window remains 20 hours.
- Existing eligibility and locking rules remain unchanged.
- The worker still chooses randomly among the 256 oldest due products.
- The per-host request throttle retains its random jitter.
- Failed-item retry backoff retains its random jitter.
- Platform-level 429 cooldown behavior remains unchanged.

## Data and Deployment Impact

This change modifies application-owned runtime SQL only. It requires no schema patch, migration, or one-time data update. No SQL needs to be executed while implementing or testing the change.

The next automatic or manual redistribution after deployment will assign deterministic product ranks. Existing `next_update_at` values remain untouched until that redistribution runs.

## Verification

Add a focused scheduler regression test that requires the rank expression to order by `store_items.id` and confirms that the per-store phase still uses `random()`. Run the focused admin-service scheduler tests, followed by the complete admin-service test suite and build.
