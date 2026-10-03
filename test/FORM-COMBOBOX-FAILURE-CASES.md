# Form combobox failure cases and regression contract

Before implementation, these credible failures must be covered:

1. A configured form-open action can run beside arbitrary state actions, so an unrelated click or key could alter the form or submit data before evidence is collected. Configuration must accept only one form-open action and its matching post-capture Escape dismissal.
2. A selector can resolve to multiple frames, a non-LeadConnector origin, or multiple comboboxes. Opening must fail closed unless the frame is unique, its exact origin is `https://api.leadconnectorhq.com`, and it contains one visible combobox.
3. The action trace may serialize dynamic combobox/listbox text or a value. It must retain only structural roles/bounds/ARIA state and visible option labels needed for mapping; no input value is read.
4. A populated child-frame control can be visible in screenshots even though the top-level page has no sensitive fields. Before observations, snapshots, or screenshots are emitted, the allowlisted child frame must be checked for visible populated controls; the check may return only a boolean and must reject without including the value in error/log/artifacts.
5. Privacy rejection or an exception after opening can leave the source dropdown open. On failure, the configured Escape cleanup must run and verify dismissal, without emitting a privacy-bearing diagnostic screenshot.
6. The standard runner’s discovery exports, form-spec resolution, viewport tiling, snapshot/screenshot helper, route-role capture, and existing error-report behavior must remain intact.

The companion `form-combobox-safety.test.mjs` is written against the pinned base before implementation. It covers config pairing, origin/action behavior, structural option evidence, empty authored prompt allowance, privacy rejection across native and ARIA controls, and value-free errors.
