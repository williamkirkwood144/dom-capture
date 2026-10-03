# Source screenshot failure plan

Observed route failures show full-page page.screenshot() can time out while Playwright reports fonts loaded. The current evidence runner has three failure modes to guard:

1. The role-incomplete branch attempts a diagnostic PNG before saving any sanitized DOM snapshot. If that screenshot times out, the actual DOM evidence is lost.
2. The outer capture catch attempts another screenshot after the original screenshot exception, repeating the same expensive full-page capture and potentially timing out again.
3. The route record retains only the generic error and earlier font booleans, not the screenshot attempt count, exact error, or font readiness state at the failure boundary.

The failure-path contract is: write sanitized DOM first; preserve the observations already collected; make at most one PNG attempt for the requested mode; on screenshot exception record the exact exception plus current font status/failed faces and one attempt; do not create or claim a completed PNG. A valid PNG remains separately hash-bound when the attempt succeeds.
