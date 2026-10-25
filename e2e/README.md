# Browser tests

End-to-end tests that drive the real app in Chromium with [Playwright](https://playwright.dev):

| File | Covers |
|---|---|
| `auth.spec.ts` | Email sign-up, sign-out and sign-in; wrong password; sign-up on an email that already has an account |
| `chat.spec.ts` | Two teammates in one workspace: presence, shared messages, the agent's reply, hand-offs, the message length limit |
| `approvals.spec.ts` | Approval cards for everyone in the room, Editors unable to approve, cancelling, and a confirm that fails visibly |
| `approval-rules.spec.ts` | An Admin creates a two-approver rule on the Approvals page; Editors can see but not change it; the requester can't approve; two other people approve in turn; the recommended rules in one click, with the small-team warning |
| `workflows.spec.ts` | Creating a workflow through the builder and running it |
| `integrations.spec.ts` | GitHub's per-member repository setup and GitHub events panel on the Integrations page |

## Running them

```sh
npm run test:e2e                         # everything: database, build, tests
E2E_SKIP_BUILD=1 npm run test:e2e        # reuse the last test build while iterating
npm run test:e2e -- e2e/chat.spec.ts     # one file (any Playwright arguments work)
npm run test:e2e -- --headed             # watch the browser
```

The first time on a machine, install Chromium for Playwright with `npx playwright install chromium`.

`scripts/e2e.mjs` does the setup:

- **Database:** uses `DATABASE_URL` when set (CI), otherwise a throwaway local PostgreSQL, the same way `npm run test:full` does.
- **Build:** builds the web app into `apps/web/.next-e2e` pointed at the test servers, so your regular build is untouched.
- **Servers:** Playwright starts three on ports 4911, 4910 and 3910: `e2e/mock-llm.mjs` (an OpenAI-compatible stand-in that replies "Mock agent reply to: ..."), the chat server and the web app. No model key or network access is needed.

Approval cards come from the agent proposing a write to a connected tool, which a test run can't do without real GitHub or Slack accounts. `proposeAction` in `helpers.ts` inserts the same pending action the agent would create, and the test then uses the real card.

CI runs these in the `browser-tests` job and uploads the report and failure screenshots when a test fails.
