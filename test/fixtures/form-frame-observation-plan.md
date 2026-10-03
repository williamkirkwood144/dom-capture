# Form-frame observation regression plan

Observed live failure: Home/About source captures have a visible LeadConnector iframe. The source capture calls Locator.contentFrame(), which returns a Playwright FrameLocator; the helper then calls url(), which exists on Frame, not FrameLocator. Each affected public capture aborted before its screenshot.

Fail-first cases:
1. Model the Playwright API distinction: Locator.contentFrame() returns a FrameLocator (no url/evaluate/waitForSelector methods); ElementHandle.contentFrame() returns a Frame. Read-only inspection must use the latter and return frame origin/path/control metadata.
2. Keep the helper read-only; do not fill controls, dispatch validation, or submit.
3. Missing or duplicate iframe selectors fail closed before child-frame inspection.

A live local-browser test was attempted but the remote Playwright Chromium binary is not installed. The real public capture already reproduced the issue; use a contract-faithful unit double for the narrow API fix. Do not install/download browsers as a workaround.

4. Incidental visible iframes on a static source capture must not invoke form-field inspection unless the capture explicitly opts in through expectedForm or observeForms.
5. A configured v6 role binding whose selector is absent must leave a role gap, while the capture runner still retains DOM, observations, and the diagnostic PNG and marks the cell failed.
