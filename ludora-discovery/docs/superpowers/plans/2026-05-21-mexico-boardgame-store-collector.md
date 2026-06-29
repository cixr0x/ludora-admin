# Mexico Boardgame Store Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python CLI that collects Mexican online boardgame store listings with Brave Search API.

**Architecture:** Use focused modules for query generation, Brave API access, classification, website enrichment, export, and CLI orchestration. Keep the implementation dependency-light with Python standard library APIs.

**Tech Stack:** Python 3.10+, `urllib`, `html.parser`, `csv`, `json`, `unittest`.

---

### Task 1: Query Generation

**Files:**
- Create: `src/ludora/queries.py`
- Test: `tests/test_queries.py`

- [x] Write failing tests for core and expanded Mexico boardgame store queries.
- [x] Implement `build_queries(scope)`.
- [x] Verify tests pass.

### Task 2: Candidate Filtering

**Files:**
- Create: `src/ludora/filtering.py`
- Create: `src/ludora/models.py`
- Test: `tests/test_filtering.py`

- [x] Write failing tests for canonical domains, accepted Mexican online boardgame stores, blocked marketplaces, and blogs without store signals.
- [x] Implement domain normalization, blocked-domain filtering, evidence terms, and confidence scoring.
- [x] Verify tests pass.

### Task 3: Website Enrichment

**Files:**
- Create: `src/ludora/enrichment.py`
- Test: `tests/test_enrichment.py`

- [x] Write failing tests for store name, Instagram URL, Facebook URL, logo URL, and city/state inference.
- [x] Implement HTML metadata parsing and location inference.
- [x] Fix state/city ambiguity for `Nuevo León` versus `León`.
- [x] Verify tests pass.

### Task 4: Brave API, Export, and CLI

**Files:**
- Create: `src/ludora/brave.py`
- Create: `src/ludora/webfetch.py`
- Create: `src/ludora/export.py`
- Create: `src/ludora/collector.py`
- Create: `src/ludora/cli.py`
- Create: `scripts/collect_boardgame_stores_mx.py`
- Test: `tests/test_brave.py`

- [x] Write failing test for Brave result parsing.
- [x] Implement Brave API client and result parser.
- [x] Implement website fetch, CSV/JSON export, collection orchestration, and CLI arguments.
- [x] Verify tests pass.

### Task 5: Documentation

**Files:**
- Create: `README.md`
- Create: `pyproject.toml`
- Create: `.gitignore`

- [x] Document setup, API key usage, output files, query scopes, and tests.
- [x] Verify dry-run query command works.
