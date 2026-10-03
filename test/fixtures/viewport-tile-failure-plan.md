## Deterministic viewport tile failure plan

A full-page screenshot on public property-four failed even with a 90-second bound although font readiness reported loaded. The fallback must not omit tall portions of the page:

1. A wrong tile step or a last tile not aligned to maxScroll can leave a tail gap.
2. A clamp or duplicate scroll position can silently duplicate one viewport and skip a segment.
3. A lazy layout height change after a tile can leave newly revealed content uncovered.
4. One tile screenshot exception must stop the route, preserve prior tile files and DOM/observations, and never claim full route coverage or retry that tile.

For a stable document, plan starts at 0, advances by viewportHeight minus 20% overlap, and aligns the final viewport to documentHeight minus viewportHeight. Record requested and actual scroll, bounds, order, PNG hash for each tile; verify interval union covers [0, documentHeight] without gaps. Keep animations enabled; do not globally freeze them.
