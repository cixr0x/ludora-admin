# Batch Boardgame Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add batch not-boardgame confirmation to the Store Items table while preserving existing batch boardgame confirmation.

**Architecture:** The change stays inside the admin UI page that owns Store Items table behavior. A shared batch handler accepts the desired classification state and delegates to the existing boardgame confirm API or existing generic update API.

**Tech Stack:** React, TypeScript, Material UI, Vitest, React Testing Library.

---

### Task 1: Batch Not-Boardgame UI Test

**Files:**
- Modify: `ludora-admin-ui/src/pages/ListingCandidatesPage.test.tsx`

- [ ] **Step 1: Write the failing test**

Add a test near the existing batch confirmation test:

```tsx
it('batch marks selected store items as not boardgames sequentially', async () => {
  const user = userEvent.setup();
  const originalCandidates = [
    {
      availability: 'available',
      id: '201',
      is_boardgame: false,
      is_boardgame_confirmed: false,
      listing_status: 'PENDING',
      source_url: 'https://store.mx/products/sleeves',
      store_id: 42,
      title: 'Card Sleeves'
    },
    {
      availability: 'available',
      id: '202',
      is_boardgame: false,
      is_boardgame_confirmed: false,
      listing_status: 'PENDING',
      source_url: 'https://store.mx/products/paint',
      store_id: 42,
      title: 'Miniature Paint'
    }
  ];
  let currentCandidates = originalCandidates;
  const patchCalls: Array<{ id: string; body: Record<string, unknown> }> = [];
  let resolveFirstUpdate: (() => void) | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const path = pathOf(url);
    if (path === '/discovery/listings' && !init) {
      return jsonResponse(currentCandidates, 200, { page: 0, page_size: 100, total: currentCandidates.length });
    }
    if (path === '/discovery/listings/201' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      patchCalls.push({ body, id: '201' });
      return new Promise<Response>((resolve) => {
        resolveFirstUpdate = () => {
          const updated = { ...originalCandidates[0], ...body };
          currentCandidates = [updated, currentCandidates[1]];
          resolve(jsonResponse(updated));
        };
      });
    }
    if (path === '/discovery/listings/202' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      patchCalls.push({ body, id: '202' });
      const updated = { ...originalCandidates[1], ...body };
      currentCandidates = [currentCandidates[0], updated];
      return jsonResponse(updated);
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  render(<ListingCandidatesPage />);

  expect(await screen.findByText('Card Sleeves')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Batch confirmation' }));
  await user.click(screen.getByRole('checkbox', { name: 'Select Card Sleeves' }));
  await user.click(screen.getByRole('checkbox', { name: 'Select Miniature Paint' }));
  await user.click(screen.getByRole('button', { name: 'Mark selected not boardgames' }));

  await waitFor(() => expect(patchCalls.map((call) => call.id)).toEqual(['201']));
  expect(screen.getByText('Confirming 1 / 2')).toBeInTheDocument();

  resolveFirstUpdate?.();

  await waitFor(() => expect(patchCalls.map((call) => call.id)).toEqual(['201', '202']));
  expect(patchCalls.map((call) => call.body)).toEqual([
    expect.objectContaining({ is_boardgame: false, is_boardgame_confirmed: true }),
    expect.objectContaining({ is_boardgame: false, is_boardgame_confirmed: true })
  ]);
  expect(await screen.findByText('Confirmed 2 store items as not boardgames.')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Select Card Sleeves' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Select Miniature Paint' })).not.toBeChecked();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ListingCandidatesPage.test.tsx -t "batch marks selected store items as not boardgames sequentially"`

Expected: FAIL because the `Mark selected not boardgames` button does not exist.

### Task 2: Shared Batch Handler and Toolbar Action

**Files:**
- Modify: `ludora-admin-ui/src/pages/ListingCandidatesPage.tsx`

- [ ] **Step 1: Replace boardgame-only batch handler with a state-aware handler**

Change `handleBatchConfirmSelected()` into `handleBatchConfirmSelected(isBoardgame: boolean)` and, inside the loop, use:

```tsx
const savedCandidate = isBoardgame
  ? await adminApi.confirmItemCandidateBoardgame(id)
  : await adminApi.updateItemCandidate(id, {
      ...candidate,
      is_boardgame: false,
      is_boardgame_confirmed: true
    });
```

- [ ] **Step 2: Keep success and failure messaging state-specific**

Use:

```tsx
const classificationLabel = isBoardgame ? 'boardgames' : 'not boardgames';
setSaveMessage(`Confirmed ${successCount} store ${successCount === 1 ? 'item' : 'items'} as ${classificationLabel}.`);
```

Keep the existing failed-item alert text.

- [ ] **Step 3: Add the second toolbar button**

Keep the existing `Confirm selected boardgames` button and add:

```tsx
<Button
  color="error"
  disabled={selectedBatchCandidateIds.size === 0 || isBatchConfirming}
  type="button"
  variant="outlined"
  onClick={() => {
    void handleBatchConfirmSelected(false);
  }}
>
  {isBatchConfirming ? 'Confirming...' : 'Mark selected not boardgames'}
</Button>
```

Update the existing boardgame button to call `handleBatchConfirmSelected(true)`.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- ListingCandidatesPage.test.tsx -t "batch"`

Expected: PASS for both batch tests.

### Task 3: Verification

**Files:**
- Verify: `ludora-admin-ui/src/pages/ListingCandidatesPage.tsx`
- Verify: `ludora-admin-ui/src/pages/ListingCandidatesPage.test.tsx`

- [ ] **Step 1: Run the full page test file**

Run: `npm test -- ListingCandidatesPage.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run the admin UI test suite if targeted tests pass quickly**

Run: `npm test -- --run`

Expected: PASS or report any unrelated existing failures with their test names.
