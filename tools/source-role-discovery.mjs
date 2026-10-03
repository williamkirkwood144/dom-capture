// Discover route roles from the actual rendered, visible DOM. This is source
// observation only: it never mutates the page or reads form values.
export async function discoverSourceRoles(page, { routeId, sourceKind, routePath, expectedForm = false } = {}) {
  return page.evaluate(({ routeId, sourceKind, routePath, expectedForm }) => {
    const visible = (el) => {
      if (!el || !el.getClientRects().length) return false;
      const own = getComputedStyle(el);
      if (own.display === 'none' || own.visibility === 'hidden' || own.visibility === 'collapse') return false;
      for (let a = el; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      }
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    };
    const selectorFor = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        if (n.id) {
          const idSelector = '#' + CSS.escape(n.id);
          if (document.querySelectorAll(idSelector).length === 1) {
            parts.unshift(idSelector);
            break;
          }
        }
        let part = n.localName;
        if (n.parentElement) {
          const same = [...n.parentElement.children].filter(x => x.localName === n.localName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
        }
        parts.unshift(part);
      }
      return parts.join(' > ');
    };
    const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const roles = [];
    const unresolved = [];
    const observedAbsent = [];
    const formObservations = [];
    const add = (section_id, role_id, el, semantic_role) => {
      if (!visible(el)) return null;
      const selector = selectorFor(el);
      if (document.querySelectorAll(selector).length !== 1) {
        unresolved.push({ section_id, role_id, selector, reason: 'selector_not_unique' });
        return null;
      }
      const role = { section_id, role_id, selector, semantic_role, observed_label: label(el), tag: el.localName };
      roles.push(role);
      return role;
    };
    add('document', 'document_body', document.body, 'rendered source document');
    let header = [...document.querySelectorAll('header,[role="banner"]')].find(visible);
    if (!header) header = [...document.querySelectorAll('.header-section')].find(visible);
    if (header) add(header.id || 'source_header', 'header_primary', header, 'site header section');
    const navs = [...document.querySelectorAll('header nav,header [role="navigation"],[role="banner"] nav,[role="banner"] [role="navigation"],.header-section nav,.header-section [role="navigation"]')].filter(visible);
    navs.forEach((el, i) => add(el.closest('header')?.id || 'source_header', i === 0 ? 'primary_navigation' : 'navigation_' + String(i + 1).padStart(2, '0'), el, 'navigation'));
    const mains = [...document.querySelectorAll('main,[role="main"]')].filter(visible);
    const semanticMain = mains[0];
    let main = semanticMain;
    let archiveFallback = false;
    let propertyFallback = false;
    let testimonialFallback = false;
    if (!semanticMain && sourceKind === 'category_archive') {
      // Oxygen category routes may render full article bodies without a
      // semantic <main> or listing-card elements. Accept only one visible,
      // unique wrapper whose observed id/class identifies content.
      const candidates = [...document.querySelectorAll('div[id*="inner_content" i],div[class*="inner-content" i],div[class*="ct-inner-content" i]')]
        .filter(visible).filter(el => el.querySelector('h1,h2,h3,p,li,img,a'));
      const idCandidates = candidates.filter(el => el.id && /inner_content/i.test(el.id));
      const uniqueIdCandidates = idCandidates.filter(el => document.querySelectorAll('#' + CSS.escape(el.id)).length === 1);
      const uniqueClassCandidates = candidates.filter(el => document.querySelectorAll(selectorFor(el)).length === 1);
      let contentRoot = null;
      if (uniqueIdCandidates.length === 1) contentRoot = uniqueIdCandidates[0];
      else if (!idCandidates.length && candidates.length === 1 && uniqueClassCandidates.length === 1) contentRoot = uniqueClassCandidates[0];
      if (contentRoot) {
        main = contentRoot;
        archiveFallback = true;
        add(main.id || 'source_archive_content', 'archive_content', main, 'expanded archive content root; inferred because semantic main is absent');
        observedAbsent.push({ section_id: main.id || 'source_archive_content', role_id: 'semantic_landmark_main', reason: 'visible_main_missing; unique visible source content wrapper retained', native_parity_note: 'Keep the source landmark absence explicit; do not synthesize a source main landmark.' });
      } else if (candidates.length > 1 || idCandidates.length > 1) {
        unresolved.push({ section_id: 'source_document', role_id: 'archive_content', reason: 'ambiguous_archive_content_root' });
      }
    }
    if (!semanticMain && sourceKind === 'testimonial') {
      const candidates = [...document.querySelectorAll('div[id*="inner_content" i]')].filter(visible).filter(el => (el.textContent || '').trim().length > 15);
      const uniqueCandidates = candidates.filter(el => document.querySelectorAll('#' + CSS.escape(el.id)).length === 1);
      if (candidates.length === 1 && uniqueCandidates.length === 1) {
        main = uniqueCandidates[0];
        testimonialFallback = true;
        add(main.id, 'testimonial_content', main, 'observed testimonial source content root; semantic main is absent');
        observedAbsent.push({ section_id: main.id, role_id: 'semantic_main', reason: 'visible_main_missing; unique testimonial content container retained', native_parity_note: 'Keep the source landmark absence explicit.' });
      } else if (candidates.length) {
        unresolved.push({ section_id: 'source_document', role_id: 'testimonial_content', reason: 'ambiguous_testimonial_content_root' });
      }
    }
    if (!semanticMain && sourceKind === 'property') {
      const roots = [...document.querySelectorAll('div.smooth-content')].filter(visible);
      const uniqueRoots = roots.filter(el => el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1);
      if (uniqueRoots.length === 1 && roots.length === 1) {
        main = uniqueRoots[0];
        propertyFallback = true;
        add(main.id, 'property_content', main, 'observed property route content container; semantic main is absent');
        observedAbsent.push({ section_id: main.id, role_id: 'semantic_main', reason: 'visible_main_missing; unique source property content container retained', native_parity_note: 'Keep the source landmark absence explicit; do not synthesize a source main landmark.' });
      } else if (roots.length) {
        unresolved.push({ section_id: 'source_document', role_id: 'property_content', reason: 'ambiguous_property_content_root' });
      }
    }
    if (!semanticMain && !archiveFallback && !propertyFallback && !testimonialFallback) unresolved.push({ section_id: 'source_document', role_id: 'main_content', reason: 'visible_main_missing' });
    if (main) {
      if (semanticMain) add(main.id || 'source_main', 'main_content', main, 'primary content');
      const headings = [...main.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible);
      const h1s = headings.filter(el => el.localName === 'h1');
      if (!h1s.length) {
        if (sourceKind === 'category_archive' && archiveFallback) observedAbsent.push({ section_id: main.id || 'source_archive_content', role_id: 'page_heading', reason: 'visible_h1_missing', native_parity_note: 'Source archive narrative has no h1; preserve observed heading levels.' });
        else if (sourceKind === 'property' && propertyFallback) observedAbsent.push({ section_id: main.id || 'source_property_content', role_id: 'page_heading', reason: 'visible_h1_missing; document title exists outside rendered property heading slots', native_parity_note: 'Keep the visible heading absence explicit.' });
        else if (sourceKind === 'testimonial' && testimonialFallback) observedAbsent.push({ section_id: main.id || 'source_testimonial_content', role_id: 'page_heading', reason: 'visible_h1_missing; title is present only in document metadata', native_parity_note: 'Keep the visible heading absence explicit.' });
        else unresolved.push({ section_id: main.id || 'source_main', role_id: 'page_heading', reason: 'visible_h1_missing' });
      }
      h1s.forEach((el, i) => add(main.id || 'source_main', i === 0 ? 'page_heading_01' : 'page_heading_' + String(i + 1).padStart(2, '0'), el, 'page heading'));
      let headingN = 0;
      headings.filter(el => el.localName !== 'h1').forEach(el => add(el.closest('section,article')?.id || main.id || 'source_main', 'content_heading_' + String(++headingN).padStart(2, '0'), el, 'content heading'));
      const sections = [...main.querySelectorAll('section')].filter(el => visible(el) && (label(el) || el.querySelector('img,a')));
      sections.forEach((el, i) => add(el.id || 'source_section_' + String(i + 1).padStart(2, '0'), 'content_section_' + String(i + 1).padStart(2, '0'), el, 'content section'));
      const articles = [...main.querySelectorAll('article')].filter(visible);
      articles.forEach((el, i) => {
        const n = String(i + 1).padStart(2, '0');
        add(el.id || 'source_article_' + n, sourceKind === 'category_archive' ? 'archive_card_' + n : 'content_article_' + n, el, sourceKind === 'category_archive' ? 'archive card' : 'article body');
        const title = el.querySelector('h1,h2,h3,h4') || el.querySelector('a');
        if (title && visible(title)) add(el.id || 'source_article_' + n, sourceKind === 'category_archive' ? 'archive_card_' + n + '_heading' : 'article_heading_' + n, title, 'article title');
        [...el.querySelectorAll('img')].filter(visible).forEach((img, j) => add(el.id || 'source_article_' + n, 'archive_card_' + n + '_media_' + String(j + 1).padStart(2, '0'), img, 'article media'));
      });
      if (sourceKind === 'category_archive' && !articles.length) observedAbsent.push({ section_id: main.id || 'source_main', role_id: 'archive_cards', reason: archiveFallback ? 'expanded_archive_body_has_no_listing_card_articles' : 'no_visible_article_cards', native_parity_note: 'Source renders expanded archive content rather than listing cards.' });
      const contentImages = [...main.querySelectorAll('img')].filter(visible);
      contentImages.forEach((el, i) => add(el.closest('section,article')?.id || main.id || 'source_main', 'content_media_' + String(i + 1).padStart(2, '0'), el, 'content media'));
      let quotes = [...main.querySelectorAll('blockquote,q,[class*="quote"],[class*="testimonial"]')].filter(visible).filter(el => (el.textContent || '').trim().length > 15);
      if (sourceKind === 'testimonial' && !quotes.length && testimonialFallback) quotes = [...main.querySelectorAll('p')].filter(visible).filter(el => (el.textContent || '').trim().length > 15);
      quotes.forEach((el, i) => add(el.closest('section,article')?.id || main.id || 'source_main', 'testimonial_quote_' + String(i + 1).padStart(2, '0'), el, 'testimonial quote'));
      const authors = [...main.querySelectorAll('cite,[class*="author"],[class*="client-name"],[class*="testimonial-name"]')].filter(visible);
      authors.forEach((el, i) => add(el.closest('section,article')?.id || main.id || 'source_main', 'testimonial_author_' + String(i + 1).padStart(2, '0'), el, 'testimonial attribution'));
      if (sourceKind === 'testimonial' && !quotes.length) unresolved.push({ section_id: main.id || 'source_main', role_id: 'testimonial_quote', reason: 'visible_quote_missing' });
      if (sourceKind === 'testimonial') {
        if (!authors.length) observedAbsent.push({ section_id: main.id || 'source_testimonial_content', role_id: 'testimonial_attribution', reason: 'visible_author_or_client_name_not_observed', native_parity_note: 'Do not infer attribution from route metadata.' });
        const position = [...main.querySelectorAll('[class*="position"],[class*="testimonial-role"]')].filter(visible);
        if (!position.length) observedAbsent.push({ section_id: main.id || 'source_testimonial_content', role_id: 'testimonial_position', reason: 'visible_position_not_observed', native_parity_note: 'WXR position metadata does not establish visible source output.' });
        const highlights = [...main.querySelectorAll('[class*="highlight"]')].filter(visible);
        if (!highlights.length) observedAbsent.push({ section_id: main.id || 'source_testimonial_content', role_id: 'testimonial_highlight', reason: 'highlight role not observed in rendered source', native_parity_note: 'Do not synthesize highlight content.' });
        const ctas = [...document.querySelectorAll('a,button')].filter(visible).filter(el => /contact|enquir|book|call|leave a message/i.test(label(el)));
        ctas.slice(0, 4).forEach((el, i) => add(el.closest('section,article')?.id || 'source_cta', 'primary_cta_' + String(i + 1).padStart(2, '0'), el, 'testimonial contact action'));
      }
      if (sourceKind === 'property') {
        const address = [...main.querySelectorAll('[class*="property-singular-address"]')].find(visible);
        if (address) add(address.closest('section')?.id || main.id, 'property_address', address, 'property address slot');
        const soldDate = [...main.querySelectorAll('[class*="property-singular-sold-date"]')].find(visible);
        if (soldDate) add(soldDate.closest('section')?.id || main.id, 'property_sold_date', soldDate, 'property sold-date slot');
        const description = [...main.querySelectorAll('[class*="property-singular-description"]')].find(visible);
        if (description) add(description.closest('section')?.id || main.id, 'property_description', description, 'property description slot');
        const hero = [...main.querySelectorAll('.property-singular-header-wrapper img')].find(visible);
        if (hero) add(hero.closest('section')?.id || main.id, 'property_hero_media', hero, 'property hero media');
        const facts = [...main.querySelectorAll('dl,[class*="fact"],[class*="spec"],[class*="feature"]')].find(visible);
        if (facts) add(facts.closest('section')?.id || main.id || 'source_main', 'property_facts', facts, 'property facts');
        const gallery = [...main.querySelectorAll('[aria-label*="gallery" i],[class*="gallery"],[class*="slider"],[class*="carousel"]')].find(visible);
        if (gallery) add(gallery.closest('section')?.id || main.id || 'source_main', 'property_gallery', gallery, 'property gallery');
        const ctas = [...main.querySelectorAll('a,button')].filter(visible).filter(el => /contact|enquir|book|call|email|view property/i.test(label(el)) || /^(tel:|mailto:)/i.test(el.getAttribute('href') || ''));
        ctas.slice(0, 4).forEach((el, i) => add(el.closest('section,article')?.id || main.id || 'source_main', 'primary_cta_' + String(i + 1).padStart(2, '0'), el, 'property contact action'));
      }
      const pagination = [...main.querySelectorAll('nav[aria-label*="pag" i],[class*="pagination"],.page-numbers')].filter(visible);
      if (pagination.length) add(main.id || 'source_main', 'pagination', pagination[0].matches('.page-numbers') ? pagination[0].parentElement : pagination[0], 'pagination');
      if (sourceKind === 'category_archive' && !pagination.length) observedAbsent.push({ section_id: main.id || 'source_main', role_id: 'pagination', reason: 'pagination_not_observed', native_parity_note: 'No pagination control is present in the source capture.' });
    }
    let footer = [...document.querySelectorAll('footer,[role="contentinfo"]')].find(visible);
    if (!footer) footer = [...document.querySelectorAll('.footer-section')].find(visible);
    if (footer) add(footer.id || 'source_footer', 'footer', footer, 'site footer section');
    const embeds = [...document.querySelectorAll('iframe')].filter(visible);
    embeds.forEach((el, i) => {
      let origin = '';
      try { origin = new URL(el.src, location.href).origin; } catch {}
      const id = 'public_embed_' + String(i + 1).padStart(2, '0');
      add(el.closest('section,article,main')?.id || 'source_main', id, el, origin === 'https://api.leadconnectorhq.com' ? 'LeadConnector form embed' : 'public iframe embed');
      if (origin === 'https://api.leadconnectorhq.com') formObservations.push({ role_id: id, selector: selectorFor(el), allowedOrigins: ['https://api.leadconnectorhq.com'], waitForSelector: 'form' });
    });
    if (expectedForm && !formObservations.length) unresolved.push({ section_id: 'source_document', role_id: 'leadconnector_form', reason: 'expected_form_embed_missing' });
    return { routeId, sourceKind, routePath, status: unresolved.length ? 'incomplete' : 'observed', roles, observed_absent: observedAbsent, unresolved, formObservations };
  }, { routeId, sourceKind, routePath, expectedForm });
}
