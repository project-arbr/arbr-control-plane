# Test Strategy

## Four Layers

| Layer | What goes here | Runner | CI? |
|---|---|---|---|
| **Unit** | Pure functions, no I/O | `node:test` / `pytest` | ✅ Yes |
| **Integration** | Express routes + in-memory MongoDB | `node:test` + `supertest` + `mongodb-memory-server` | ✅ Yes |
| **Client** | SDK methods against a mock HTTP server | `node:test` / `pytest` | ✅ Yes |
| **Smoke** | End-to-end against a live gateway | Manual `node server/scripts/smoke-*.js` | ❌ Manual only |

## Running Tests

```bash
# Server unit tests (fast, no I/O)
npm run test:server:unit

# Server integration tests (in-memory MongoDB, ~4s)
npm run test:server:integration

# Full server suite
npm run test:server

# JS client tests
npm --prefix clients/js test

# Python client tests
cd clients/python && python -m pytest -q
```

> **macOS 13 or older:** `mongodb-memory-server` downloads mongod 8.x by default, which is
> built for macOS 14+ and dies with SIGABRT, failing every integration test at the
> `before` hook. Pin a compatible binary: `MONGOMS_VERSION=7.0.14 npm run test:server`.

## Test Locations

| File | What it tests |
|---|---|
| `server/test/unit/csv.test.js` | `csvCell()` — all quoting/escaping branches |
| `server/test/unit/aiPolicy.test.js` | `goalWeight()` — cost/quality/balanced modes |
| `server/test/unit/capEngine.test.js` | `shouldWarn()` — threshold boundaries |
| `server/test/unit/buildMatch.test.js` | `buildMatch()` — filter-to-MongoDB-match mapping |
| `server/test/integration/requestsExport.test.js` | `GET /api/requests/export` — CSV streaming, filters, headers |
| `server/test/integration/timeseries.test.js` | `GET /api/analytics/timeseries` — bucketing, sorting, filters |
| `clients/js/test/client.test.js` | JS SDK — all client methods including cache token passthrough |
| `clients/python/tests/test_client.py` | Python SDK — all client methods including cache token mapping |

## Rules for Every PR

1. **New API route** → integration test covering: happy path, empty state, at least one filter param.
2. **New pure utility function** → unit tests covering all branches.
3. **New SDK response field** → passthrough test in both JS and Python client suites.
4. **No live provider keys** in any automated test. Tests requiring real providers → smoke scripts only.
5. **Server tests run in CI before Docker build.** A failing test blocks merge.
6. **No new test frameworks.** Server and JS client use `node:test`; Python client uses `pytest`.

## What is NOT Tested Here (Yet)

- **React UI components** — no Vitest setup; validated manually via the dev server.
- **MongoDB aggregation math** — integration tests verify shape and row count; exact numeric precision is out of scope.
- **Auth middleware** — covered indirectly by client tests that send `Authorization` headers.
- **Smoke scripts** — manual pre-release validation only; never run in CI.
