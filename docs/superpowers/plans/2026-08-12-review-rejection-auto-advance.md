# Store Item Review Rejection Auto-Advance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a successful rejection from Store Item Review Details open the next pending review, or return to the review list when none remains.

**Architecture:** Keep the behavior in `ListingCandidatesPage`'s shared listing-status handler. Expand the existing review-mode auto-advance branch from approval-only to both terminal review decisions, while reusing `openNextPendingReview` unchanged.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Vite

## Global Constraints

- Preserve the existing approval auto-advance behavior.
- Reuse the existing pending-review query, ordering, exclusion, and clear-selection fallback.
- Keep the change within the Ludora admin UI; do not change APIs, services, discovery code, or the database.
- Show an action-specific next-review loading error after a successful approval or rejection.

---

### Task 1: Auto-advance after either review decision

**Files:**
- Modify: `ludora-admin-ui/src/App.test.tsx:145-245`
- Modify: `ludora-admin-ui/src/pages/ListingCandidatesPage.tsx:890-924`

**Interfaces:**
- Consumes: `openNextPendingReview(currentCandidateId: string): Promise<void>` and the existing `handleSetListingStatus(candidate, listingStatus)` callback.
- Produces: successful `LISTED` and `REJECTED` decisions in review mode both invoke the same next-pending-review navigation.

- [ ] **Step 1: Extend the application regression test with a rejection case**

Convert the existing approval-only test to a table-driven test with literal action and status fixtures. Replace its `it(...)` declaration with:

```tsx
it.each([
  {
    action: 'approval',
    buttonName: 'Approve listing',
    savedListingStatus: 'LISTED'
  },
  {
    action: 'rejection',
    buttonName: 'Reject listing',
    savedListingStatus: 'REJECTED'
  }
])(
  'opens a store item review and advances to the next pending review after $action',
  async ({ buttonName, savedListingStatus }) => {
```

Keep the current complete mock routes and assertions inside that callback. In the existing `PATCH /discovery/listings/920/listing-status` response, replace the fixed status with the table value:

```tsx
return jsonResponse({
  id: '920',
  item_id: 77,
  listing_status: savedListingStatus,
  title: 'Cafe Barista'
});
```

Replace the fixed approval-button click with:

```tsx
fireEvent.click(screen.getByRole('button', { name: buttonName }));
```

Close the table-driven callback with `}` and the `it.each` call with `);` after the existing query assertions:

```tsx
  }
);
```

The production mutation caught by the new row is the current approval-only status guard: with that guard present, the rejection iteration stays at `#offer-reviews?id=920` instead of opening review `921`.

- [ ] **Step 2: Run the focused test and verify the rejection case fails for the expected reason**

Run from `ludora-admin-ui`:

```powershell
npm test -- src/App.test.tsx -t "advances to the next pending review after"
```

Expected: the approval iteration passes and the rejection iteration fails because `window.location.hash` remains `#offer-reviews?id=920` rather than becoming `#offer-reviews?id=921`.

- [ ] **Step 3: Generalize the shared status handler with the minimal production change**

Replace the approval-only branch with a terminal-review-status guard and action-specific error copy:

```tsx
const shouldOpenNextReview =
  detailMode === 'review' &&
  (listingStatus === 'LISTED' || listingStatus === 'REJECTED') &&
  Boolean(onOpenCandidate);

if (shouldOpenNextReview) {
  try {
    await openNextPendingReview(id);
  } catch {
    const completedAction = listingStatus === 'LISTED' ? 'approved' : 'rejected';
    setSaveError(`Store item listing was ${completedAction}, but the next review could not be loaded.`);
  }
}
```

Do not change `openNextPendingReview`: its no-result branch already calls `onClearSelectedCandidateId`, which implements the approved return-to-list behavior for the last pending review.

- [ ] **Step 4: Run the focused test and verify both iterations pass**

Run:

```powershell
npm test -- src/App.test.tsx -t "advances to the next pending review after"
```

Expected: two passing iterations and zero failures.

- [ ] **Step 5: Run full admin UI verification**

Run:

```powershell
npm test
npm run build
```

Expected: the complete Vitest suite passes, TypeScript compilation succeeds, and Vite produces the production build with exit code 0.

- [ ] **Step 6: Review and commit the implementation**

Run from the `ludora-admin` repository root:

```powershell
git diff --check
git diff -- ludora-admin-ui/src/App.test.tsx ludora-admin-ui/src/pages/ListingCandidatesPage.tsx
git add -- ludora-admin-ui/src/App.test.tsx ludora-admin-ui/src/pages/ListingCandidatesPage.tsx
git commit -m "fix: advance review after rejection"
```

Confirm the commit contains only the regression-test change and shared-handler fix.
