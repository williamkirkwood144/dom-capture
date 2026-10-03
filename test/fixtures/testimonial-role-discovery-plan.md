# Testimonial role discovery failure plan

The observed logged-out source route /blog/testimonial/jane-doe/ has no semantic main, no h1, no visible author/position, and its quote is a nonempty paragraph under unique #inner_content-2-17. A WXR testimonial_position value exists but does not appear in rendered source. Do not invent or expose it as visible.

Fail-first cases:
1. The unique observed inner-content root is accepted as testimonial_content and semantic_main/page_heading absences are explicit.
2. The single nonempty source paragraph becomes testimonial_quote_01 with a unique selector; the empty paragraph is not a quote.
3. Missing visible author and position are observed absences, even when WXR has an unrendered position value.
4. A visible route CTA and source header/footer sections are observed when present; duplicate roots fail closed.
