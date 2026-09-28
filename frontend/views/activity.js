/* Shared activity-feed projection. Raw audit events remain append-only. */
(() => {
  const WINDOW_MS = 5 * 60 * 1000;
  const copy = value => JSON.parse(JSON.stringify(value ?? null));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let nextId = 0;
  const chronological = (a, b) => a.ts - b.ts || String(a.id ?? '').localeCompare(String(b.id ?? ''));
  function record(entity, who, text, change, ts = Date.now(), context = {}) {
    if (change && equal(change.before, change.after)) return;
    (entity.activity ||= []).push({id:`activity-${String(++nextId).padStart(12, '0')}`,who,text,ts,...(change ? {change:copy(change)} : {}),...(context.blockId ? {blockId:context.blockId} : {})});
  }
  function visible(events = []) {
    const rows = [], latest = new Map();
    for (const event of [...events].sort(chronological)) {
      const change = event.change;
      // Legacy/unstructured entries and distinct lifecycle events are boundaries.
      if (!change) { rows.push({...event}); latest.clear(); continue; }
      const previous = latest.get(change.field);
      if (previous && previous.who === event.who && event.ts - previous.startedAt <= WINDOW_MS && equal(previous.change.after, change.before)) {
        previous.change.after = copy(change.after);
        previous.text = event.text;
        previous.ts = event.ts;
      } else {
        const row = {...event, change:copy(change), startedAt:event.ts};
        rows.push(row);
        latest.set(change.field, row);
      }
    }
    return rows.filter(row => !row.change || !equal(row.change.before, row.change.after)).sort(chronological);
  }
  window.Activity = {record, visible, chronological, WINDOW_MS};
})();
