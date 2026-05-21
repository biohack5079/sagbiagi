# Automated Testing Guide for SAGBI AGI

This document provides detailed instructions for running the automated test suites for the SAGBI AGI project. These tests are crucial for maintaining project quality and ensuring the correct operation of agent gestures (twirl, smile, etc.), RAG logic, and overall application functionality.

---

## 1. Frontend Unit Testing (Vitest)

This suite verifies message parsing, automatic gesture trigger logic based on specific keywords, and basic UI interactions within the React application.

-   **Test File:** `public/html/App.test.tsx`

**How to Run:**

```bash
# Navigate to the frontend directory (if not already there)
cd public/html
# Run tests
npm test
```

---

## 2. Backend Unit Testing (Go)

This suite verifies core backend functionalities such as ID generation, message saving to SQLite, and the RAG (Retrieval-Augmented Generation) search logic.

-   **Test File:** `signaling/main_test.go`

**How to Run:**

```bash
# Navigate to the signaling server directory
cd signaling
# Run Go tests
go test -v .
```

---

## 3. E2E Testing (Playwright)

This suite launches a real browser to verify the integrated flow from user input to AI response and 3D model animations. It ensures that the frontend and backend work together as expected.

-   **Test File:** `e2e/chat.spec.ts`

**How to Run:**

```bash
# Ensure Vite (frontend) and Go server (backend) are running before executing E2E tests.
# For example, in separate terminals:
# 1. npm run dev (in public/html)
# 2. go run main.go (in signaling)

# Install browsers (first time only)
npx playwright install

# Run E2E tests
npx playwright test
```

---

## Continuous Integration (CI)

These tests are also configured to run automatically on every push and pull request to the `main` branch via GitHub Actions. Refer to `.github/workflows/ci.yml` for the CI workflow definition.