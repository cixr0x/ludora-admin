# AI Item Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a feature-toggled AI classifier for store item discovery while keeping the existing heuristic classifier available.

**Architecture:** Discovery will choose a classifier at operation startup. `AI_ENABLED_CLASSIFIER=true` uses an OpenAI-compatible classifier and fails the run on AI errors; `false` uses the current heuristic path. The crawler gets a classifier callable so the rest of candidate persistence and matching stays unchanged.

**Tech Stack:** Python standard library HTTP/JSON, existing discovery config helpers, `unittest`.

---

### Task 1: Configuration

**Files:**
- Modify: `src/ludora/config.py`
- Test: `tests/test_config.py`

- [x] Add tests for `AI_ENABLED_CLASSIFIER` defaulting to true, accepting false-like values, and resolving `OPENAI_CLASSIFIER_MODEL` plus `OPENAI_BASE_URL`.
- [x] Implement config helpers with environment-over-dotenv precedence.
- [x] Run `python -m unittest tests.test_config`.

### Task 2: AI Classifier Client

**Files:**
- Create: `src/ludora/ai_item_classification.py`
- Test: `tests/test_ai_item_classification.py`

- [x] Add tests for successful strict JSON parsing, invalid category, invalid confidence, and HTTP failure.
- [x] Implement an OpenAI-compatible `/responses` client that returns `ClassificationResult`.
- [x] Prefix reasons with `AI classifier:`.
- [x] Run `python -m unittest tests.test_ai_item_classification`.

### Task 3: Crawler Injection

**Files:**
- Modify: `src/ludora/product_crawler.py`
- Modify: `src/ludora/inventory.py`
- Test: `tests/test_inventory.py`

- [x] Add a test that a provided classifier is called for fetched product candidates.
- [x] Add a test that classifier exceptions propagate.
- [x] Implement optional classifier callable defaulting to `apply_item_classification`.
- [x] Run `python -m unittest tests.test_inventory`.

### Task 4: Operation Wiring

**Files:**
- Modify: `src/ludora/operations.py`
- Test: `tests/test_operations.py`

- [x] Add tests that item discovery uses AI classifier by default and heuristic when disabled.
- [x] Add a test that missing OpenAI API key fails item discovery when AI is enabled.
- [x] Wire operation startup to construct the AI classifier or heuristic callable.
- [x] Run `python -m unittest tests.test_operations`.

### Task 5: Final Verification

**Files:**
- All changed files

- [x] Run `python -m unittest discover -s tests`.
- [x] Confirm no SQL DDL/DML was run.
- [ ] Restart the discovery service if a running local instance should use the new classifier.
