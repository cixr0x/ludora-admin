# Ludora Admin Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the initial `ludora-admin-service` and `ludora-admin-ui` projects inside `ludora-admin`.

**Architecture:** The admin service is a Node.js TypeScript Express API that owns admin database access through `pg`. The admin UI is a React TypeScript Vite app using MUI and talking only to the service API.

**Tech Stack:** Node.js 24, npm, TypeScript, Express, pg, dotenv, Vitest, Supertest, React, Vite, MUI.

---

## File Structure

- Create `C:\PROJECTS\ludora\ludora-admin\README.md`: admin module overview and run commands.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\package.json`: backend scripts and dependencies.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\tsconfig.json`: backend TypeScript config.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\vitest.config.ts`: backend test config.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\.env.example`: backend environment template.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\config.ts`: backend environment parsing.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\db.ts`: Postgres pool and query helper.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\app.ts`: Express app factory.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\server.ts`: server entry point.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\routes\health.ts`: health route.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\routes\discovery.ts`: discovery and review read routes.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\app.test.ts`: backend route tests.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\package.json`: frontend scripts and dependencies.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\tsconfig.json`: frontend TypeScript config.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\tsconfig.node.json`: Vite TypeScript config.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\vite.config.ts`: Vite config.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\index.html`: app mount page.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\.env.example`: frontend environment template.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\main.tsx`: React entry point.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\App.tsx`: app routes/state.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\api\client.ts`: API client.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\components\AdminLayout.tsx`: MUI shell.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\pages\StoreCandidatesPage.tsx`: store candidate table.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\pages\ListingCandidatesPage.tsx`: listing candidate table.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\pages\ReviewTasksPage.tsx`: review task table.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\pages\PlaceholderPage.tsx`: Items/Offers placeholder pages.
- Create `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\App.test.tsx`: frontend shell test.

---

### Task 1: Backend Package Scaffold

**Files:**
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\package.json`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\tsconfig.json`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\vitest.config.ts`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\.env.example`

- [ ] **Step 1: Create backend package files**

Create `package.json`:

```json
{
  "name": "ludora-admin-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.7",
    "@types/pg": "^8.11.10",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^2.1.8"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node", "vitest"]
  },
  "include": ["src/**/*.ts"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true
  }
});
```

Create `.env.example`:

```text
PORT=4001
LUDORA_DATABASE_URL=postgresql://user:password@localhost:5432/ludora
CORS_ORIGIN=http://localhost:5173
```

- [ ] **Step 2: Install dependencies**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm install
```

Expected: `package-lock.json` is created and npm exits `0`.

- [ ] **Step 3: Run backend build and observe expected failure**

Run:

```powershell
npm run build
```

Expected: FAIL because `src` files do not exist yet.

---

### Task 2: Backend App And Routes

**Files:**
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\config.ts`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\db.ts`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\app.ts`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\server.ts`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\routes\health.ts`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\routes\discovery.ts`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\app.test.ts`

- [ ] **Step 1: Write backend route tests**

Create `src/app.test.ts`:

```ts
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import type { Database } from './db.js';

function createDatabaseMock(rows: unknown[]): Database {
  return {
    query: vi.fn().mockResolvedValue({ rows })
  };
}

describe('admin service routes', () => {
  it('returns health status', async () => {
    const app = createApp({ database: createDatabaseMock([]) });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'ludora-admin-service' });
  });

  it('returns discovery store candidates', async () => {
    const app = createApp({
      database: createDatabaseMock([
        {
          id: '1',
          canonical_domain: 'example.mx',
          website_url: 'https://example.mx/',
          store_name: 'Example',
          accepted: true,
          confidence: '0.91',
          reasons: ['boardgame'],
          source_queries: ['juegos de mesa mexico'],
          last_seen_at: '2026-05-25T00:00:00.000Z'
        }
      ])
    });

    const response = await request(app).get('/discovery/stores');

    expect(response.status).toBe(200);
    expect(response.body.data[0].canonical_domain).toBe('example.mx');
  });

  it('returns JSON error shape when a route query fails', async () => {
    const database: Database = {
      query: vi.fn().mockRejectedValue(new Error('database unavailable'))
    };
    const app = createApp({ database });

    const response = await request(app).get('/discovery/stores');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { message: 'database unavailable' } });
  });
});
```

- [ ] **Step 2: Run backend tests to verify they fail**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm test
```

Expected: FAIL because `src/app.ts` and `src/db.ts` do not exist.

- [ ] **Step 3: Implement backend files**

Create `src/config.ts`:

```ts
import dotenv from 'dotenv';

dotenv.config();

export type ServiceConfig = {
  port: number;
  databaseUrl: string;
  corsOrigin: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    port: Number(env.PORT ?? 4001),
    databaseUrl: env.LUDORA_DATABASE_URL ?? '',
    corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:5173'
  };
}
```

Create `src/db.ts`:

```ts
import pg from 'pg';

export type QueryResult<T = unknown> = {
  rows: T[];
};

export type Database = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
};

export function createDatabase(databaseUrl: string): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return {
    query<T = unknown>(sql: string, params: unknown[] = []) {
      return pool.query<T>(sql, params);
    }
  };
}
```

Create `src/routes/health.ts`:

```ts
import { Router } from 'express';

export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health', (_request, response) => {
    response.json({ status: 'ok', service: 'ludora-admin-service' });
  });

  return router;
}
```

Create `src/routes/discovery.ts`:

```ts
import { Router } from 'express';
import type { Database } from '../db.js';

export function createDiscoveryRouter(database: Database): Router {
  const router = Router();

  router.get('/discovery/stores', async (_request, response, next) => {
    try {
      const result = await database.query(`
        select id, canonical_domain, website_url, store_name, accepted, confidence,
               reasons, source_queries, title, description, last_seen_at
        from discovery_store_candidates
        order by last_seen_at desc
        limit 200
      `);
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/discovery/listings', async (_request, response, next) => {
    try {
      const result = await database.query(`
        select id, store_candidate_domain, source_url, raw_title, raw_price,
               parsed_price_mxn, raw_availability, parsed_availability,
               confidence, evidence, last_seen_at
        from discovery_listing_candidates
        order by last_seen_at desc
        limit 200
      `);
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/review-tasks', async (_request, response, next) => {
    try {
      const result = await database.query(`
        select id, task_type, status, assigned_to, decision, decision_notes,
               created_at, updated_at
        from admin_review_tasks
        order by updated_at desc
        limit 200
      `);
      response.json({ data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
```

Create `src/app.ts`:

```ts
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import type { Database } from './db.js';
import { createDiscoveryRouter } from './routes/discovery.js';
import { createHealthRouter } from './routes/health.js';

type AppDependencies = {
  database: Database;
  corsOrigin?: string;
};

export function createApp({ database, corsOrigin = 'http://localhost:5173' }: AppDependencies) {
  const app = express();

  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());
  app.use(createHealthRouter());
  app.use(createDiscoveryRouter(database));
  app.use(errorHandler);

  return app;
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  response.status(500).json({ error: { message } });
};
```

Create `src/server.ts`:

```ts
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';

const config = loadConfig();

if (!config.databaseUrl) {
  console.error('Missing LUDORA_DATABASE_URL.');
  process.exit(2);
}

const database = createDatabase(config.databaseUrl);
const app = createApp({ database, corsOrigin: config.corsOrigin });

app.listen(config.port, () => {
  console.log(`ludora-admin-service listening on http://localhost:${config.port}`);
});
```

- [ ] **Step 4: Run backend tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 5: Run backend build**

Run:

```powershell
npm run build
```

Expected: PASS and `dist` is created.

---

### Task 3: Frontend Package Scaffold

**Files:**
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\package.json`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\tsconfig.json`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\tsconfig.node.json`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\vite.config.ts`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\index.html`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\.env.example`

- [ ] **Step 1: Create frontend package files**

Create `package.json`:

```json
{
  "name": "ludora-admin-ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "@emotion/react": "^11.14.0",
    "@emotion/styled": "^11.14.0",
    "@mui/icons-material": "^6.4.2",
    "@mui/material": "^6.4.2",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.2.0",
    "@testing-library/user-event": "^14.6.1",
    "@types/react": "^19.0.8",
    "@types/react-dom": "^19.0.3",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "typescript": "^5.7.3",
    "vite": "^6.0.11",
    "vitest": "^2.1.8"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

Create `tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

Create `vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts'
  }
});
```

Create `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Ludora Admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `.env.example`:

```text
VITE_ADMIN_API_URL=http://localhost:4001
```

- [ ] **Step 2: Install frontend dependencies**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui
npm install
```

Expected: `package-lock.json` is created and npm exits `0`.

---

### Task 4: Frontend Admin Shell

**Files:**
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\main.tsx`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\App.tsx`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\api\client.ts`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\components\AdminLayout.tsx`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\pages\StoreCandidatesPage.tsx`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\pages\ListingCandidatesPage.tsx`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\pages\ReviewTasksPage.tsx`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\pages\PlaceholderPage.tsx`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\test\setup.ts`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui\src\App.test.tsx`

- [ ] **Step 1: Write frontend shell test**

Create `src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

Create `src/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('Ludora admin app', () => {
  it('renders the admin shell navigation', () => {
    render(<App />);

    expect(screen.getByText('Ludora Admin')).toBeInTheDocument();
    expect(screen.getByText('Store Candidates')).toBeInTheDocument();
    expect(screen.getByText('Listing Candidates')).toBeInTheDocument();
    expect(screen.getByText('Review Tasks')).toBeInTheDocument();
    expect(screen.getByText('Items')).toBeInTheDocument();
    expect(screen.getByText('Offers')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run frontend test to verify it fails**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui
npm test
```

Expected: FAIL because `src/App.tsx` does not exist.

- [ ] **Step 3: Implement frontend files**

Create `src/api/client.ts`:

```ts
const API_BASE_URL = import.meta.env.VITE_ADMIN_API_URL ?? 'http://localhost:4001';

export type ApiResponse<T> = {
  data: T[];
};

export async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message ?? 'Request failed');
  }
  return body as T;
}
```

Create `src/components/AdminLayout.tsx`:

```tsx
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';
import TaskAltOutlinedIcon from '@mui/icons-material/TaskAltOutlined';
import { AppBar, Box, Button, Drawer, List, ListItemButton, ListItemIcon, ListItemText, Toolbar, Typography } from '@mui/material';
import type { ReactNode } from 'react';

export type AdminSection = 'stores' | 'listings' | 'tasks' | 'items' | 'offers';

type NavItem = {
  id: AdminSection;
  label: string;
  icon: ReactNode;
};

const navItems: NavItem[] = [
  { id: 'stores', label: 'Store Candidates', icon: <StorefrontOutlinedIcon /> },
  { id: 'listings', label: 'Listing Candidates', icon: <ListAltOutlinedIcon /> },
  { id: 'tasks', label: 'Review Tasks', icon: <TaskAltOutlinedIcon /> },
  { id: 'items', label: 'Items', icon: <Inventory2OutlinedIcon /> },
  { id: 'offers', label: 'Offers', icon: <Inventory2OutlinedIcon /> }
];

type AdminLayoutProps = {
  activeSection: AdminSection;
  onSectionChange: (section: AdminSection) => void;
  children: ReactNode;
};

export function AdminLayout({ activeSection, onSectionChange, children }: AdminLayoutProps) {
  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'grey.50' }}>
      <AppBar position="fixed" color="inherit" elevation={1} sx={{ zIndex: theme => theme.zIndex.drawer + 1 }}>
        <Toolbar>
          <Typography variant="h6" component="h1" sx={{ fontWeight: 700 }}>
            Ludora Admin
          </Typography>
        </Toolbar>
      </AppBar>
      <Drawer
        variant="permanent"
        sx={{
          width: 256,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: { width: 256, boxSizing: 'border-box' }
        }}
      >
        <Toolbar />
        <List sx={{ p: 1 }}>
          {navItems.map(item => (
            <ListItemButton
              key={item.id}
              selected={activeSection === item.id}
              onClick={() => onSectionChange(item.id)}
              sx={{ borderRadius: 1 }}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          ))}
        </List>
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, p: 3 }}>
        <Toolbar />
        {children}
      </Box>
    </Box>
  );
}
```

Create `src/pages/StoreCandidatesPage.tsx`:

```tsx
import { Alert, Box, Chip, CircularProgress, Paper, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { fetchJson, type ApiResponse } from '../api/client';

type StoreCandidate = {
  id: string;
  canonical_domain: string;
  website_url: string;
  store_name: string;
  accepted: boolean;
  confidence: string;
  last_seen_at: string;
};

export function StoreCandidatesPage() {
  const [rows, setRows] = useState<StoreCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchJson<ApiResponse<StoreCandidate>>('/discovery/stores')
      .then(result => setRows(result.data))
      .catch((requestError: Error) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <CircularProgress aria-label="Loading store candidates" />;
  if (error) return <Alert severity="error">{error}</Alert>;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 2, fontWeight: 700 }}>Store Candidates</Typography>
      <Paper variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Store</TableCell>
              <TableCell>Domain</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Confidence</TableCell>
              <TableCell>Last Seen</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={5}>No store candidates found.</TableCell></TableRow>
            ) : rows.map(row => (
              <TableRow key={row.id}>
                <TableCell>{row.store_name || row.canonical_domain}</TableCell>
                <TableCell>{row.canonical_domain}</TableCell>
                <TableCell><Chip size="small" label={row.accepted ? 'Accepted' : 'Rejected'} color={row.accepted ? 'success' : 'default'} /></TableCell>
                <TableCell>{row.confidence}</TableCell>
                <TableCell>{row.last_seen_at}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}
```

Create `src/pages/ListingCandidatesPage.tsx`:

```tsx
import { Alert, Box, CircularProgress, Paper, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { fetchJson, type ApiResponse } from '../api/client';

type ListingCandidate = {
  id: string;
  store_candidate_domain: string;
  raw_title: string;
  raw_price: string;
  parsed_availability: string;
  confidence: string;
};

export function ListingCandidatesPage() {
  const [rows, setRows] = useState<ListingCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchJson<ApiResponse<ListingCandidate>>('/discovery/listings')
      .then(result => setRows(result.data))
      .catch((requestError: Error) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <CircularProgress aria-label="Loading listing candidates" />;
  if (error) return <Alert severity="error">{error}</Alert>;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 2, fontWeight: 700 }}>Listing Candidates</Typography>
      <Paper variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Title</TableCell>
              <TableCell>Store</TableCell>
              <TableCell>Price</TableCell>
              <TableCell>Availability</TableCell>
              <TableCell>Confidence</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={5}>No listing candidates found.</TableCell></TableRow>
            ) : rows.map(row => (
              <TableRow key={row.id}>
                <TableCell>{row.raw_title}</TableCell>
                <TableCell>{row.store_candidate_domain}</TableCell>
                <TableCell>{row.raw_price || '-'}</TableCell>
                <TableCell>{row.parsed_availability}</TableCell>
                <TableCell>{row.confidence}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}
```

Create `src/pages/ReviewTasksPage.tsx`:

```tsx
import { Alert, Box, CircularProgress, Paper, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { fetchJson, type ApiResponse } from '../api/client';

type ReviewTask = {
  id: string;
  task_type: string;
  status: string;
  assigned_to: string;
  decision: string;
  updated_at: string;
};

export function ReviewTasksPage() {
  const [rows, setRows] = useState<ReviewTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchJson<ApiResponse<ReviewTask>>('/admin/review-tasks')
      .then(result => setRows(result.data))
      .catch((requestError: Error) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <CircularProgress aria-label="Loading review tasks" />;
  if (error) return <Alert severity="error">{error}</Alert>;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 2, fontWeight: 700 }}>Review Tasks</Typography>
      <Paper variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Type</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Assigned</TableCell>
              <TableCell>Decision</TableCell>
              <TableCell>Updated</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={5}>No review tasks found.</TableCell></TableRow>
            ) : rows.map(row => (
              <TableRow key={row.id}>
                <TableCell>{row.task_type}</TableCell>
                <TableCell>{row.status}</TableCell>
                <TableCell>{row.assigned_to || '-'}</TableCell>
                <TableCell>{row.decision || '-'}</TableCell>
                <TableCell>{row.updated_at}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}
```

Create `src/pages/PlaceholderPage.tsx`:

```tsx
import { Paper, Typography } from '@mui/material';

type PlaceholderPageProps = {
  title: string;
};

export function PlaceholderPage({ title }: PlaceholderPageProps) {
  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Typography variant="h5" sx={{ fontWeight: 700 }}>{title}</Typography>
      <Typography color="text.secondary" sx={{ mt: 1 }}>
        This admin area will be connected in a later workflow.
      </Typography>
    </Paper>
  );
}
```

Create `src/App.tsx`:

```tsx
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { useState } from 'react';
import { AdminLayout, type AdminSection } from './components/AdminLayout';
import { ListingCandidatesPage } from './pages/ListingCandidatesPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { ReviewTasksPage } from './pages/ReviewTasksPage';
import { StoreCandidatesPage } from './pages/StoreCandidatesPage';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#256f68' },
    secondary: { main: '#9a5b24' },
    background: { default: '#f7f8f6' }
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily: ['Inter', 'Roboto', 'Arial', 'sans-serif'].join(',')
  }
});

function renderSection(section: AdminSection) {
  switch (section) {
    case 'stores':
      return <StoreCandidatesPage />;
    case 'listings':
      return <ListingCandidatesPage />;
    case 'tasks':
      return <ReviewTasksPage />;
    case 'items':
      return <PlaceholderPage title="Items" />;
    case 'offers':
      return <PlaceholderPage title="Offers" />;
  }
}

export default function App() {
  const [activeSection, setActiveSection] = useState<AdminSection>('stores');

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AdminLayout activeSection={activeSection} onSectionChange={setActiveSection}>
        {renderSection(activeSection)}
      </AdminLayout>
    </ThemeProvider>
  );
}
```

Create `src/main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 4: Run frontend tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 5: Run frontend build**

Run:

```powershell
npm run build
```

Expected: PASS and `dist` is created.

---

### Task 5: Module README And Verification

**Files:**
- Create: `C:\PROJECTS\ludora\ludora-admin\README.md`

- [ ] **Step 1: Create module README**

Create `README.md`:

```markdown
# Ludora Admin

Admin application for reviewing dirty discovery data and curating Ludora's canonical catalog.

## Projects

- `ludora-admin-service`: Node.js TypeScript Express service for admin APIs and Postgres access.
- `ludora-admin-ui`: React TypeScript Vite app using MUI.

## Service

```powershell
cd .\ludora-admin-service
copy .env.example .env
npm install
npm run dev
```

Set `LUDORA_DATABASE_URL` in `.env` before running database-backed routes.

## UI

```powershell
cd .\ludora-admin-ui
copy .env.example .env
npm install
npm run dev
```

The UI expects the service at `VITE_ADMIN_API_URL`, defaulting to `http://localhost:4001`.

## Verification

```powershell
cd .\ludora-admin-service
npm test
npm run build

cd ..\ludora-admin-ui
npm test
npm run build
```
```

- [ ] **Step 2: Verify backend**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
npm test
npm run build
```

Expected: both commands PASS.

- [ ] **Step 3: Verify frontend**

Run:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-ui
npm test
npm run build
```

Expected: both commands PASS.

- [ ] **Step 4: Run service health smoke check**

Run in one PowerShell session:

```powershell
cd C:\PROJECTS\ludora\ludora-admin\ludora-admin-service
$env:LUDORA_DATABASE_URL='postgresql://placeholder:placeholder@localhost:5432/ludora'
$process = Start-Process -FilePath npm -ArgumentList 'run','dev' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 4
try {
  Invoke-RestMethod http://localhost:4001/health
} finally {
  Stop-Process -Id $process.Id -Force
}
```

Expected: JSON response with `status` set to `ok`.

---

## Completion Criteria

- `ludora-admin/ludora-admin-service` exists as a runnable Node.js TypeScript Express service.
- `ludora-admin/ludora-admin-ui` exists as a runnable React TypeScript Vite MUI app.
- Backend exposes `/health`, `/discovery/stores`, `/discovery/listings`, and `/admin/review-tasks`.
- UI renders the admin shell with Store Candidates, Listing Candidates, Review Tasks, Items, and Offers navigation.
- Backend tests and build pass.
- Frontend tests and build pass.
- Documentation and planning files live under `ludora-admin/docs/superpowers`.
