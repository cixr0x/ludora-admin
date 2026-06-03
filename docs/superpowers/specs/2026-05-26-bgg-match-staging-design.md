# BGG Match Staging Design

## Goal

Add the first admin-side BGG integration slice: generate and store match candidates for a discovery item candidate without automatically creating curated items.

## Scope

This iteration adds:

- `item_match_candidates` shared database table.
- BGG XML API client and parser in `ludora-admin-service`.
- Conservative local/BGG matching service.
- Admin API endpoints to generate and list match candidates.

This iteration does not add the admin UI, accept/reject actions, BGG metadata import into curated `items`, or background job orchestration.

## Data Flow

1. Admin requests match generation for one `store_items.id`.
2. Admin service loads the item candidate.
3. Admin service searches curated local items by exact normalized canonical name or alias.
4. Admin service searches BGG XMLAPI2 by candidate title when a BGG token is configured.
5. Admin service fetches BGG `thing` details for the top search results so alternate names can be evaluated.
6. Matcher scores candidates conservatively. Exact normalized name or alias matches score high; substring-only matches are staged with review reasons, not treated as exact.
7. Existing pending match candidates for the discovery item candidate are replaced with the new generated set.
8. Endpoint returns the stored rows.

## Matching Policy

Auto-import is intentionally out of scope. Scores and reasons are for admin review.

- Exact normalized local item name or alias: strong local match.
- Exact normalized BGG primary or alternate name: strong BGG match.
- Candidate title that contains or is contained by a BGG/local name: review-only lower score.
- Meaningful extra tokens such as `plus`, `junior`, `duel`, `expansion`, `big box`, and player-count expansion hints reduce confidence and add a review reason.

## API

- `POST /admin/discovery/item-candidates/:id/match-candidates`
  Generates local and BGG match candidates and stores them.
- `GET /admin/discovery/item-candidates/:id/match-candidates`
  Lists stored match candidates for the discovery item candidate.

## Configuration

Admin service reads:

- `BGG_API_TOKEN`: optional bearer token for BGG XML API requests.
- `BGG_API_BASE_URL`: optional, defaults to `https://boardgamegeek.com/xmlapi2`.

When no token is configured, the matching service still produces local match candidates and skips BGG.

