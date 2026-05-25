# Ludora Admin Scaffold Design

## Goal

Create `ludora-admin` as a standalone admin application composed of two projects:

- `ludora-admin-service`: backend service for admin data, database access, and process execution.
- `ludora-admin-ui`: frontend application for admin users to visualize, review, and update Ludora data.

The first scaffold should be runnable and structured for future curation workflows, but it should not attempt to implement the full admin product in one step.

## Scope

The initial scaffold includes:

- A Node.js TypeScript backend service.
- A React TypeScript frontend built with Vite.
- MUI as the frontend component system.
- Health and discovery-read API foundations.
- A real admin shell UI with navigation and initial screens.
- Shared environment conventions for API and database URLs.

The initial scaffold does not include:

- Authentication or authorization.
- Full CRUD flows.
- BGG import workflows.
- AI-assisted matching.
- Production deployment configuration.
- Public platform APIs.

## Directory Structure

```text
ludora-admin/
  README.md
  ludora-admin-service/
    package.json
    tsconfig.json
    src/
      config.ts
      db.ts
      server.ts
      routes/
        health.ts
        discovery.ts
  ludora-admin-ui/
    package.json
    tsconfig.json
    index.html
    src/
      main.tsx
      App.tsx
      api/
        client.ts
      components/
        AdminLayout.tsx
      pages/
        StoreCandidatesPage.tsx
        ListingCandidatesPage.tsx
        ReviewTasksPage.tsx
        ItemsPage.tsx
        OffersPage.tsx
```

## Backend Design

Use Node.js with TypeScript and Express for the first backend scaffold. Express is sufficient for the current requirements, keeps the project easy to inspect, and avoids framework overhead while the admin domain is still forming.

The service reads configuration from environment variables:

```text
PORT=4001
LUDORA_DATABASE_URL=postgresql://...
CORS_ORIGIN=http://localhost:5173
```

Initial endpoints:

```text
GET /health
GET /discovery/stores
GET /discovery/listings
GET /admin/review-tasks
```

`GET /health` returns service status and does not require database access.

`GET /discovery/stores` reads from `discovery_store_candidates` and returns dirty store candidates ordered by `last_seen_at desc`.

`GET /discovery/listings` reads from `discovery_listing_candidates` and returns dirty listing candidates ordered by `last_seen_at desc`.

`GET /admin/review-tasks` reads from `admin_review_tasks` and returns review task rows ordered by `updated_at desc`.

The backend should keep database access behind a small module so future routes can share connection pooling and query helpers.

## Frontend Design

Use React, TypeScript, Vite, and MUI.

The first screen should be the usable admin shell, not a landing page. It should include:

- Left navigation.
- Top app bar.
- Main content area.
- Store Candidates page as the default route.
- Loading, empty, and error states for API-backed pages.

Initial navigation:

```text
Store Candidates
Listing Candidates
Review Tasks
Items
Offers
```

Only Store Candidates, Listing Candidates, and Review Tasks need API-backed table views in the initial scaffold. Items and Offers can show empty placeholder panels that make the navigation shape visible without inventing unfinished workflows.

The UI reads the backend base URL from:

```text
VITE_ADMIN_API_URL=http://localhost:4001
```

## Data Flow

```text
ludora-discovery
  -> writes dirty discovery tables in Postgres

ludora-admin-service
  -> reads dirty discovery/admin tables
  -> later writes curated/admin decisions

ludora-admin-ui
  -> calls ludora-admin-service only
```

The UI should not connect directly to Postgres. The service is the boundary for admin data access and future process execution.

## Error Handling

Backend routes should return JSON errors with a stable shape:

```json
{
  "error": {
    "message": "Readable error message"
  }
}
```

Frontend API calls should render a compact MUI error alert when a request fails and an empty state when a request succeeds with no rows.

## Testing

Initial verification should include:

- Backend TypeScript build.
- Backend health route test or smoke check.
- Frontend TypeScript build.
- Frontend production build.
- A local run check that the service starts and the UI can call `/health`.

Unit tests can stay light for the scaffold, but API modules and route handlers should be structured so tests can be added without rewriting the service.
