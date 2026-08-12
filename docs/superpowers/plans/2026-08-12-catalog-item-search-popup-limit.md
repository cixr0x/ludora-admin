# Catalog Item Search Popup Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every catalog-item linking or association popup request up to 50 matching items instead of 20.

**Architecture:** Define one shared `CATALOG_ITEM_SEARCH_LIMIT` UI constant and consume it from both popup implementations. Preserve the existing request shape and popup behavior apart from changing `page_size` to 50.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Vite

## Global Constraints

- Change only the primary-item link/change popup, additional-item popup, and Store Item Review table association popup.
- Leave the main Items table at its existing 100-row page size with infinite scrolling.
- Preserve existing debounce, filtering, exclusions, sorting, scrolling, selection, loading, empty, and error behavior.
- Do not change the admin service, discovery package, public applications, or database.

---

### Task 1: Share and apply the 50-result popup limit

**Files:**
- Create: `ludora-admin-ui/src/components/catalogItemSearch.ts`
- Modify: `ludora-admin-ui/src/pages/ListingCandidatesPage.tsx:38-53,2545-2551`
- Modify: `ludora-admin-ui/src/pages/OfferReviewPage.tsx:28-32,786-792`
- Test: `ludora-admin-ui/src/pages/ListingCandidatesPage.test.tsx:642-740,841-910`
- Test: `ludora-admin-ui/src/pages/OfferReviewPage.test.tsx:85-175`

**Interfaces:**
- Produces: `CATALOG_ITEM_SEARCH_LIMIT: 50`, exported from `src/components/catalogItemSearch.ts`.
- Consumes: `adminApi.getItemsPage(query: TableQuery)` in both popup implementations.

- [ ] **Step 1: Add failing request-limit assertions to every affected popup flow**

In the table-driven primary-item association test in `ListingCandidatesPage.test.tsx`, after the expected replacement result appears, locate the exact `/items` request and assert its page size:

```tsx
const itemSearchRequest = fetchMock.mock.calls
  .map(([input]) => new URL(String(input)))
  .find((url) => url.pathname === '/items');
expect(itemSearchRequest?.searchParams.get('page_size')).toBe('50');
```

Because the table covers both `Change linked item` and `Link item`, this assertion verifies both primary-item popup entry points.

In the additional-item test, add the same literal request assertion after the `Add Additional Item` dialog renders its selectable result:

```tsx
const itemSearchRequest = fetchMock.mock.calls
  .map(([input]) => new URL(String(input)))
  .find((url) => url.pathname === '/items');
expect(itemSearchRequest?.searchParams.get('page_size')).toBe('50');
```

In the Store Item Review association test in `OfferReviewPage.test.tsx`, change the returned catalog fixture from 20 items to 50:

```tsx
const catalogItems = [
  catalogItem,
  ...Array.from({ length: 49 }, (_, index) => ({
    canonical_name: `Aeterna Match ${index + 2}`,
    canonical_name_es: '',
    id: 78 + index,
    image_url: `https://images.example/aeterna-${index + 2}.jpg`,
    image_url_es: ''
  }))
];
```

Return metadata matching that fixture:

```tsx
return new Response(JSON.stringify({ data: catalogItems, meta: { page: 0, page_size: 50, total: 50 } }), {
  headers: { 'Content-Type': 'application/json' },
  status: 200
});
```

Update the two relevant assertions:

```tsx
expect(within(dialog).getAllByRole('button', { name: /^Associate with / })).toHaveLength(50);
expect(String(itemSearchRequest?.[0])).toContain('page_size=50');
```

The production mutation these assertions catch is either popup reverting to its current local 20-result limit.

- [ ] **Step 2: Run the focused tests and verify they fail for the expected page-size mismatch**

Run from `ludora-admin-ui`:

```powershell
npm test -- src/pages/ListingCandidatesPage.test.tsx src/pages/OfferReviewPage.test.tsx -t "changes the existing linked item|links an item when none is assigned|adds and removes additional catalog items|searches and associates an existing item"
```

Expected: the affected iterations fail because the outgoing `/items` URLs contain `page_size=20`, not `page_size=50`.

- [ ] **Step 3: Create and consume the shared limit**

Create `ludora-admin-ui/src/components/catalogItemSearch.ts`:

```ts
export const CATALOG_ITEM_SEARCH_LIMIT = 50;
```

In `ListingCandidatesPage.tsx`, import the constant:

```tsx
import { CATALOG_ITEM_SEARCH_LIMIT } from '../components/catalogItemSearch';
```

Delete the local declaration:

```tsx
const ADDITIONAL_ITEM_SEARCH_LIMIT = 20;
```

Use the shared constant in `CatalogItemSearchDialog`:

```tsx
pageSize: CATALOG_ITEM_SEARCH_LIMIT,
```

In `OfferReviewPage.tsx`, import the same constant:

```tsx
import { CATALOG_ITEM_SEARCH_LIMIT } from '../components/catalogItemSearch';
```

Delete the local declaration:

```tsx
const ITEM_ASSOCIATION_SEARCH_LIMIT = 20;
```

Use the shared constant in `ItemAssociationDialog`:

```tsx
pageSize: CATALOG_ITEM_SEARCH_LIMIT,
```

- [ ] **Step 4: Run the focused tests and verify every popup requests 50 results**

Run:

```powershell
npm test -- src/pages/ListingCandidatesPage.test.tsx src/pages/OfferReviewPage.test.tsx -t "changes the existing linked item|links an item when none is assigned|adds and removes additional catalog items|searches and associates an existing item"
```

Expected: all four affected test cases pass with zero failures.

- [ ] **Step 5: Run complete admin UI verification**

Run:

```powershell
npm test -- --maxWorkers=1
npm run build
```

Expected: all 226 or more Vitest tests pass serially; TypeScript compilation and the Vite production build exit successfully. The existing Vite large-chunk advisory may remain.

- [ ] **Step 6: Review and commit the implementation**

Run from the `ludora-admin` repository root:

```powershell
git diff --check
git diff -- ludora-admin-ui/src/components/catalogItemSearch.ts ludora-admin-ui/src/pages/ListingCandidatesPage.tsx ludora-admin-ui/src/pages/ListingCandidatesPage.test.tsx ludora-admin-ui/src/pages/OfferReviewPage.tsx ludora-admin-ui/src/pages/OfferReviewPage.test.tsx
git add -- ludora-admin-ui/src/components/catalogItemSearch.ts ludora-admin-ui/src/pages/ListingCandidatesPage.tsx ludora-admin-ui/src/pages/ListingCandidatesPage.test.tsx ludora-admin-ui/src/pages/OfferReviewPage.tsx ludora-admin-ui/src/pages/OfferReviewPage.test.tsx
git commit -m "fix: increase catalog item popup results"
```

Confirm the commit contains only the shared constant, the two consumers, and the three popup-flow regression assertions.
