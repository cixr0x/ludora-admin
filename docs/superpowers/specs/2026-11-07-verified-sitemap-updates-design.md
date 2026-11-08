# Verified sitemap checks before item updates

**Approved behavior (2026-11-07):** Apply the precheck to continuous and manual updates for verified stores only. Missing, incomplete, or unverified sitemaps must leave the normal update path intact.

- A successful negative membership check skips the product request and atomically sets `availability='unavailable'`, `availability_source='sitemap_missing'`, and `store_active=false`. Record the reason and any changed fields; continue with the next item.
- An explicit, store-specific configuration represents verified product coverage. A readable sitemap alone is not proof. Cache fresh snapshots per store; failures and partial indexes never provide negative evidence.
- Check before the continuous worker's HTML, Shopify, or WooCommerce transport dispatch and before manual/batch product fetch. A WooCommerce lookahead batch must not request known-missing targets. Persist each item's outcome only when updating that item.
- Keep removed-page/redirect, scheduling eligibility, public filtering, and discovery behavior unchanged outside the new outcome. Hidden records are not automatically restored by this feature.
- Use existing columns and logs. No migration, backfill, production configuration, deployment, or direct SQL execution.

**Approaches:** The approved choice is verified store opt-in plus strict cached snapshots. An alternative requiring prior per-URL sitemap membership would need durable observation history and would miss already-absent URLs on the first run. Reusing the discovery list as authoritative was ruled out because discovery accepts partial results and some real catalogs omit current products.
