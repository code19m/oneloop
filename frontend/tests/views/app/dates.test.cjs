// views/app.js: dates, Today and displayed instants follow the instance time zone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('../../support/dom.cjs');

/** Boot the views; `prepare(D, w)` edits the projection before they load. */
const boot = (route = 'board', { prepare } = {}) => bootApp({ route, prepare });

test('Roadmap geometry, skipped calendar dates, server Today and rollover ignore the host time zone', async t => {
  const originalZone = process.env.TZ;
  let reference;
  try {
    // New York is behind UTC and has daylight saving time inside the Roadmap range. Apia is far
    // enough ahead that its date differs at 12:00 UTC, and it skipped 2011-12-30.
    for (const zone of ['America/New_York', 'Pacific/Apia']) {
      process.env.TZ = zone;
      let now = Date.parse('2026-06-15T12:00:00Z'), rollover;
      const { w, d } = bootApp({
        route: 'roadmap', html: '<!doctype html><meta name="theme-color"><div id="app"></div>', media: () => true,
        scripts: ['theme', 'data', 'motion', 'activity', 'collaboration', 'app'],
        setup: w => { w.setInterval = callback => { rollover = callback; return 0; }; w.OneloopRuntime = { now: () => now, invoke: async () => {}, report() {} }; },
        beforeScript: (name, w) => {
          if (name !== 'app') return;
          w.DATA.timeZone = 'UTC'; w.DATA.tasks.find(task => task.id === 'BIR-079').deadline = '2026-06-15';
          w.DATA.epics[0].start = '2026-03-01'; w.DATA.epics[0].end = '2026-11-30'; w.DATA.milestones[0].date = '2026-03-31';
        },
      });
      // Zoom applies once per frame; the pause that ends the gesture applies it at once, so drive it with the mocked clock.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      for (let step = 0; step < 20; step++) d.getElementById('rmScroll').dispatchEvent(new w.WheelEvent('wheel', { ctrlKey: true, deltaY: -10000, clientX: 500, bubbles: true, cancelable: true }));
      t.mock.timers.tick(180);
      t.mock.timers.reset();
      const snapshot = [...d.querySelectorAll('.rm-month,.rm-week,[data-epic],[data-milestone]')].map(el => [el.className, el.getAttribute('style'), el.textContent]);
      if (reference) assert.deepEqual(snapshot, reference, zone + ' has identical high-zoom geometry'); else reference = snapshot;
      const scroll = d.getElementById('rmScroll'), november = (Date.UTC(2026, 10, 1) - Number(scroll.dataset.rangeStart)) / 86400000;
      scroll.scrollLeft = november * 42;
      scroll.dispatchEvent(new w.Event('scroll'));
      await new Promise(resolve => w.requestAnimationFrame(resolve));
      // Cells are day offsets, which CSS multiplies by --ppd. At 42 px a day the axis shows weeks:
      // November's line is on its first day, and the week of Monday, November 2 starts a day later.
      const months = d.querySelector('.rm-month-grid'), ppd = Number(months.style.getPropertyValue('--ppd')), at = el => Number(el.style.getPropertyValue('--d'));
      assert.equal(ppd, 42);
      assert([...d.querySelectorAll('.rm-month-line')].some(el => at(el) === november));
      assert([...months.querySelectorAll('.rm-week')].some(el => el.textContent === 'Nov 2' && at(el) === november + 1));
      w.App.openModal('epic'); assert.equal(d.querySelector('[name="start"]').value, '2026-06-15', 'Today follows server time');
      const input = d.querySelector('.date-text'); input.value = '2011-12-30'; w.App.dateBlur({ target: input }, input.closest('[data-date-key]').dataset.dateKey);
      const trigger = input.parentElement.querySelector('.date-trigger'); w.App.popDate({ currentTarget: trigger, preventDefault() {}, stopPropagation() {} }, input.closest('[data-date-key]').dataset.dateKey);
      const skipped = d.querySelector('[data-d="2011-12-30"]'); assert(skipped); assert.equal(skipped.textContent, '30'); assert.match(skipped.getAttribute('aria-label'), /Dec 30, 2011/);
      skipped.click(); assert.equal(input.value, '2011-12-30');
      w.App.closeOverlays(); w.App.nav('board'); const board = d.querySelector('.board');
      process.env.TZ = zone === 'Pacific/Apia' ? 'UTC' : 'Pacific/Apia'; rollover(); assert.equal(d.querySelector('.board'), board, 'OS zone changes alone do not roll over Today');
      assert(!d.querySelector('[data-task="BIR-079"] .dl').classList.contains('late'));
      now += 86400000; rollover(); assert(d.querySelector('[data-task="BIR-079"] .dl').classList.contains('late'));
      w.App.openModal('epic'); assert.equal(d.querySelector('[name="start"]').value, '2026-06-16');
    }
  } finally {
    if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone;
  }
});

test('the configured UTC zone controls every displayed instant, whatever the host zone', () => {
 const instant=Date.parse('2099-01-02T23:04:05Z'),expected='2099-01-02 23:04:05';
 const t=boot('task/BIR-079',{prepare:D=>{
   const task=D.tasks.find(item=>item.id==='BIR-079');D.timeZone='UTC';task.created=instant;
   task.comments=[{id:'utc-comment',who:'taylorwu',text:'UTC comment',ts:instant,mentions:[]}];
   task.activity=[{id:'utc-activity',who:'taylorwu',text:'UTC activity',ts:instant}];
   task.attachments=[{id:'utc-file',name:'utc.txt',size:1,type:'text/plain',previewKind:'text',url:'data:text/plain;base64,eA==',ephemeral:false,uploadedBy:'taylorwu',uploadedAt:instant,state:'available'}];
   D.storageCleanups=[{at:instant,bytes:1,count:1}];
   D.browserSessions.find(item=>item.id==='web-phone').lastActiveAt=instant;
   Object.assign(D.appGrants[0],{authorizedAt:instant,lastUsedAt:instant,expiresAt:Date.parse('2099-01-03T23:04:05Z')});
 }});
 assert.equal(t.w.OneloopTime.instant(instant),expected);
 assert.equal(t.d.querySelector('.task-created-at').textContent,expected);
 assert.equal(t.d.querySelector('.tl-cmt .act-time').dataset.tip,expected);
 assert.equal(t.d.querySelector('.tl-act .act-time').dataset.tip,expected);
 t.A.previewAttachment('BIR-079','utc-file');assert(t.d.querySelector('.file-info').textContent.includes(expected));
 t.A.nav('storage');assert.equal(t.d.querySelector('.storage-history time').textContent,expected);
 t.A.nav('profile');assert(t.d.querySelector('.profile-access').textContent.includes(expected));
 const board=boot('board',{prepare:D=>{D.timeZone='UTC';const task=D.tasks.find(item=>item.id==='BIR-079');task.block={id:'utc-block',reason:'UTC block',by:'robin',at:instant};}});
 assert(board.d.querySelector('.blocked-badge').dataset.tip.endsWith(expected));
});

test('the instance time zone decides Today across the UTC day boundary', () => {
const t=boot('board',{prepare:(D,w)=>{const Native=w.Date,fixed=Native.parse('2026-09-12T20:30:00Z');w.Date=class extends Native{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};D.session.authenticatedAt=fixed;D.browserSessions[0].createdAt=fixed;D.browserSessions[0].lastActiveAt=fixed;}});t.A.openModal('epic');assert.equal(t.d.querySelector('[name="start"]').value,'2026-09-13');
});

test('compact Board creation dates use the instance time zone', () => {
 const t=boot('board',{prepare:D=>{D.timeZone='America/Los_Angeles';D.tasks.find(task=>task.id==='BIR-079').created=Date.parse('2026-01-01T01:00:00Z');}});
 const created=t.d.querySelector('[data-task="BIR-079"] .card-created');
 assert.equal(created.textContent,'Dec 31');assert.equal(created.dataset.tip,'Created 2025-12-31 17:00:00');
});
