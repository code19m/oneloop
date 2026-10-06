/* Mermaid diagrams for the app, drawn in this separate document. Mermaid
   writes inline styles and HTML strings that the app's own page refuses; the
   app shows the sanitized drawing as an image, so its CSS, links and scripts
   cannot affect the app. */
(() => {
  /** @param {string} id @param {string} source @param {object} config */
  window.renderDiagram = async (id, source, config) => {
    // A copy made here, so Mermaid works with this document's own objects.
    window.mermaid.initialize(JSON.parse(JSON.stringify(config)));
    // Mermaid draws $$…$$ math as HTML in a <foreignObject>, which the
    // sanitizer below removes, so such a label would be empty. A zero-width
    // space between two dollar signs hides the math from Mermaid, and the
    // label shows its text instead.
    const { svg } = await window.mermaid.render(id, source.replace(/\$(?=\$)/g, '$​'));
    const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'a', 'image'], FORBID_ATTR: ['onload', 'onclick'] });
    const bounds = new DOMParser().parseFromString(clean, 'image/svg+xml').documentElement.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number);
    const sized = bounds?.length === 4 && bounds[2] > 0 && bounds[3] > 0;
    return { svg: clean, width: sized ? Math.ceil(bounds[2]) : null, height: sized ? Math.ceil(bounds[3]) : null };
  };
})();
