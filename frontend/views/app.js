/* Application view renderer.
   Production starts in frontend/src/app/boot.js: it supplies server DATA and
   installs view-bridge command overrides after this script initializes.
   See frontend/README.md before changing an action. */

(() => {
  const D = window.DATA;
  const collaboration=window.Collab;
  const migrateEvents=window.OneloopMigrateEvents;
  const setHTML=UIHTML;
  const UIMotion=/** @type {Window & {UIMotion:{enter:(el:Element|null)=>void,fade:(el:Element|null)=>void,height:(el:Element|null,before:number)=>void,reduced:()=>boolean,rows:(host:Element,selector:string,key:string)=>Map<string,DOMRect>,reflow:(host:Element,selector:string,key:string,before:Map<string,DOMRect>)=>void,animate:(el:Element,frames:Keyframe[],duration?:number)=>Animation|null}}} */(/** @type {unknown} */(window)).UIMotion;
  /** @type {Window & {ONELOOP_DEFER_BOOT_RENDER?:boolean,OneloopEventAttribute?:(name:string)=>string,OneloopRuntime?:{now?:()=>number,report:(error:unknown)=>void,invoke:(action:string,payload:object)=>Promise<unknown>}}} */
  const bootWindow=window;
  const DAY = 86400000;
  const NO_ASSIGNEE = '__unassigned__';

  const esc = UIEscape;
  const d = (iso) => new Date(iso + 'T00:00:00Z');
  const iso = (dt) => `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  const instanceTimeZone = () => D.timeZone || 'UTC';
  const warnedTimeZones = new Set();
  let formatterZone;
  /** @type {Intl.DateTimeFormat} */ let instantFormatter, shortInstantFormatter;
  function timeFormatters() {
    const zone = instanceTimeZone();
    if (formatterZone !== zone) {
      /** @param {string} timeZone */
      const build = timeZone => [
        new Intl.DateTimeFormat('en-GB', {timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'}),
        new Intl.DateTimeFormat('en-US', {timeZone, month:'short', day:'numeric'}),
      ];
      let formatters;
      try { formatters = build(zone); }
      catch (error) {
        if (!(error instanceof RangeError)) throw error;
        formatters = build('UTC');
        if (!warnedTimeZones.has(zone)) {
          warnedTimeZones.add(zone);
          setTimeout(()=>App.toast('Your browser does not support the instance time zone. Times and Today are shown in UTC. Update your browser to use the configured zone.','info'),0);
        }
      }
      [instantFormatter, shortInstantFormatter] = formatters;
      formatterZone = zone;
    }
  }
  const instantParts = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    timeFormatters();
    return Object.fromEntries(instantFormatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  };
  const formatInstant = (value) => {
    const parts = instantParts(value);
    // The instance time zone applies everywhere, so the label would only add noise.
    return parts ? `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` : 'Unavailable';
  };
  const instanceDateKey = (value=instanceNow()) => formatInstant(value).slice(0, 10);
  const previousDate = value => { const date = d(value); date.setUTCDate(date.getUTCDate() - 1); return iso(date); };
  window.OneloopTime = { instant: formatInstant };
  const calendarFormatter = new Intl.DateTimeFormat('en-US', {timeZone:'UTC',month:'short',day:'numeric'});
  const human = (dt) => calendarFormatter.format(dt);
  /** @param {Date} dt */
  const humanShort = dt => dt.getUTCFullYear() === today.getUTCFullYear() ? human(dt) : humanFull(iso(dt));
  const humanInstant = (value) => {timeFormatters();return shortInstantFormatter.format(new Date(value));};
  const instanceNow = () => bootWindow.OneloopRuntime?.now?.() ?? Date.now();
  const instanceToday = () => d(instanceDateKey(instanceNow()));
  const today = instanceToday();
  const TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  const state = {
    sideOpen: false,
    view: (location.hash.replace('#/', '') || 'roadmap'),
    taskId: null,
    rail: (() => { try { return localStorage.getItem('oneloop.sidebar') === 'rail'; } catch { return false; } })(),
    poolTab: 'mine',
    projectId: 'p1',
    pxPerDay: 8.5,
    rmScrollLeft: null, rmScrollTop: 0,
    boardTracks: [], boardEpics: [], boardAssignees: [], boardQ: '', boardBlocked:false,
    peek: null, modal: null, menu: null,
    boardLimits:{planning:50,progress:50,review:50,done:50}, activityLimits:{}, usersLimit:50,
  };
  const locallyRenderedHashes = [];
  function setLocalHash(hash) {
    if (location.hash === hash) return;
    location.hash = hash;
    locallyRenderedHashes.push(location.href);
  }
  let seq = 100;
  const uid = (p) => p + (++seq);

  D.prefixRegistry ||= Object.fromEntries(D.projects.map(p=>[p.key,p.id]));
  D.taskCounters ||= {};
  D.tasks.forEach(task=>{ task.internalId ||= 'task-'+task.id; const epic=D.epics.find(e=>e.id===task.epicId),track=D.tracks.find(t=>t.id===epic?.trackId);if(track)D.taskCounters[track.projectId]=Math.max(D.taskCounters[track.projectId]||100,Number(task.id.split('-').at(-1))||0); });

  // ---------- project-scoped accessors ----------
  const project = () => D.projects.find((p) => p.id === state.projectId && canReadProject(p.id));
  const tracks = () => D.tracks.filter((t) => t.projectId === state.projectId && canReadProject(t.projectId)).sort((a, b) => a.order - b.order);
  const epics = () => { const tids = new Set(tracks().map((t) => t.id)); return D.epics.filter((e) => tids.has(e.trackId)); };
  const epicById = (id) => D.epics.find((e) => e.id === id);
  const trackById = (id) => D.tracks.find((t) => t.id === id);
  const milestones = () => D.milestones.filter((m) => (m.projectId || 'p1') === state.projectId && canReadProject(m.projectId || 'p1'));
  const tasks = () => { const eids = new Set(epics().map((e) => e.id)); return D.tasks.filter((t) => eids.has(t.epicId)); };
  const taskById = (id) => D.tasks.find((t) => t.id === id || t.internalId === id);
  const poolItems = (scope) => D.pool.filter((p) => p.projectId === state.projectId && canReadProject(p.projectId) && (scope ? p.scope === scope : true) && (p.scope !== 'mine' || p.ownerId === (me() || {}).id));
  const userById = (id) => collaboration?.userById ? collaboration.userById(id) : D.users.find((u) => u.id === id);
  const userHandle = (user) => user?.username || user?.id || '';
  const me = () => (D.session ? userById(D.session.userId) : null);
  const isAdmin = () => !!(me() && me().admin);
  const visibleProjects = () => D.projects.filter(p=>canReadProject(p.id));
  const memberRecord = (userId, projectId) => {
    const p = D.projects.find((x) => x.id === (projectId || state.projectId));
    if (!p) return null;
    const raw = (p.members || []).find((m) => (typeof m === 'string' ? m : m.userId) === userId);
    return typeof raw === 'string' ? { userId: raw, permissions: [] } : raw || null;
  };
  const canReadProject = id => !!(me()?.active && D.projects.some(p=>p.id===id) && (me().admin||memberRecord(me().id,id)));
  const canReadTask = task => {const id=trackById(epicById(task?.epicId)?.trackId)?.projectId;return !!id&&canReadProject(id);};
  const hasPermission = (permission, projectId) => {
    const u = me();
    if (!u || !u.active) return false;
    if (u.admin) return true;
    const membership = memberRecord(u.id, projectId);
    return !!(membership && (membership.permissions || []).includes(permission));
  };
  const canRoadmap = () => hasPermission('manage_roadmap');
  const canBoard = () => hasPermission('manage_board');
  const projectMembers = () => ((project() || {}).members || [])
    .map((m) => userById(typeof m === 'string' ? m : m.userId))
    .filter((u) => u && u.active);
  const activeAdmins = () => D.users.filter((u) => u.admin && u.active);
  const avatarHtml = (uid, size) => {
    const u = userById(uid), sz = size || 18;
    if (u && u.avatar) return `<img class="avatar" src="${UIEscape(u.avatar)}" style="width:${sz}px;height:${sz}px;object-fit:cover" alt="">`;
    const initial=(u?.name||u?.username||uid||'?').trim()[0]||'?';
    return `<span class="avatar" style="width:${sz}px;height:${sz}px;font-size:${Math.round(sz * 0.55)}px">${esc(initial.toUpperCase())}</span>`;
  };
  const genPassword = () => { const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let out = ''; for (let i = 0; i < 12; i++) out += a[Math.floor(Math.random() * a.length)]; return out; };
  const STATUS = { planning: 'Planning', progress: 'In Progress', review: 'In Review', done: 'Done' };
  const ago = (ts) => {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 48 * 60) return Math.round(m / 60) + 'h ago';
    return Math.round(m / 1440) + 'd ago';
  };
  const overdue = (t) => t.deadline && t.state !== 'done' && d(t.deadline) < today;
  const logAct = (obj, text, change, context) => Activity.record(obj, me()?.id || 'system', text, change, undefined, context);
  const actFeed = (list, limit) => Activity.visible(list).slice(-(limit || 8)).reverse().map((a) =>
    `<div class="act-row"><span class="act-dot"></span><span class="act-text"><b>${esc(userById(a.who)?.name||a.actorName||a.who)}</b> ${esc(a.text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,''))}</span><time class="act-time" datetime="${new Date(a.ts).toISOString()}" aria-label="${formatInstant(a.ts)}" title="${formatInstant(a.ts)}">${ago(a.ts)}</time></div>`).join('')
    || '<div class="empty-note" style="border:0;text-align:left;padding:4px 0">nothing yet</div>';

  const counts = () => {
    const aggregate = D.projectTaskCounts?.[state.projectId];
    if (aggregate) return { open:aggregate.open, done:aggregate.done };
    const ts = tasks();
    return {
      open: ts.filter((t) => t.state !== 'done').length,
      done: ts.filter((t) => t.state === 'done').length,
    };
  };

  // ---------- icons ----------
  const I = {
    knowledge: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 3.6C6 2.4 3.6 2.3 1.75 3v10c1.85-.7 4.25-.6 6.25.6 2-1.2 4.4-1.3 6.25-.6V3c-1.85-.7-4.25-.6-6.25.6Z"/><path d="M8 3.6v10"/></svg>',
    note: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 1.5h-7v13h11v-9l-4-4Z M9.5 1.5v4h4M5 8h6M5 11h4"/></svg>',
    blocked: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="m4 4 8 8"/></svg>',

    roadmap: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="2.5" width="7" height="3" rx="1"/><rect x="4.5" y="6.5" width="9" height="3" rx="1"/><rect x="2.5" y="10.5" width="6" height="3" rx="1"/></svg>',
    board: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="2.5" width="3.4" height="11" rx="1"/><rect x="6.3" y="2.5" width="3.4" height="7" rx="1"/><rect x="11.1" y="2.5" width="3.4" height="9" rx="1"/></svg>',
    settings: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4.5h2.2M7.8 4.5H14M2 11.5h6.2M11.8 11.5H14"/><circle cx="6" cy="4.5" r="1.8"/><circle cx="10" cy="11.5" r="1.8"/></svg>',
    plus: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
    chev: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--ink-faint)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>',
    kebab: '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3.5" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="8" cy="12.5" r="1.2"/></svg>',
    grip: '<svg width="12" height="13" viewBox="0 0 16 16" fill="currentColor"><circle cx="5.5" cy="3.5" r="1.2"/><circle cx="10.5" cy="3.5" r="1.2"/><circle cx="5.5" cy="8" r="1.2"/><circle cx="10.5" cy="8" r="1.2"/><circle cx="5.5" cy="12.5" r="1.2"/><circle cx="10.5" cy="12.5" r="1.2"/></svg>',
    check: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--ok)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3L13 4.5"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ink-faint)" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    logo: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 100 100\" aria-hidden=\"true\"><path d=\"M46 18H37C25 18 18 25 18 37V63C18 75 25 82 37 82H63C75 82 82 75 82 63V54\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"12\" stroke-linecap=\"round\"/><rect x=\"66\" y=\"12\" width=\"23\" height=\"23\" rx=\"4\" transform=\"rotate(45 77.5 23.5)\" fill=\"currentColor\"/></svg>",
    wordmark: "<svg class=\"brand-wordmark\" viewBox=\"0 0 7455 1950\" aria-hidden=\"true\"><g transform=\"translate(-80 1470) scale(1 -1)\"><path d=\"M608.667724609375 -30.0Q446.66766357421875 -30.0 328.000732421875 43.0Q209.33380126953125 116.0 144.66690063476562 244.66665649414062Q80.0 373.33331298828125 80.0 540.6666259765625Q80.0 709.9999389648438 146.000244140625 838.3332824707031Q212.00048828125 966.6666259765625 330.8340759277344 1038.3333129882812Q449.66766357421875 1110.0 608.667724609375 1110.0Q771.0010986328125 1110.0 890.0013732910156 1037.1666564941406Q1009.0016479492188 964.3333129882812 1073.8352355957031 835.9999694824219Q1138.6688232421875 707.6666259765625 1138.6688232421875 540.6666259765625Q1138.6688232421875 371.66668701171875 1073.3352355957031 243.16668701171875Q1008.0016479492188 114.66668701171875 888.834716796875 42.333343505859375Q769.6677856445312 -30.0 608.667724609375 -30.0ZM608.667724609375 167.3367919921875Q763.9995727539062 167.3367919921875 840.3321838378906 271.50250244140625Q916.664794921875 375.668212890625 916.664794921875 540.6666259765625Q916.664794921875 710.3317260742188 839.4988403320312 811.4974670410156Q762.3328857421875 912.6632080078125 608.667724609375 912.6632080078125Q503.668701171875 912.6632080078125 435.8360290527344 865.330322265625Q368.00335693359375 817.9974365234375 335.0036926269531 734.33154296875Q302.0040283203125 650.6656494140625 302.0040283203125 540.6666259765625Q302.0040283203125 370.66815185546875 379.83660888671875 269.0024719238281Q457.669189453125 167.3367919921875 608.667724609375 167.3367919921875ZM2081.9986572265625 0.0V530.6654052734375Q2081.9986572265625 593.9971313476562 2071.499053955078 660.49658203125Q2060.9994506835938 726.9960327148438 2031.6666259765625 784.1627502441406Q2002.3338012695312 841.3294677734375 1948.8341674804688 876.3297119140625Q1895.3345336914062 911.3299560546875 1809.33447265625 911.3299560546875Q1753.00244140625 911.3299560546875 1703.1697082519531 892.4971008300781Q1653.3369750976562 873.6642456054688 1615.6704711914062 832.6648254394531Q1578.0039672851562 791.6654052734375 1556.3372497558594 724.9990844726562Q1534.6705322265625 658.332763671875 1534.6705322265625 561.9991455078125L1404.6689453125 610.6673583984375Q1404.6689453125 757.6661987304688 1459.6687622070312 870.1661682128906Q1514.6685791015625 982.6661376953125 1617.8353271484375 1045.9998168945312Q1721.0020751953125 1109.33349609375 1866.6695556640625 1109.33349609375Q1978.6704711914062 1109.33349609375 2054.837371826172 1072.999755859375Q2131.0042724609375 1036.666015625 2178.5040893554688 978.1655578613281Q2226.00390625 919.6651000976562 2251.0035400390625 850.9982604980469Q2276.003173828125 782.3314208984375 2285.0028686523438 716.1651916503906Q2294.0025634765625 649.9989624023438 2294.0025634765625 600.0003662109375V0.0ZM1322.6666259765625 0.0V1080.0H1510.0032958984375V767.9971923828125H1534.6705322265625V0.0ZM2998.334716796875 -30.0Q2836.6677856445312 -30.0 2715.5007934570312 40.666717529296875Q2594.3338012695312 111.33343505859375 2526.6669006347656 237.66671752929688Q2459 364 2459.0 530.6663818359375Q2459.0 707.6663818359375 2525.500213623047 837.6664428710938Q2592.0004272460938 967.66650390625 2710.834014892578 1038.833251953125Q2829.6676025390625 1110.0 2987.667724609375 1110.0Q3152.6680297851562 1110.0 3268.668212890625 1033.3331298828125Q3384.6683959960938 956.666259765625 3442.1683654785156 815.666015625Q3499.6683349609375 674.665771484375 3488.3346557617188 481.332275390625H3278.9976806640625V557.333740234375Q3276.997802734375 744.9990234375 3207.4988403320312 834.831298828125Q3137.9998779296875 924.66357421875 2995.66796875 924.66357421875Q2839.0023803710938 924.66357421875 2760.003204345703 825.8311157226562Q2681.0040283203125 726.9986572265625 2681.0040283203125 540.0Q2681.0040283203125 362.3349609375 2760.003204345703 264.83587646484375Q2839.0023803710938 167.3367919921875 2987.667724609375 167.3367919921875Q3085.6666259765625 167.3367919921875 3157.3323974609375 211.6695556640625Q3228.9981689453125 256.0023193359375 3268.99755859375 339.3345947265625L3473.6683349609375 274.00048828125Q3411.0017700195312 129.3336181640625 3283.0015563964844 49.66680908203125Q3155.0013427734375 -30.0 2998.334716796875 -30.0ZM2613.0030517578125 481.332275390625V644.0013427734375H3383.6663818359375V481.332275390625ZM3697 0V1470H3906.337158203125V0.0ZM4639.667724609375 -30.0Q4477.667663574219 -30.0 4359.000732421875 43.0Q4240.333801269531 116.0 4175.666900634766 244.66665649414062Q4111.0 373.33331298828125 4111.0 540.6666259765625Q4111.0 709.9999389648438 4177.000244140625 838.3332824707031Q4243.00048828125 966.6666259765625 4361.834075927734 1038.3333129882812Q4480.667663574219 1110.0 4639.667724609375 1110.0Q4802.0010986328125 1110.0 4921.001373291016 1037.1666564941406Q5040.001647949219 964.3333129882812 5104.835235595703 835.9999694824219Q5169.6688232421875 707.6666259765625 5169.6688232421875 540.6666259765625Q5169.6688232421875 371.66668701171875 5104.335235595703 243.16668701171875Q5039.001647949219 114.66668701171875 4919.834716796875 42.333343505859375Q4800.667785644531 -30.0 4639.667724609375 -30.0ZM4639.667724609375 167.3367919921875Q4794.999572753906 167.3367919921875 4871.332183837891 271.50250244140625Q4947.664794921875 375.668212890625 4947.664794921875 540.6666259765625Q4947.664794921875 710.3317260742188 4870.498840332031 811.4974670410156Q4793.3328857421875 912.6632080078125 4639.667724609375 912.6632080078125Q4534.668701171875 912.6632080078125 4466.836029052734 865.330322265625Q4399.003356933594 817.9974365234375 4366.003692626953 734.33154296875Q4333.0040283203125 650.6656494140625 4333.0040283203125 540.6666259765625Q4333.0040283203125 370.66815185546875 4410.836608886719 269.0024719238281Q4488.669189453125 167.3367919921875 4639.667724609375 167.3367919921875ZM5823.667724609375 -30.0Q5661.667663574219 -30.0 5543.000732421875 43.0Q5424.333801269531 116.0 5359.666900634766 244.66665649414062Q5295.0 373.33331298828125 5295.0 540.6666259765625Q5295.0 709.9999389648438 5361.000244140625 838.3332824707031Q5427.00048828125 966.6666259765625 5545.834075927734 1038.3333129882812Q5664.667663574219 1110.0 5823.667724609375 1110.0Q5986.0010986328125 1110.0 6105.001373291016 1037.1666564941406Q6224.001647949219 964.3333129882812 6288.835235595703 835.9999694824219Q6353.6688232421875 707.6666259765625 6353.6688232421875 540.6666259765625Q6353.6688232421875 371.66668701171875 6288.335235595703 243.16668701171875Q6223.001647949219 114.66668701171875 6103.834716796875 42.333343505859375Q5984.667785644531 -30.0 5823.667724609375 -30.0ZM5823.667724609375 167.3367919921875Q5978.999572753906 167.3367919921875 6055.332183837891 271.50250244140625Q6131.664794921875 375.668212890625 6131.664794921875 540.6666259765625Q6131.664794921875 710.3317260742188 6054.498840332031 811.4974670410156Q5977.3328857421875 912.6632080078125 5823.667724609375 912.6632080078125Q5718.668701171875 912.6632080078125 5650.836029052734 865.330322265625Q5583.003356933594 817.9974365234375 5550.003692626953 734.33154296875Q5517.0040283203125 650.6656494140625 5517.0040283203125 540.6666259765625Q5517.0040283203125 370.66815185546875 5594.836608886719 269.0024719238281Q5672.669189453125 167.3367919921875 5823.667724609375 167.3367919921875ZM7046.334716796875 -30.0Q6891.3343505859375 -30.0 6786.0008544921875 45.33331298828125Q6680.6673583984375 120.6666259765625 6626.833984375 249.83328247070312Q6573.0006103515625 378.99993896484375 6573.0006103515625 540.6666259765625Q6573.0006103515625 703.333251953125 6626.667297363281 832.1665954589844Q6680.333984375 960.9999389648438 6784.834014892578 1035.4999694824219Q6889.334045410156 1110.0 7042.3341064453125 1110.0Q7194.0009765625 1110.0 7304.501251220703 1035.5000305175781Q7415.001525878906 961.0000610351562 7475.001739501953 832.3334045410156Q7535.001953125 703.666748046875 7535.001953125 540.6666259765625Q7535.001953125 378.6666259765625 7475.335113525391 249.49996948242188Q7415.668273925781 120.33331298828125 7306.168121337891 45.166656494140625Q7196.66796875 -30.0 7046.334716796875 -30.0ZM6537.6666259765625 -480.0V1080.0H6723.669921875V303.3355712890625H6748.337158203125V-480.0ZM7017.00048828125 159.3365478515625Q7117.333068847656 159.3365478515625 7182.832489013672 210.0028076171875Q7248.3319091796875 260.6690673828125 7280.6649169921875 347.1683349609375Q7312.9979248046875 433.6676025390625 7312.9979248046875 540.6666259765625Q7312.9979248046875 646.6656494140625 7280.498199462891 732.8316040039062Q7247.998474121094 818.99755859375 7180.998992919922 869.8305053710938Q7113.99951171875 920.6634521484375 7010.3336181640625 920.6634521484375Q6911.667785644531 920.6634521484375 6848.16845703125 872.6638793945312Q6784.669128417969 824.664306640625 6754.169525146484 738.8316955566406Q6723.669921875 652.9990844726562 6723.669921875 540.6666259765625Q6723.669921875 429.00079345703125 6754.002868652344 342.8348693847656Q6784.3358154296875 256.6689453125 6849.168518066406 208.00274658203125Q6914.001220703125 159.3365478515625 7017.00048828125 159.3365478515625Z\" fill=\"currentColor\"/></g></svg>",
    diamond: '<span class="ms-diamond"></span>',
    storage: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="8" cy="3.5" rx="5.5" ry="2"/><path d="M2.5 3.5v8c0 2.7 11 2.7 11 0v-8M2.5 7.5c0 2.7 11 2.7 11 0"/></svg>',
    users: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.5"/><path d="M1.5 13.5c.5-2.5 2-4 4.5-4s4 1.5 4.5 4M11 2.7a2.5 2.5 0 0 1 0 4.6M12 9.5c1.5.6 2.3 1.9 2.5 4"/></svg>',
    signOut: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 2.5H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3.5M7 8h7M11 5l3 3-3 3"/></svg>',
    sun: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v1M8 14v1M1 8h1M14 8h1M3 3l.7.7M12.3 12.3l.7.7M3 13l.7-.7M12.3 3.7l.7-.7"/></svg>',
    moon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.8 9.5A6 6 0 0 1 6.5 2.2 6 6 0 1 0 13.8 9.5Z"/></svg>',
    person: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="5" r="2.6"/><path d="M2.8 13.6c.9-2.6 2.8-3.9 5.2-3.9s4.3 1.3 5.2 3.9"/></svg>',
    arrow: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
    clock: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.4 1.6"/></svg>',
    menu: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M6 2.5v11"/></svg>',
    st_planning: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--ink-faint)" stroke-width="1.6" stroke-dasharray="2.2 2.2"><circle cx="8" cy="8" r="5.5"/></svg>',
    st_progress: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--run)" stroke-width="1.6"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="var(--run)" stroke="none"/></svg>',
    st_review: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--review)" stroke-width="1.6"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2" fill="var(--review)" stroke="none"/></svg>',
    st_done: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--ok)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M5.3 8.2l1.9 1.8 3.5-3.6"/></svg>',
    cal: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--ink-faint)" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>',
    tick: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3L13 4.5"/></svg>',
  };

  // ---------- form components ----------
  // Shared motion never delays state changes or owns application callbacks.
  const MOTION = { quick: 140, normal: 180, ease: 'cubic-bezier(.2,.8,.2,1)' };
  const uiAnimations = new WeakMap();
  const exitVisuals = new Set();
  const canAnimate = (el) => !!el?.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function uiAnimate(el, frames, duration = MOTION.normal) {
    uiAnimations.get(el)?.cancel();
    if (!canAnimate(el)) return;
    const animation = el.animate(frames, { duration, easing: MOTION.ease });
    uiAnimations.set(el, animation);
    animation.finished.then(() => { if (uiAnimations.get(el) === animation) uiAnimations.delete(el); }, () => {});
    return animation;
  }
  function fadeContent(el) {
    if (el) uiAnimate(el, [{ opacity: .35 }, { opacity: 1 }]);
  }
  function animateHeight(el, before) {
    if (!el) return;
    const after = el.getBoundingClientRect().height;
    if (Math.abs(before - after) > 1) uiAnimate(el, [{ height: before + 'px' }, { height: after + 'px' }]);
  }
  function exitVisual(source) {
    if (!canAnimate(source)) return;
    const rect = source.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight) return;
    // A presentation-only copy cannot intercept input, reuse IDs, or match app selectors.
    const clone = source.cloneNode(true);
    const originals = [source, ...source.querySelectorAll('*')];
    const copies = [clone, ...clone.querySelectorAll('*')];
    const properties = ['display','position','box-sizing','width','height','min-width','min-height','max-width','max-height','padding','margin','border','border-radius','background','box-shadow','backdrop-filter','color','font','line-height','letter-spacing','text-align','white-space','overflow','text-overflow','flex','flex-direction','align-items','justify-content','gap','opacity'];
    copies.forEach((copy, i) => {
      const original = originals[i], style = getComputedStyle(original);
      [...copy.attributes].forEach((attr) => {
        if (attr.name === 'id' || attr.name === 'class' || attr.name === 'name' || attr.name.startsWith('data-') || attr.name.startsWith('on') || attr.name === 'draggable') copy.removeAttribute(attr.name);
      });
      properties.forEach((property) => copy.style.setProperty(property, style.getPropertyValue(property)));
      if ('value' in original) copy.value = original.value;
      copy.scrollTop = original.scrollTop;
    });
    clone.className = 'motion-exit'; clone.inert = true; clone.setAttribute('aria-hidden', 'true');
    Object.assign(clone.style, { position:'fixed', left:rect.left+'px', top:rect.top+'px', width:rect.width+'px', height:rect.height+'px', margin:'0', minWidth:'0', maxWidth:'none', minHeight:'0', maxHeight:'none', pointerEvents:'none', zIndex:'96', animation:'none' });
    if (exitVisuals.size >= 4) { const oldest = exitVisuals.values().next().value; uiAnimations.get(oldest)?.cancel(); oldest.remove(); exitVisuals.delete(oldest); }
    document.body.append(clone); exitVisuals.add(clone);
    const animation = uiAnimate(clone, [{ opacity: getComputedStyle(source).opacity }, { opacity: 0 }], MOTION.quick);
    const cleanup = () => { clone.remove(); exitVisuals.delete(clone); };
    if (animation) animation.finished.then(cleanup, cleanup); else cleanup();
  }
  function overlayKey(selector) {
    if (selector === '.modal') return state.modal ? (state.modal.poolId || state.modal.type === 'pool' ? 'pool' : state.modal.type + ':' + (state.modal.id || 'new')) : '';
    if (selector === '.peek') return state.peek || '';
    if (selector === '.menu') return state.menu ? (state.menu.version ? 'profile' : state.menu.projectMenu ? 'project' : state.menu.items.map(i => i.label || '').join('|')) : '';
    return '';
  }
  const boardScrollMemory=new Map();
  function prepareRenderMotion(overlaysOnly=false) {
    const page = overlaysOnly?null:document.querySelector('.content');
    const previous = new Map();
    if(page?.dataset.pageKey?.includes(':board:'))boardScrollMemory.set(`${D.session?.userId}:${page.dataset.pageKey}`, [...document.querySelectorAll('.board,.col-cards')].map(el=>[el.closest('[data-col]')?.dataset.col,el.scrollLeft,el.scrollTop]));
    const scrim = document.querySelector('#overlay-root > .scrim');
    if (state.modal || state.peek || state.menu) {
      exitVisuals.forEach(el => { uiAnimations.get(el)?.cancel(); el.remove(); }); exitVisuals.clear();
    } else if (scrim) exitVisual(scrim);
    ['.modal','.peek','.menu'].forEach((selector) => {
      const el = document.querySelector('#app ' + selector);
      if (!el) return;
      previous.set(selector, el.dataset.motionKey || '');
      if (!overlayKey(selector)) exitVisual(el);
    });
    return { previous, hadBlock:!!document.querySelector('.task-block'), pageState:page?.querySelector('.page-error,.loading-state')?.className||'ready', hadScrim: !!scrim, pageKey: page?.dataset.pageKey, scrolls: [...(overlaysOnly?[]:document.querySelectorAll('.content,.task-page,.settings,.board,.col-cards'))].map(el => [el.className, el.closest('[data-col]')?.dataset.col, el.scrollLeft, el.scrollTop]) };
  }
  function finishRenderMotion(before,overlaysOnly=false) {
    if (before.hadScrim) document.querySelectorAll('#overlay-root > .scrim').forEach(el => { el.style.animation = 'none'; });
    const page = overlaysOnly?null:document.querySelector('.content');
    const key = `${state.projectId}:${state.view}:${state.view === 'task' ? state.taskId : ''}`;
    if (page) {
      page.dataset.pageKey = key;
      if (before.pageKey && before.pageKey !== key) {
        fadeContent(page);
        if(state.view==='board')for(const [col,left,top] of boardScrollMemory.get(`${D.session?.userId}:${key}`)||[]){const el=document.querySelector(col?`[data-col="${UIEscape(col)}"] .col-cards`:'.board');if(el){el.scrollLeft=left;el.scrollTop=top;}}
      }
      else if (before.pageKey === key) before.scrolls.forEach(([classes, col, left, top]) => {
        const selector = '.' + classes.trim().split(/\s+/).join('.');
        const el = document.querySelector(col ? `[data-col="${UIEscape(col)}"] ${selector}` : selector);
        if (el) { el.scrollLeft = left; el.scrollTop = top; }
      });
    }
    if(!overlaysOnly&&!before.hadBlock)UIMotion.enter(document.querySelector('.task-block'));
    ['.modal','.peek','.menu'].forEach((selector) => {
      const el = document.querySelector('#app ' + selector);
      if (!el) return;
      const key = overlayKey(selector); el.dataset.motionKey = key;
      if (before.previous.get(selector) === key) el.style.animation = 'none';
    });
  }

  // Notifications live outside #app so renders never restart them or clear entered text.
  const toastQueue = [];
  const toastPaused = new Set(document.hidden ? ['hidden'] : []);
  let toastSequence = 0;
  function setToastPause(reason, paused) {
    const wasPaused = toastPaused.size > 0;
    if (paused) toastPaused.add(reason); else toastPaused.delete(reason);
    if (!wasPaused && toastPaused.size) toastQueue.forEach(toast => {
      if (toast.timer != null) { clearTimeout(toast.timer); toast.timer = null; toast.remaining = Math.max(0, toast.remaining - (Date.now() - toast.started)); }
    });
    else if (wasPaused && !toastPaused.size) toastQueue.filter(toast => toast.el).forEach(startToastTimer);
  }
  function startToastTimer(toast) {
    clearTimeout(toast.timer); toast.timer = null;
    if (!toast.el || toastPaused.size) return;
    toast.started = Date.now();
    toast.timer = setTimeout(() => dismissToast(toast.id), toast.remaining);
  }
  function ensureToastRegion() {
    let region = document.getElementById('toast-region');
    if (region) return region;
    region = document.createElement('section'); region.id = 'toast-region'; region.className = 'toast-region';
    region.setAttribute('aria-label', 'Notifications');
    setHTML(region,'<div class="sr-only" data-announce="polite" role="status" aria-live="polite" aria-atomic="true"></div><div class="sr-only" data-announce="assertive" role="alert" aria-atomic="true"></div><div class="toast-stack"></div><div class="toast-queued" hidden></div>');
    region.addEventListener('pointerenter', () => setToastPause('hover', true));
    region.addEventListener('pointerleave', () => setToastPause('hover', false));
    region.addEventListener('focusin', () => setToastPause('focus', true));
    region.addEventListener('focusout', event => { if (!region.contains(event.relatedTarget)) setToastPause('focus', false); });
    document.body.append(region); return region;
  }
  const announcements = { polite: [], assertive: [] };
  function announce(text, kind = 'polite') {
    const node = ensureToastRegion().querySelector(`[data-announce="${UIEscape(kind)}"]`);
    const queue = announcements[kind]; queue.push(text);
    if (queue.length > 1) return;
    const next = () => {
      node.textContent = '';
      requestAnimationFrame(() => {
        node.textContent = queue[0];
        setTimeout(() => { queue.shift(); if (queue.length) next(); }, 150);
      });
    };
    next();
  }
  function toastPositions() {
    return new Map(toastQueue.filter(toast => toast.el).map(toast => [toast.id, { rect: toast.el.getBoundingClientRect(), opacity: getComputedStyle(toast.el).opacity }]));
  }
  function showQueuedToasts(before = toastPositions()) {
    const region = ensureToastRegion(), stack = region.querySelector('.toast-stack');
    let visible = toastQueue.filter(toast => toast.el).length;
    const added = new Set();
    for (const toast of toastQueue) {
      if (toast.el || visible >= 3) continue;
      const el = document.createElement('div'); el.className = 'toast'; el.dataset.toastId = toast.id; el.dataset.kind = toast.kind;
      const icon = document.createElement('span'); icon.className = 'toast-icon'; icon.setAttribute('aria-hidden', 'true');
      const path = toast.kind === 'success' ? '<path d="m6 10 3 3 5-6"/>' : toast.kind === 'error' ? '<path d="m7 7 6 6m0-6-6 6"/>' : '<path d="M10 9v5m0-8v.1"/>';
      setHTML(icon,`<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/>${path}</svg>`);
      const message = document.createElement('div'); message.className = 'toast-message'; message.textContent = toast.text;
      const close = document.createElement('button'); close.type = 'button'; close.className = 'toast-close'; close.setAttribute('aria-label', 'Dismiss notification'); setHTML(close,I.close);
      close.addEventListener('click', () => dismissToast(toast.id));
      el.append(icon, message, close); stack.append(el); toast.el = el; added.add(toast.id); visible++;
      announce(toast.text, toast.kind === 'error' ? 'assertive' : 'polite');
      startToastTimer(toast);
    }
    const waiting = toastQueue.filter(toast => !toast.el).length;
    const count = region.querySelector('.toast-queued'); count.hidden = !waiting; count.textContent = waiting ? `${waiting} queued` : '';
    toastQueue.filter(toast => toast.el).forEach(toast => {
      if (added.has(toast.id)) uiAnimate(toast.el, [{ opacity:0, transform:'translateX(12px)' },{ opacity:1, transform:'none' }]);
      else if (before.has(toast.id)) {
        const from = before.get(toast.id), to = toast.el.getBoundingClientRect();
        if (Math.abs(from.rect.top - to.top) > 1) uiAnimate(toast.el, [{ opacity:from.opacity, transform:`translateY(${from.rect.top - to.top}px)` },{ opacity:1, transform:'none' }]);
      }
    });
  }
  function pushToast(text, kind = 'success') {
    const message = cleanStr(text, 500);
    if (!message) return null;
    if (!['success','error','info'].includes(kind)) kind = 'info';
    const lifetime = Math.max(kind === 'error' ? 8000 : 4000, Math.min(message.length * 40, 12000));
    const existing = toastQueue.find(toast => toast.kind === kind && toast.text === message);
    if (existing) { existing.remaining = lifetime; startToastTimer(existing); return existing.id; }
    const toast = { id: String(++toastSequence), text: message, kind, remaining: lifetime, timer:null, el:null, restoreFocus:document.activeElement };
    toastQueue.push(toast); showQueuedToasts(); return toast.id;
  }
  function dismissToast(id) {
    const index = toastQueue.findIndex(toast => toast.id === String(id));
    if (index < 0) return;
    const before = toastPositions(), [toast] = toastQueue.splice(index, 1);
    clearTimeout(toast.timer);
    const el = toast.el, restoreFocus = el?.contains(document.activeElement);
    if (el) {
      const rect = el.getBoundingClientRect(), opacity = getComputedStyle(el).opacity;
      el.removeAttribute('data-toast-id'); el.classList.add('toast-leaving'); el.inert = true; el.setAttribute('aria-hidden','true');
      Object.assign(el.style, { position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',margin:'0' });
      const animation = uiAnimate(el, [{opacity,transform:'none'},{opacity:0,transform:'translateX(8px)'}], MOTION.quick);
      if (animation) animation.finished.then(() => el.remove(), () => el.remove()); else el.remove();
    }
    showQueuedToasts(before);
    if (restoreFocus) {
      const target = toastQueue.find(item => item.el)?.el.querySelector('.toast-close') || (toast.restoreFocus?.isConnected ? toast.restoreFocus : document.querySelector('.menu-btn'));
      target?.focus({preventScroll:true});
    }
    if (!toastQueue.length) { setToastPause('hover', false); setToastPause('focus', false); }
  }
  function clearToasts() {
    toastQueue.forEach(toast => { clearTimeout(toast.timer); uiAnimations.get(toast.el)?.cancel(); });
    toastQueue.length = 0; document.getElementById('toast-region')?.remove();
    toastPaused.clear(); if (document.hidden) toastPaused.add('hidden');
  }
  document.addEventListener('visibilitychange', () => setToastPause('hidden', document.hidden));

  let pendingConfirmation = null;
  function askConfirmation({ title, text, action, match, confirm, cancel }) {
    if (pendingConfirmation) return false;
    closePop(true);
    const returnFocus = document.activeElement;
    state.menu = null;
    document.querySelectorAll('#overlay-root > .menu, #overlay-root > .menu-scrim').forEach(el => el.remove());
    const layer = document.createElement('div'); layer.className = 'confirmation-layer';
    setHTML(layer,`<div class="scrim"></div><div class="confirmation-wrap"><form class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-description" novalidate>
      <h2 id="confirmation-title">${esc(title)}</h2><p id="confirmation-description">${esc(text)}</p>
      ${match !== undefined ? `<label class="confirmation-match-label" for="confirmation-match">Type <strong>${esc(match)}</strong> to confirm</label><input id="confirmation-match" class="ctl" autocomplete="off" spellcheck="false" required>` : ''}
      <div class="modal-actions"><button type="button" class="btn quiet" data-confirm-cancel>Cancel</button><button type="submit" class="btn danger" data-confirm-accept ${match !== undefined ? 'disabled' : ''}>${esc(action)}</button></div>
      </form></div>`);
    const inerted = [...document.querySelectorAll('#app, #toast-region .toast-stack')].map(el => [el, el.inert]);
    inerted.forEach(([el]) => { el.inert = true; });
    const record = { layer, returnFocus, inerted, cancel, session:D.session?.id, hash:location.hash, close:null }; pendingConfirmation = record;
    const close = (accepted, restoreFocus = true) => {
      if (pendingConfirmation !== record) return;
      pendingConfirmation = null;
      document.removeEventListener('keydown', onKey, true);
      exitVisual(layer.querySelector('.scrim'));exitVisual(layer.querySelector('.confirm-dialog')); layer.remove();
      inerted.forEach(([el, wasInert]) => { el.inert = wasInert; });
      if (!accepted) cancel?.();
      if (restoreFocus) {
        const focus = returnFocus?.isConnected && !returnFocus.closest('[inert]') ? returnFocus :
          [...document.querySelectorAll('.modal button,.peek button,.me-chip,.menu-btn')].find(el => !el.closest('[inert]') && !el.disabled);
        focus?.focus({preventScroll:true});
      }
    };
    record.close = close;
    const form = layer.querySelector('form'), input = layer.querySelector('input'), accept = layer.querySelector('[data-confirm-accept]');
    input?.addEventListener('input', () => { accept.disabled = input.value !== match; });
    layer.querySelector('[data-confirm-cancel]').addEventListener('click', () => close(false));
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (pendingConfirmation !== record || (match !== undefined && input.value !== match)) return;
      if(window.Recovery && !Recovery.ensureOnline())return;
      accept.disabled = true; close(true); confirm();
    });
    function onKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(false); }
      else if (event.key === 'Tab') {
        const controls = [...form.querySelectorAll('input,button')].filter(el => !el.disabled);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.append(layer);
    (input || layer.querySelector('[data-confirm-cancel]')).focus();
    return true;
  }

  // Popovers are imperative on purpose: opening one never re-renders the app,
  // so text already typed into a form is never lost.
  const SELS = {}, DPS = {};
  const POP = { el: null, id: null, onKey: null, anchor: /** @type {HTMLElement|null} */ (null), dateTrigger: /** @type {Element|null} */ (null), onClose: /** @type {(()=>void)|null} */ (null), trigger: /** @type {HTMLElement|null} */ (null) };
  const humanFull = (ds) => d(ds).toLocaleDateString('en-US', { timeZone:'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  const cleanStr = (v, max) => String(v ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max || 500);

  function closePop(silent) {
    if (!POP.el) return;
    if (!silent) exitVisual(POP.el);
    POP.el.remove(); POP.el = null; POP.id = null; POP.anchor = null;
    if (POP.onKey) { document.removeEventListener('keydown', POP.onKey, true); POP.onKey = null; }
    const cb = POP.onClose; POP.onClose = null;
    POP.dateTrigger?.setAttribute('aria-expanded', 'false'); POP.dateTrigger = null;
    POP.trigger?.setAttribute('aria-expanded','false');POP.trigger?.removeAttribute('aria-controls');POP.trigger=null;
    if (cb && !silent) cb();
  }
  function openPop(anchor, width) {
    closePop();
    const el = document.createElement('div');
    el.className = 'pop';
    if (width) el.style.width = width + 'px'; else el.style.minWidth = anchor.getBoundingClientRect().width + 'px';
    document.body.appendChild(el);
    POP.el = el; POP.anchor = anchor;
    return el;
  }
  function placePop(anchor) {
    const el = POP.el;
    if (!el || !anchor.isConnected) return;
    const r = anchor.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    el.style.minWidth = Math.min(parseFloat(el.style.minWidth) || 0, W - 16) + 'px';
    el.style.maxHeight = Math.min(340, H - 16) + 'px';
    const flip = r.bottom + el.offsetHeight + 8 > H;
    el.style.left = Math.max(Math.min(r.left, W - el.offsetWidth - 8), 8) + 'px';
    el.style.top = Math.max(Math.min(flip ? r.top - el.offsetHeight - 6 : r.bottom + 6, H - el.offsetHeight - 8), 8) + 'px';
  }
  function placeMenu() {
    const el = document.querySelector('.menu');
    if (!el || !state.menu) return;
    if (state.menu.version || state.menu.projectMenu) {
      const anchor = document.querySelector(state.menu.projectMenu ? '.switcher-btn' : '.me-chip').getBoundingClientRect();
      el.style.width = Math.min(anchor.width < 100 ? 208 : anchor.width, innerWidth - 16) + 'px';
      state.menu.x = anchor.left; state.menu.y = state.menu.projectMenu ? anchor.bottom + 6 : anchor.top;
    }
    if(state.menu.commentId||state.menu.taskActions){
      const anchor=state.menu.taskActions?document.querySelector('.task-actions-button'):[...document.querySelectorAll('[data-comment]')].find(row=>row.dataset.comment===state.menu.commentId)?.querySelector('.comment-menu-button');
      if(anchor){const r=anchor.getBoundingClientRect();state.menu.x=r.right-el.offsetWidth;state.menu.y=r.bottom+4;if(state.menu.y+el.offsetHeight>innerHeight-8)state.menu.y=r.top-el.offsetHeight-4;}
    }
    el.style.left = Math.max(8, Math.min(state.menu.x, innerWidth - el.offsetWidth - 8)) + 'px';
    const top = state.menu.above ? state.menu.y - el.offsetHeight - 6 : state.menu.y;
    el.style.top = Math.max(8, Math.min(top, innerHeight - el.offsetHeight - 8)) + 'px';
  }
  function setFieldError(control, wrap, message, className = 'ferr') {
    if (!control || !wrap) return;
    if (!control.id) control.id = 'field-error-control-' + (++fieldSequence);
    const id = control.id + '-error';
    const descriptions = new Set((control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    let error = document.getElementById(id) || wrap.querySelector('.ferr');
    if (message) {
      if (!error) { error = document.createElement('div'); wrap.append(error); }
      error.id = id; error.className = className; error.setAttribute('role', 'alert'); error.textContent = message;
      descriptions.add(id); control.classList.add('invalid'); control.setAttribute('aria-invalid', 'true');
    } else {
      if (error) descriptions.delete(error.id);
      descriptions.delete(id); error?.remove(); control.classList.remove('invalid'); control.removeAttribute('aria-invalid');
    }
    if (descriptions.size) control.setAttribute('aria-describedby', [...descriptions].join(' '));
    else control.removeAttribute('aria-describedby');
  }
  function clearFieldError(control) {
    setFieldError(control, control.closest('.field, .task-title-field, .date-field') || control.parentNode, '');
  }
  function failField(form, name, msg) {
    const inp = form.querySelector(`[name="${name}"]`);
    if (!inp) return false;
    const wrap = inp.closest('.field') || inp.parentNode;
    const ctl = inp.matches('input:not([type=hidden]),textarea') ? inp : wrap.querySelector('.ctl');
    setFieldError(ctl, wrap, msg);
    ctl?.focus();
    return false;
  }

  function selectHtml(key, def) {
    SELS[key] = def;
    const cur = def.options.find((o) => o.v === def.value);
    return `<div class="sel"${def.width ? ` style="width:${def.width}px"` : ''}>
      ${def.name ? `<input type="hidden" name="${def.name}" value="${esc(def.value ?? '')}">` : ''}
      <button type="button" id="select-${UIEscape(key)}" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="${def.label ? `select-${key}-name ` : ''}select-${key}-value" class="ctl sel-btn${def.cls ? ' ' + def.cls : ''}${cur ? '' : ' empty'}" title="${esc(cur ? cur.l : (def.placeholder || 'Select'))}" ${def.disabled ? 'disabled' : `onclick="App.popSelect(event,'${UIArg(key)}')"`}>${def.label ? `<span class="sr-only" id="select-${UIEscape(key)}-name">${esc(def.label)}</span>` : ''}${def.icon || ''}<span id="select-${UIEscape(key)}-value" class="sel-label">${esc(cur ? cur.l : (def.placeholder || 'Select'))}</span>${def.cls ? '' : I.chev}</button>
    </div>`;
  }
  const MULTI = {};
  function multiHtml(key, def) {
    MULTI[key] = def;
    const label = def.summary();
    return `<div class="sel"${def.width ? ` style="width:${def.width}px"` : ''}>
      <button type="button" data-filter-key="${esc(key)}" aria-expanded="false" class="ctl sel-btn${def.cls ? ' ' + def.cls : ''}${def.values().length ? '' : ' empty'}" title="${esc(label)}" ${def.label ? `aria-label="${esc(def.label)}"` : ''} ${def.disabled ? 'disabled' : `onclick="App.popMulti(event,'${UIArg(key)}')"`}>${def.icon ? def.icon() : ''}<span class="sel-label">${esc(label)}</span>${def.cls ? '' : I.chev}</button>
    </div>`;
  }
  // Date values always use ISO. The editor owns separators; users enter digits.
  function parseDateInput(raw) {
    const text = String(raw ?? '');
    if (!text) return '';
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!parts) return null;
    const [, year, month, day] = parts;
    const y = Number(year), m = Number(month), n = Number(day);
    if (y < 1 || y > 9999 || m < 1 || m > 12 || n < 1 || n > 31) return null;
    const dt = new Date(0); dt.setUTCFullYear(y, m - 1, n);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== n) return null;
    return text;
  }
  function formatDateDigits(raw) {
    const digits = String(raw).replace(/[^0-9]/g, '').slice(0, 8);
    return digits.slice(0, 4) + (digits.length >= 4 ? '-' + digits.slice(4, 6) : '') + (digits.length >= 6 ? '-' + digits.slice(6, 8) : '');
  }
  function digitCaret(value, count) {
    if (!count) return 0;
    let seen = 0, pos = 0;
    while (pos < value.length && seen < count) { if (/[0-9]/.test(value[pos])) seen++; pos++; }
    while (value[pos] === '-') pos++;
    return pos;
  }
  function inputKind(input) {
    if (input.classList.contains('date-text')) return 'date';
    if (input.name === 'username') return 'username';
    if (input.name === 'key') return 'key';
    return 'text';
  }
  function sanitizeInputValue(input, value) {
    if (input.type === 'password') return value;
    const kind = inputKind(input);
    if (input.classList.contains('tp-title')) value = value.replace(/[\r\n\t]+/g, ' ');
    if (kind === 'date') return formatDateDigits(value);
    if (kind === 'username') return value.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 32);
    if (kind === 'key') return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    return value.replace(input.tagName === 'TEXTAREA' ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g : /[\x00-\x1f\x7f]/g, '');
  }
  function insertCleanText(input, text) {
    const kind = inputKind(input), old = input.value;
    const from = input.selectionStart ?? old.length, to = input.selectionEnd ?? from;
    let fragment = kind === 'username' ? text.toLowerCase().replace(/[^a-z0-9._-]/g, '')
      : kind === 'key' ? text.toUpperCase().replace(/[^A-Z0-9]/g, '')
      : sanitizeInputValue(input, text);
    if (!fragment && text) return;
    if (input.maxLength >= 0) fragment = fragment.slice(0, Math.max(0, input.maxLength - (old.length - (to - from))));
    const prefix = old.slice(0, from) + fragment;
    input.value = sanitizeInputValue(input, prefix + old.slice(to));
    const caret = Math.min(sanitizeInputValue(input, prefix).length, input.value.length);
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function editableText(input) {
    return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement && ['text','search','url','email','tel','password'].includes(input.type);
  }
  function normalizeInput(input) {
    if (!editableText(input) || input.disabled || input.readOnly || input.type === 'password') return;
    const old = input.value, caret = input.selectionStart ?? old.length;
    const value = sanitizeInputValue(input, old);
    if (value === old) return;
    const next = inputKind(input) === 'date' ? digitCaret(value, old.slice(0, caret).replace(/[^0-9]/g, '').length) : sanitizeInputValue(input, old.slice(0, caret)).length;
    input.value = value; input.setSelectionRange(next, next);
  }
  function editDateDigits(input, text, deletion) {
    const value = input.value;
    let from = value.slice(0, input.selectionStart).replace(/[^0-9]/g, '').length;
    let to = value.slice(0, input.selectionEnd).replace(/[^0-9]/g, '').length;
    const digits = value.replace(/[^0-9]/g, '');
    if (deletion && from === to) {
      if (deletion.includes('Backward')) from = Math.max(0, from - 1);
      else to = Math.min(digits.length, to + 1);
    }
    const inserted = text.replace(/[^0-9]/g, '').slice(0, Math.max(0, 8 - (digits.length - (to - from))));
    input.value = formatDateDigits(digits.slice(0, from) + inserted + digits.slice(to));
    const caret = digitCaret(input.value, from + inserted.length);
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function dateError(def, value) {
    if (value === null) return 'Enter a valid date in YYYY-MM-DD format.';
    if (!value) return def.clearable ? '' : 'Enter a date.';
    const min = def.min?.(), max = def.max?.();
    if (min && value < min) return def.minError || 'Date is before the allowed start.';
    if (max && value > max) return def.maxError || 'Date is after the allowed end.';
    return '';
  }
  function dateFieldError(wrap, message, focus = false) {
    const input = wrap.querySelector('.date-text');
    setFieldError(input, wrap, message, 'ferr date-error');
    if (message && focus) input.focus();
    return !message;
  }
  function dateValue(key) {
    const input = document.querySelector(`[data-date-key="${UIEscape(key)}"] .date-text`);
    return input ? parseDateInput(input.value) : '';
  }
  function commitDate(key, raw, focusError = false) {
    const def = DPS[key], wrap = document.querySelector(`[data-date-key="${UIEscape(key)}"]`);
    if (!def || def.disabled || !wrap) return false;
    const value = parseDateInput(raw), error = dateError(def, value);
    if (error) return dateFieldError(wrap, error, focusError);
    if (value !== (def.value || '') && def.pick && def.pick(value) === false) return false;
    def.value = value;
    wrap.querySelector('input[type="hidden"]').value = value;
    wrap.querySelector('.date-text').value = value || '';
    dateFieldError(wrap, '');
    // A corrected range can resolve the other field's error as well.
    const scope = wrap.closest('form') || wrap.parentElement;
    scope.querySelectorAll('.date-field').forEach((other) => {
      if (other === wrap) return;
      const input = other.querySelector('.date-text');
      if (input.getAttribute('aria-invalid') === 'true' && !dateError(DPS[other.dataset.dateKey], parseDateInput(input.value))) dateFieldError(other, '');
    });
    return true;
  }
  function validateFormDates(form) {
    let firstInvalid;
    form.querySelectorAll('.date-field').forEach((wrap) => {
      const input = wrap.querySelector('.date-text');
      if (!commitDate(wrap.dataset.dateKey, input.value) && !firstInvalid) firstInvalid = input;
    });
    if (firstInvalid) firstInvalid.focus();
    return !firstInvalid;
  }
  function dateHtml(key, def) {
    DPS[key] = def;
    const label = def.label || ({ start: 'Start date', end: 'End date', date: 'Date', _start: 'Start date', _dl: 'Deadline' }[def.name]) || 'Date';
    const placeholder = def.disabled ? 'Not set' : def.placeholder || (label === 'Date' ? 'Select date' : 'Set ' + label.toLowerCase());
    return `<div class="sel date-field${def.cls ? ' ' + def.cls : ''}" data-date-key="${UIEscape(key)}">
      <input type="hidden" name="${def.name}" value="${esc(def.value || '')}">
      ${def.cls && !def.hideLabel ? `<div class="date-inline-label">${label}${def.clearable ? optionalMark : ''}</div>` : ''}<div class="date-control"><input type="text" class="ctl date-text" id="${UIEscape(key)}-input" ${def.clearable ? 'aria-required="false"' : 'required aria-required="true"'} aria-label="${label}" value="${esc(def.value || '')}" placeholder="${esc(placeholder)}" aria-description="Type a date in YYYY-MM-DD format or use the calendar." maxlength="10" inputmode="numeric" autocomplete="off" spellcheck="false" ${def.disabled ? 'disabled' : `oninput="App.dateTyping('${UIArg(key)}')" onblur="App.dateBlur(event,'${UIArg(key)}')" onkeydown="App.dateKey(event,'${UIArg(key)}')"`}>
      <button type="button" class="date-trigger sel-btn" aria-label="Open ${label.toLowerCase()} calendar" aria-haspopup="dialog" aria-expanded="false" ${def.disabled ? 'disabled' : `onclick="App.popDate(event,'${UIArg(key)}')"`}>${def.icon || I.cal}</button></div>
    </div>`;
  }
  function calHtml(view, selected, focusDate, def) {
    const [, mo] = view.split('-').map(Number);
    const first = d(view + '-01');
    const gridStart = new Date(first); gridStart.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const dt = new Date(gridStart); dt.setUTCDate(gridStart.getUTCDate() + i);
      const ds = iso(dt);
      const cls = ['cal-d', dt.getUTCMonth() !== mo - 1 ? 'out' : '', ds === iso(today) ? 'today' : '', ds === selected ? 'sel' : '', ds === focusDate ? 'focus' : ''].join(' ');
      cells += `<button type="button" class="${cls}" data-d="${UIEscape(ds)}" aria-label="${humanFull(ds)}" aria-pressed="${ds === selected}" tabindex="${ds === focusDate ? 0 : -1}" ${dateError(def, parseDateInput(ds)) ? 'disabled' : ''}>${dt.getUTCDate()}</button>`;
    }
    return `<div class="cal">
      <div class="cal-head">
        <button type="button" class="btn icon" data-nav="-1" aria-label="Previous month">‹</button>
        <span class="cal-title">${first.toLocaleDateString('en-US', { timeZone:'UTC', month: 'long', year: 'numeric' })}</span>
        <button type="button" class="btn icon" data-nav="1" aria-label="Next month">›</button>
      </div>
      <div class="cal-grid">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((w) => `<div class="cal-wd">${w}</div>`).join('')}${cells}</div>
      <div class="cal-foot">
        <button type="button" class="btn quiet" data-today ${dateError(def, iso(today)) ? 'disabled' : ''}>Today</button>
        ${def.clearable ? '<button type="button" class="btn quiet" data-clear>Clear</button>' : ''}
      </div>
    </div>`;
  }

  // ---------- roadmap geometry ----------
  let RAIL = 208;
  const AXIS = 70, MONTH_ROW = 32, BAR_H = 58, ROW_GAP = 8, LANE_PAD = 14, EPIC_GAP = 8, EPIC_MIN_WIDTH = 60;

  function rmRange() {
    let min = today, max = new Date(today.getTime() + 60 * DAY);
    epics().forEach((e) => {
      const s = d(e.start); if (s < min) min = s;
      if (e.end) { const en = d(e.end); if (en > max) max = en; }
    });
    milestones().forEach((m) => { const md = d(m.date); if (md < min) min = md; if (md > max) max = md; });
    const start = new Date(min.getTime() - 10 * DAY);
    const viewport = document.querySelector('.content')?.clientWidth || window.innerWidth;
    const visibleDays = Math.max(0, viewport - RAIL) / state.pxPerDay;
    const end = new Date(Math.max(max.getTime() + 45 * DAY, +start + visibleDays * DAY));
    return { start, end };
  }

  function epicGeometry(e, x, rangeEnd) {
    const left = x(d(e.start));
    return { left, width: e.end ? Math.max(x(d(e.end)) - left, EPIC_MIN_WIDTH) : Math.max(x(rangeEnd) - left, EPIC_MIN_WIDTH) };
  }
  function packRows(list, rangeEnd, x) {
    const rows = [];
    const sorted = [...list].sort((a, b) => d(a.start) - d(b.start));
    sorted.forEach((e) => {
      const start = d(e.start), end = e.end ? d(e.end) : rangeEnd;
      const { left, width } = epicGeometry(e, x, rangeEnd);
      // Date intervals and minimum card widths must both fit before reusing a row.
      let row = rows.findIndex((last) => start > last.end && left >= last.right + EPIC_GAP);
      if (row < 0) row = rows.length;
      rows[row] = { end, right: left + width };
      e._row = row;
    });
    return { list: sorted, rows: Math.max(rows.length, 1) };
  }

  function epicBar(e, x, rangeEnd, padTop, barHeight = BAR_H) {
    const s = d(e.start);
    const ongoing = !e.end;
    const { left, width } = epicGeometry(e, x, rangeEnd);
    const top = padTop + e._row * (barHeight + ROW_GAP);
    const cls = ['bar', e.state, ongoing ? 'ongoing' : '', (ongoing && e.total === 0 && e.state !== 'done') ? 'quiet' : ''].join(' ');
    const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;

    const right = e.state === 'done' ? I.check : '';

    let meta;
    if (e.state === 'done') meta = `${e.total ? e.done+'/'+e.total+' · ' : ''}<span style="color:var(--ok)">complete</span>`;
    else if (ongoing && e.total === 0) meta = '<span style="color:var(--ink-faint)">ongoing</span>';
    else if (ongoing) meta = `<span style="color:var(--ink-soft)">ongoing</span> · ${e.completedSinceStart ?? e.done} done · ${e.open ?? e.total - e.done} open`;
    else if (e.state === 'planning') meta = `${e.done}/${e.total} · starts ${humanShort(s)}`;
    else meta = `${e.done}/${e.total}`;

    const prog = (ongoing || e.total === 0) ? '' :
      `<div class="prog"><i style="width:${pct}%;background:${e.state === 'done' ? 'var(--ok)' : 'var(--run)'}"></i></div>`;

    return `<div class="${cls}" data-epic="${UIEscape(e.id)}" role="button" tabindex="0" aria-label="${esc(e.title)}" style="left:${left}px;top:${top}px;width:${width}px" onclick="App.openPeek('${UIArg(e.id)}')" onmouseenter="App.epicHover(event,'${UIArg(e.id)}')" onmouseleave="App.epicLeave()" onfocus="App.epicHover(event,'${UIArg(e.id)}',true)" onblur="App.epicLeave()" onkeydown="App.epicKey(event,'${UIArg(e.id)}')">
      <div class="t"><span class="txt">${esc(e.title)}</span>${right}</div>
      <div class="m">${meta}</div>${prog}</div>`;
  }

  const EPIC_TIP = { el: null, anchor: null, showTimer: null, hideTimer: null };
  function hideEpicTip() {
    clearTimeout(EPIC_TIP.showTimer); clearTimeout(EPIC_TIP.hideTimer);
    EPIC_TIP.anchor?.removeAttribute('aria-describedby');
    if(EPIC_TIP.el)exitVisual(EPIC_TIP.el);EPIC_TIP.el?.remove(); EPIC_TIP.el = null; EPIC_TIP.anchor = null;
  }
  function mountRoadmapTip(anchor, id, html) {
    if (!anchor.isConnected || state.modal || state.peek || state.menu) return;
    hideEpicTip();
    const el = document.createElement('div'); el.className = 'epic-tooltip'; el.id = id; el.setAttribute('role', 'tooltip');
    setHTML(el,html);
    document.body.append(el); EPIC_TIP.el = el; EPIC_TIP.anchor = anchor;
    anchor.setAttribute('aria-describedby', el.id);
    const rect = anchor.getBoundingClientRect(), width = el.offsetWidth, height = el.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
    const top = rect.bottom + height + 10 <= innerHeight ? rect.bottom + 8 : rect.top - height - 8;
    el.style.left = left + 'px'; el.style.top = Math.max(8, Math.min(top, innerHeight - height - 8)) + 'px';UIMotion.enter(el);
    el.addEventListener('mouseenter', () => clearTimeout(EPIC_TIP.hideTimer));
    el.addEventListener('mouseleave', () => App.epicLeave());
  }
  function showEpicTip(anchor, id) {
    const epic = epicById(id);
    if (!epic||!canReadProject(trackById(epic.trackId)?.projectId)) return;
    const status = { planning: 'Planning', active: 'In progress', done: 'Done' }[epic.state] || epic.state;
    mountRoadmapTip(anchor, 'epic-tooltip', `<div class="epic-tip-title">${esc(epic.title)}</div>
      <div class="epic-tip-track">${esc(trackById(epic.trackId)?.name || '')}</div>
      <dl class="epic-tip-facts"><div><dt>Status</dt><dd>${esc(status)}</dd></div><div><dt>Tasks</dt><dd>${epic.done} / ${epic.total} done</dd></div>
      <div><dt>Start</dt><dd>${esc(epic.start)}</dd></div><div><dt>End</dt><dd>${epic.end ? esc(epic.end) : 'No end date'}</dd></div></dl>
      ${epic.desc ? `<div class="epic-tip-description">${esc(epic.desc)}</div>` : ''}`);
  }
  function showMilestoneTip(anchor, id) {
    const milestone = milestones().find(m => m.id === id);
    if (!milestone) return;
    const days = Math.round((d(milestone.date) - today) / DAY);
    const timing = days === 0 ? 'Today' : `${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} ${days > 0 ? 'away' : 'ago'}`;
    mountRoadmapTip(anchor, 'milestone-tooltip', `<div class="epic-tip-title">${esc(milestone.name)}</div>
      <div class="epic-tip-track">Milestone · ${esc(project().name)}</div>
      <dl class="epic-tip-facts"><div><dt>Date</dt><dd>${esc(milestone.date)}</dd></div><div><dt>Timing</dt><dd>${timing}</dd></div></dl>
      <div class="epic-tip-description">${milestone.desc ? esc(milestone.desc) : '<span style="color:var(--ink-ghost)">No description</span>'}</div>`);
  }

  /** @type {number|null} */
  let roadmapHeight=null;
  function measureEpicHeight() {
    const probe = document.createElement('div');
    probe.className = 'bar planning';
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:300px';
    setHTML(probe, '<div class="t"><span class="txt">Epic</span></div><div class="m">0/1 · ongoing</div>');
    (document.querySelector('.content') || document.body).append(probe);
    const height = Math.max(BAR_H, Math.ceil(probe.getBoundingClientRect().height));
    probe.remove();
    return height;
  }
  function renderRoadmap() {
    const barHeight = measureEpicHeight();
    RAIL = window.innerWidth <= 900 ? 132 : 208;
    const trs = tracks();
    const { start, end } = rmRange();
    const ppd = state.pxPerDay;
    const x = (dt) => Math.round((dt - start) / DAY * ppd);
    const tlWidth = x(end);

    // Pack goal labels independently of epic lanes, including room for Today.
    const todayX = x(today);
    const labelRows = [[{ left: todayX - 34, right: todayX + 34 }]];
    const goalLabels = milestones().slice().sort((a, b) => d(a.date) - d(b.date)).map((m) => {
      const date = d(m.date);
      const days = Math.round((date.getTime() - today.getTime()) / DAY);
      const past = days < 0;
      const name = m.name.charAt(0).toUpperCase() + m.name.slice(1);
      const dateLabel = humanShort(date) + (days > 0 ? ` · ${days}d away` : days === 0 ? ' · Today' : '');
      const width = Math.min(240, Math.max(112, name.length * (past ? 7.5 : 8.5) + (past ? 50 : 62), dateLabel.length * 6 + (past ? 50 : 62)));
      const cx = x(date);
      const left = Math.max(6, Math.min(cx - width / 2, tlWidth - width - 6));
      let row = labelRows.findIndex((items) => items.every((other) => left + width + 12 <= other.left || left >= other.right + 12));
      if (row < 0) { row = labelRows.length; labelRows.push([]); }
      labelRows[row].push({ left, right: left + width });
      return { m, past, name, dateLabel, width, cx, left, row };
    });
    const axisHeight = AXIS + (labelRows.length - 1) * 58;

    // Calendar cells are mounted for the viewport, independent of date span.
    // lanes — packed minimum heights, then leftover viewport height shared evenly
    const packs = trs.map((t) => packRows(epics().filter((e) => e.trackId === t.id), end, x));
    const minHs = packs.map((p) => Math.max(2 * LANE_PAD + p.rows * barHeight + (p.rows - 1) * ROW_GAP, 88));
    const contentEl = document.querySelector('.content');
    roadmapHeight=contentEl ? contentEl.clientHeight : window.innerHeight - 80;
    const availH = (roadmapHeight) - axisHeight - MONTH_ROW - 8;
    const extra = trs.length ? Math.max((availH - minHs.reduce((a, b) => a + b, 0)) / trs.length, 0) : 0;
    let lanes = '';
    trs.forEach((t, ti) => {
      const packed = packs[ti];
      const h = Math.round(minHs[ti] + extra);
      const rowsContent = packed.rows * barHeight + (packed.rows - 1) * ROW_GAP;
      const padTop = Math.round((h - rowsContent) / 2);
      const active = packed.list.filter((e) => e.state === 'active').length;
      const doneN = packed.list.filter((e) => e.state === 'done').length;
      const cont = packed.list.some((e) => !e.end);
      const sub = packed.list.length
        ? `${packed.list.length} epic${packed.list.length > 1 ? 's' : ''}${active ? ` · ${active} active` : ''}${doneN ? ` · ${doneN} done` : ''}${cont ? ' · continuous' : ''}`
        : 'no epics yet';
      const bars = packed.list.map((e) => epicBar(e, x, end, padTop, barHeight)).join('');
      lanes += `<div class="lane" data-track="${UIEscape(t.id)}" ${canRoadmap() ? `ondragover="App.laneOver(event)" ondrop="App.trackDrop(event,'${UIArg(t.id)}')"` : ''} style="height:${h}px">
        <div class="rail-cell lane-head" style="width:${RAIL}px">
          <h2 class="name" title="${esc(t.name)}">${esc(t.name)}</h2><div class="sub">${sub}</div>
          ${canRoadmap() ? `<div class="head-ctl">
            <button type="button" class="grip" aria-label="Reorder ${esc(t.name)}" onkeydown="App.trackReorderKey(event,'${UIArg(t.id)}')" data-reorderable="true" ondragstart="App.trackDragStart(event,'${UIArg(t.id)}')" ondragend="App.dragEnd()" title="Drag to reorder or use arrow keys">${I.grip}</button>
            <button type="button" class="kebab icon-button" aria-label="Manage ${esc(t.name)} track" onclick="App.trackMenu(event,'${UIArg(t.id)}')">${I.kebab}</button>
          </div>` : ''}
        </div>
        <div class="lane-body" style="width:${tlWidth}px">${bars}</div>
      </div>`;
    });

    // milestones + today (labels live in the sticky axis; lines span the canvas)
    let msHtml = '', msLabels = '';
    goalLabels.forEach(({ m, past, name, dateLabel, width, cx, left, row }) => {
      msHtml += `<div class="ms-line${past ? ' past' : ''}" aria-hidden="true" style="left:${RAIL + cx}px;top:${axisHeight}px;bottom:${MONTH_ROW}px"></div>`;
      msLabels += `<div class="ms-line goal-connector${past ? ' past' : ''}" aria-hidden="true" style="left:${cx}px;top:${12 + row * 58 + 54}px;bottom:-1px"></div>`;
      msLabels += `<button type="button" class="ms-label${past ? ' past' : ''}" data-milestone="${UIEscape(m.id)}" style="left:${left + width / 2}px;top:${12 + row * 58}px;width:${width}px" onclick="App.milestoneClick(event,'${UIArg(m.id)}')" onmouseenter="App.milestoneHover(event,'${UIArg(m.id)}')" onmouseleave="App.epicLeave()" onfocus="App.milestoneHover(event,'${UIArg(m.id)}',true)" onblur="App.epicLeave()" onkeydown="App.roadmapTipKey(event)">
        ${I.diamond}<span class="txt"><span class="goal-name">${esc(name)}</span><span class="goal-date">${dateLabel}</span></span></button>`;
    });
    const tx = RAIL + x(today);
    const todayHtml = `<div class="today-line" style="left:${tx}px;top:${axisHeight}px;bottom:${MONTH_ROW}px"></div>`;
    const todayPill = `<div class="today-line today-connector" aria-hidden="true" style="left:${todayX}px;top:32px;bottom:-1px"></div><div class="today-pill" style="left:${todayX}px;top:12px">${human(today)}</div>`;

    const emptyProject = trs.length === 0;
    return `<div class="rm-scroll" id="rmScroll" data-bar-height="${UIEscape(barHeight)}" data-range-start="${UIEscape(+start)}" data-range-end="${UIEscape(+end)}" data-axis-height="${UIEscape(axisHeight)}">
      <div class="rm-canvas" style="width:${RAIL + tlWidth}px">
        <div class="rm-axis" style="width:${RAIL + tlWidth}px;height:${axisHeight}px">
          <div class="rail-cell rm-track-head" style="width:${RAIL}px">${canRoadmap() ? `<button class="btn quiet" type="button" onclick="App.openModal('track')">${I.plus}<span>Track</span></button>` : '<span class="rm-track-title">Tracks</span>'}</div>
          <div class="rm-axis-labels"><span class="rm-calendar-axis"></span>${msLabels}${todayPill}</div>
        </div>
        <span class="rm-calendar-lines"></span>${msHtml}${todayHtml}${lanes}
        ${emptyProject ? `<div style="position:sticky;left:0;width:100%;padding:60px 0;text-align:center;color:var(--ink-ghost);font-size:var(--text-body)">No tracks yet.</div>` : ''}
        <div class="rm-month-row" style="height:${MONTH_ROW}px"><div class="rail-cell" style="width:${RAIL}px"></div><div class="rm-month-grid"></div></div>
      </div>
    </div>`;
  }

  function taskMovePlan(t, col, beforeId = null) {
    const originalColumn = tasks().filter((item) => item.state === col);
    const destination = originalColumn.filter((item) => item !== t);
    const index = beforeId ? destination.findIndex((item) => item.id === beforeId) : destination.length;
    if (beforeId && index < 0) return null;
    const nextColumn = [...destination]; nextColumn.splice(index, 0, t);
    if (t.state === col && originalColumn.length === nextColumn.length && originalColumn.every((item, at) => item === nextColumn[at])) return null;
    const placement = beforeId
      ? { beforeTaskId: taskById(beforeId)?.internalId || beforeId }
      : destination.length
        ? { afterTaskId: destination.at(-1).internalId || destination.at(-1).id }
        : { position: 0 };
    return { destination, index, placement };
  }

  function applyTaskMove(t, col, beforeId = null) {
    const plan = taskMovePlan(t, col, beforeId); if (!plan) return null;
    const previousState = t.state, projectId=t.projectId||trackById(epicById(t.epicId)?.trackId)?.projectId||state.projectId, sessionKey=`${D.session?.id||''}:${D.session?.userId||''}`;
    const taskProject=(item)=>item.projectId||trackById(epicById(item.epicId)?.trackId)?.projectId;
    const previousProjectTasks=D.tasks.filter((item)=>taskProject(item)===projectId),taskIndex=previousProjectTasks.indexOf(t);
    const previousTaskBefore=taskIndex>0?previousProjectTasks[taskIndex-1]:null,previousTaskAfter=previousProjectTasks[taskIndex+1]||null;
    const previousOrders = new Map(tasks().map((item)=>[item,item.order]));
    const pageInfoReference=D.boardPageInfo;
    const previousPageInfo = D.boardPageInfo ? JSON.parse(JSON.stringify(D.boardPageInfo)) : null;
    const countsReference=D.projectTaskCounts?.[projectId]||null;
    const previousCounts = countsReference ? { ...countsReference } : null;
    const affectedEpics = new Map();
    for (const id of new Set([t.epicId])) { const item = epicById(id); if (item) affectedEpics.set(id, { item, state:item.state, done:item.done }); }
    D.tasks.splice(D.tasks.indexOf(t), 1);
    const anchor = beforeId ? taskById(beforeId) : plan.destination.at(-1);
    const at = anchor ? D.tasks.indexOf(anchor) + (beforeId ? 0 : 1) : D.tasks.length;
    D.tasks.splice(Math.max(0, at), 0, t);
    t.state = col;
    for (const status of new Set([previousState,col])) tasks().filter((item)=>item.state===status).forEach((item,index)=>{item.order=index;});
    const epic = epicById(t.epicId);
    if (epic) {
      if (col === 'done') epic.done += 1;
      if (previousState === 'done') epic.done = Math.max(epic.done - 1, 0);
      if (col !== 'planning' && epic.state === 'planning') epic.state = 'active';
    }
    const pages=D.boardPageInfo?.projectId===projectId?D.boardPageInfo?.pages:null;
    if(previousState!==col&&pages){if(pages[previousState])pages[previousState].total=Math.max(0,pages[previousState].total-1);if(pages[col])pages[col].total+=1;}
    const counts=D.projectTaskCounts?.[projectId];
    if(previousState!==col&&counts){counts[previousState]=Math.max(0,(counts[previousState]||0)-1);counts[col]=(counts[col]||0)+1;counts.open=counts.planning+counts.progress+counts.review;}
    const optimisticOrders=new Map([...previousOrders.keys()].map((item)=>[item,item.order]));
    const optimisticEpics=new Map([...affectedEpics].map(([id])=>{const item=epicById(id);return[id,{item,state:item?.state,done:item?.done}];}));
    return {
      task:t, revision:t.revision, projectId, sessionKey, previousState, optimisticState:col,
      previousTaskBefore,previousTaskAfter,previousOrders,optimisticOrders,
      pageInfoReference,previousPageInfo,optimisticPageInfo:D.boardPageInfo?JSON.parse(JSON.stringify(D.boardPageInfo)):null,
      countsReference,previousCounts,optimisticCounts:countsReference?{...countsReference}:null,affectedEpics,optimisticEpics,
      payload:{ taskId:t.internalId||t.id, status:col, ...plan.placement, optimistic:true },
    };
  }

  function rollbackTaskMove(change) {
    const sessionKey=`${D.session?.id||''}:${D.session?.userId||''}`;
    if (!change || sessionKey!==change.sessionKey || !D.tasks.includes(change.task) || change.task.revision !== change.revision || change.task.state!==change.optimisticState) return false;
    const currentIndex=D.tasks.indexOf(change.task);D.tasks.splice(currentIndex,1);
    if(change.previousTaskAfter&&D.tasks.includes(change.previousTaskAfter))D.tasks.splice(D.tasks.indexOf(change.previousTaskAfter),0,change.task);
    else if(change.previousTaskBefore&&D.tasks.includes(change.previousTaskBefore))D.tasks.splice(D.tasks.indexOf(change.previousTaskBefore)+1,0,change.task);
    else D.tasks.splice(Math.min(currentIndex,D.tasks.length),0,change.task);
    change.task.state=change.previousState;
    for(const [item,order] of change.previousOrders)if(D.tasks.includes(item)&&item.order===change.optimisticOrders.get(item))item.order=order;
    if(change.previousPageInfo&&D.boardPageInfo===change.pageInfoReference&&JSON.stringify(D.boardPageInfo)===JSON.stringify(change.optimisticPageInfo))D.boardPageInfo=change.previousPageInfo;
    if(change.previousCounts&&D.projectTaskCounts?.[change.projectId]===change.countsReference&&JSON.stringify(change.countsReference)===JSON.stringify(change.optimisticCounts))D.projectTaskCounts[change.projectId]=change.previousCounts;
    for(const [id,value] of change.affectedEpics){const item=epicById(id),optimistic=change.optimisticEpics.get(id);if(item===value.item&&item===optimistic?.item&&item.state===optimistic.state&&item.done===optimistic.done)Object.assign(item,{state:value.state,done:value.done});}
    return true;
  }

  function submitTaskMove(change,onRollback=()=>render()) {
    if (!change || !bootWindow.OneloopRuntime) return;
    const pending={};App._boardMovePending=pending;
    bootWindow.OneloopRuntime.invoke('task.move',change.payload).catch((error)=>{
      if(!error?.uncertain&&rollbackTaskMove(change)&&state.view==='board'&&state.projectId===change.projectId)onRollback();
      bootWindow.OneloopRuntime.report(error);
    }).finally(()=>{if(App._boardMovePending===pending)App._boardMovePending=false;});
  }

  function setTaskState(t, col) {
    if (!canBoard()) return;
    if (App._boardMovePending) return false;
    if (t.state === col) return;
    if (t.block && col === 'done') { App.openModal('completeBlocked', t.id); return false; }
    if (bootWindow.OneloopRuntime) {
      const change=applyTaskMove(t,col);if(!change)return false;submitTaskMove(change);return;
    }
    const prev = t.state;
    t.state = col;
    const pe = epicById(t.epicId);
    if (pe) {
      if (col === 'done') pe.done += 1;
      if (prev === 'done') pe.done = Math.max(pe.done - 1, 0);
      if (col !== 'planning' && pe.state === 'planning') pe.state = 'active';
    }
    logAct(t, `moved it to ${STATUS[col]}`, {field:'state',before:prev,after:col});
  }

  function focusMovedTrack(id) {
    const lane = [...document.querySelectorAll('.lane[data-track]')].find(el=>el.dataset.track===id);
    lane?.querySelector('.grip')?.focus({preventScroll:true});
    announce(`${trackById(id)?.name || 'Track'} moved to position ${tracks().findIndex(track=>track.id===id)+1}`);
  }
  function focusMovedTask(id) {
    if (state.view !== 'board' || state.modal) return;
    const card = [...document.querySelectorAll('.card[data-task]')].find(el=>el.dataset.task===id);
    (card?.querySelector('.card-move') || card?.querySelector('.card-title-button') || document.getElementById('main'))?.focus({preventScroll:true});
    announce(`${id} moved to ${STATUS[taskById(id)?.state] || 'new position'}`);
  }

  // ---------- board ----------
  const COLS = [
    { key: 'planning', name: 'Planning' },
    { key: 'progress', name: 'In Progress' },
    { key: 'review', name: 'In Review' },
    { key: 'done', name: 'Done' },
  ];
  const stIcon = (state) => I['st_' + state] || '';

  function taskBits(t) {
    if (t.state === 'done') return { right: stIcon('done'), cls: 'done' };
    if (t.state === 'review') return { right: '', cls: 'review' };
    return { right: '', cls: '' };
  }

  function boardTasks() {
    let ts = tasks();
    if (state.boardTracks.length) { const eids = new Set(epics().filter((e) => state.boardTracks.includes(e.trackId)).map((e) => e.id)); ts = ts.filter((t) => eids.has(t.epicId)); }
    if (state.boardEpics.length) ts = ts.filter((t) => state.boardEpics.includes(t.epicId));
    if (state.boardAssignees.length) ts = ts.filter((t) => {
      const assignees = t.assignees || [];
      return (!assignees.length && state.boardAssignees.includes(NO_ASSIGNEE)) || assignees.some((a) => state.boardAssignees.includes(a));
    });
    if (state.boardBlocked) ts = ts.filter(t=>!!t.block && t.state!=='done');
    if (state.boardQ) { const q = state.boardQ.toLowerCase(); ts = ts.filter((t) => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)); }
    return ts;
  }

  /** @param {{column?:string|null,excludeIds?:Set<string>|null}} [options] */
  function renderBoard({column=null,excludeIds=null}={}) {
    const ts = boardTasks();
    const filtered = state.boardBlocked || state.boardQ || state.boardTracks.length || state.boardEpics.length || state.boardAssignees.length;
    if (!ts.length) return `<div class="board board-empty"><div class="page-empty"><h2>${filtered ? 'No matching tasks' : 'No tasks yet'}</h2>${filtered ? `<button class="btn quiet" onclick="App.clearBoardFilters()">Clear filters</button>` : canBoard() ? `<button class="btn primary" onclick="App.openModal('task')">${I.plus} Create task</button>` : ''}</div></div>`;
    const cols = COLS.filter(c=>!column||c.key===column).map((c) => {
      const list = ts.filter((t) => t.state === c.key);
      const serverPage = D.boardPageInfo?.projectId === state.projectId ? D.boardPageInfo.pages?.[c.key] : null;
      const cards = list.slice(0,state.boardLimits[c.key] || 50).filter(t=>!excludeIds?.has(t.id)).map((t) => {
        const e = epicById(t.epicId);
        const b = taskBits(t);
        const av = (t.assignees || []).filter(userById);
        const avs = av.slice(0, 3).map((a) => avatarHtml(a, 18)).join('') + (av.length > 3 ? `<span class="avatar" style="width:18px;height:18px;font-size:var(--text-xs)">+${av.length - 3}</span>` : '');
        return `<div role="listitem" class="card ${b.cls}${t.block ? ' blocked' : ''}" data-task="${UIEscape(t.id)}" ${canBoard() ? `data-reorderable="true" ondragstart="App.taskDragStart(event,'${UIArg(t.id)}')" ondragend="App.dragEnd()"` : ''} onclick="App.openTask('${UIArg(t.id)}')">
          <div class="id-row"><span>${esc(t.id)}</span><span class="card-end">${t.block ? `<span class="blocked-badge" title="${esc(t.block.reason)} — ${esc(userById(t.block.by)?.name || t.block.by)} · ${formatInstant(t.block.at)}">${I.blocked}Blocked</span>` : ''}${b.right}${canBoard() ? `<button type="button" class="card-move" aria-label="Move ${esc(t.id)}" onclick="event.stopPropagation();App.taskMoveMenu(event,'${UIArg(t.id)}')">${I.kebab}</button>` : ''}</span></div>
          <button type="button" class="title card-title-button" aria-describedby="card-context-${esc(t.id)}">${esc(t.title)}</button>
          <span class="sr-only" id="card-context-${esc(t.id)}">${esc([t.id,c.name,e?.title,t.deadline ? 'Due '+t.deadline : '',overdue(t) ? 'Overdue' : '',t.block ? 'Blocked: '+t.block.reason+' — '+(userById(t.block.by)?.name||t.block.by)+' · '+formatInstant(t.block.at) : '',av.length ? 'Assigned to '+av.map(id=>userById(id).name).join(', ') : 'Unassigned'].filter(Boolean).join(' · '))}</span>
          <div class="epic" title="${esc(e ? e.title : '')}">${esc(e ? e.title : '')}</div>
          <div class="card-foot">
            <span class="mono" title="created">${t.created ? humanInstant(t.created) : ''}</span>
            ${t.deadline ? `<span class="mono dl${overdue(t) ? ' late' : ''}" title="Deadline ${esc(t.deadline)}">${I.clock}${humanShort(d(t.deadline))}${overdue(t) ? ' · Overdue' : ''}</span>` : ''}
            <span class="avs">${avs}</span>
          </div></div>`;
      }).join('');
      return `<section class="col" aria-labelledby="col-${c.key}" data-col="${UIEscape(c.key)}" ${canBoard() ? `ondragover="App.colOver(event)" ondragleave="App.colLeave(event)" ondrop="App.dropTask(event,'${UIArg(c.key)}')"` : ''}>
        <div class="col-head"><div class="row1">${stIcon(c.key)}<h2 id="col-${UIEscape(c.key)}">${c.name}</h2><span class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">${serverPage?.total ?? list.length}</span></div>
        </div>
        <div class="col-cards" role="list" aria-labelledby="col-${c.key}">${cards || '<div class="empty-note" role="listitem">No tasks</div>'}${serverPage?.nextCursor || !bootWindow.OneloopRuntime && list.length > (state.boardLimits[c.key] || 50) ? `<div role="listitem" class="board-load-more"><button class="btn quiet" onclick="App.loadMoreBoard('${UIArg(c.key)}')">Load more</button></div>` : ''}</div></section>`;
    }).join('');
    return `<div class="board">${cols}</div>`;
  }

  const filterAnimations = new Set();
  const filterExitLayers = new Set();
  const filterScroll = new WeakMap();
  const boardSnapshots = new WeakMap();
  let boardSearchTimer;
  function cancelBoardSearch() { clearTimeout(boardSearchTimer); boardSearchTimer = null; }
  function boardSnapshot() {
    // Display dependencies, not just task revisions: access, parent names,
    // avatars and date boundaries can change independently of a task.
    return JSON.stringify([
      state.projectId, canBoard(), instanceTimeZone(), instanceDateKey(instanceNow()),
      !!(state.boardQ || state.boardBlocked || state.boardTracks.length || state.boardEpics.length || state.boardAssignees.length),
      state.boardLimits, D.boardPageInfo,
      boardTasks().map(t=>[t.id,t.state,t.title,t.epicId,t.created,t.deadline,t.assignees,t.block]),
      D.epics.map(e=>[e.id,e.title]), D.users.map(u=>[u.id,u.name,u.avatar]),
    ]);
  }
  function clearFilterMotion() {
    filterAnimations.forEach((animation) => animation.cancel());
    filterAnimations.clear();
    filterExitLayers.forEach((layer) => layer.remove());
    filterExitLayers.clear();
  }
  function filterAnimate(element, frames, cleanup) {
    const animation = element.animate(frames, { duration: MOTION.normal, easing: MOTION.ease });
    filterAnimations.add(animation);
    const finish = () => { filterAnimations.delete(animation); cleanup?.(); };
    animation.finished.then(finish, finish);
  }
  function boardRowKey(row, column) {
    if (row.dataset.task) return `task:${row.dataset.task}`;
    return `${column}:${row.classList.contains('empty-note') ? 'empty' : 'more'}`;
  }
  // Board rows have stable actions for their key. Preserve their DOM/listeners,
  // focus and images while updating changed presentation. Permission changes
  // replace a card so its drag handlers are installed/removed together.
  function patchBoardRow(current, next) {
    for (const attribute of [...current.attributes])
      if (!attribute.name.startsWith('on') && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    for (const attribute of next.attributes)
      if (!attribute.name.startsWith('on') && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    const children = [...next.childNodes];
    children.forEach((child, index) => {
      const old = current.childNodes[index];
      if (!old) { current.append(child); return; }
      if (old.nodeType !== child.nodeType || old.nodeName !== child.nodeName) { old.replaceWith(child); return; }
      if (child.nodeType === Node.ELEMENT_NODE) patchBoardRow(old, child);
      else if (old.nodeValue !== child.nodeValue) old.nodeValue = child.nodeValue;
    });
    while (current.childNodes.length > children.length) current.lastChild.remove();
    return current;
  }
  function applyBoardFilters(reset = true, fromServer = false, { animate: motion = true } = {}) {
    if (!fromServer) cancelBoardSearch();
    updateDocumentTitle();
    if(reset) state.boardLimits = {planning:50,progress:50,review:50,done:50};
    if(bootWindow.OneloopRuntime&&!fromServer){bootWindow.OneloopRuntime.invoke('board.filter',App.context().board).catch(bootWindow.OneloopRuntime.report);return;}
    const board = document.querySelector('.board');
    if (!board || state.view !== 'board') return;
    const snapshot = boardSnapshot();
    if (boardSnapshots.get(board) === snapshot) return;
    today.setTime(instanceToday().getTime());
    // Snapshot painted positions before cancelling an interrupted transition.
    const previous = new Map([...board.querySelectorAll('.col-cards > *')].map((card) =>
      [boardRowKey(card,card.closest('.col').dataset.col), { card, rect: card.getBoundingClientRect(), opacity: getComputedStyle(card).opacity }]));
    clearFilterMotion();
    const animate = motion && !reducedMotion.matches && typeof board.animate === 'function' && !App._drag;
    const template = document.createElement('template');
    setHTML(template,renderBoard());
    if (!board.querySelector('.col') || !template.content.querySelector('.col')) {
      const next=template.content.firstElementChild;
      if (board.classList.contains('board-empty') && next.classList.contains('board-empty')
        && board.textContent===next.textContent && board.querySelector('button')?.className===next.querySelector('button')?.className) {boardSnapshots.set(board,snapshot);return;}
      board.replaceWith(next); boardSnapshots.set(next,snapshot); fadeContent(next); return;
    }
    [...board.querySelectorAll('.col')].forEach((column) => {
      const list = column.querySelector('.col-cards');
      const next = template.content.querySelector(`[data-col="${UIEscape(column.dataset.col)}"]`);
      const desired = [...next.querySelector('.col-cards').children];
      const ids = new Set(desired.map((card) => card.dataset.task).filter(Boolean));
      const viewport = list.getBoundingClientRect();
      const oldCards = [...list.querySelectorAll('.card')];
      const memory = filterScroll.get(list);
      const scrollTop = memory && list.scrollTop === memory.applied ? memory.wanted : list.scrollTop;
      let exitLayer;
      if (animate) oldCards.forEach((card) => {
        const old = previous.get(boardRowKey(card,column.dataset.col));
        if (ids.has(card.dataset.task) || old.rect.bottom <= viewport.top || old.rect.top >= viewport.bottom) return;
        if (!exitLayer) {
          exitLayer = document.createElement('div');
          exitLayer.className = 'board-filter-exits';
          exitLayer.style.cssText = `left:${list.offsetLeft}px;top:${list.offsetTop}px;width:${list.clientWidth}px;height:${list.clientHeight}px`;
          exitLayer.setAttribute('aria-hidden', 'true'); exitLayer.inert = true;
          column.append(exitLayer); filterExitLayers.add(exitLayer);
        }
        const ghost = card.cloneNode(true);
        ghost.removeAttribute('data-task'); ghost.removeAttribute('data-reorderable');
        ghost.removeAttribute('onclick'); ghost.removeAttribute('ondragstart'); ghost.removeAttribute('ondragend');
        ghost.style.cssText = `position:absolute;margin:0;left:${old.rect.left - viewport.left}px;top:${old.rect.top - viewport.top}px;width:${old.rect.width}px;height:${old.rect.height}px`;
        exitLayer.append(ghost);
        const layer = exitLayer;
        filterAnimate(ghost, [{ opacity: old.opacity }, { opacity: 0 }], () => {
          ghost.remove();
          if (!layer.children.length) { layer.remove(); filterExitLayers.delete(layer); }
        });
      });
      // Keep unchanged children connected; replaceChildren would detach focused
      // controls and restart empty-state/Load more entrance animations.
      let cursor=list.firstElementChild;
      for (const row of desired) {
        const old=previous.get(boardRowKey(row,column.dataset.col))?.card;
        const child=old && old.hasAttribute('data-reorderable')===row.hasAttribute('data-reorderable') ? patchBoardRow(old,row) : row;
        if (child===cursor) cursor=cursor.nextElementSibling;
        else list.insertBefore(child,cursor);
      }
      while(cursor){const next=cursor.nextElementSibling;cursor.remove();cursor=next;}
      const count=column.querySelector('.col-head .row1 .mono'),nextCount=next.querySelector('.col-head .row1 .mono').textContent;
      if(count.textContent!==nextCount)count.textContent=nextCount;
      list.scrollTop = scrollTop;
      filterScroll.set(list, { wanted: scrollTop, applied: list.scrollTop });
      if (!animate) return;
      [...list.children].forEach((card) => {
        const to = card.getBoundingClientRect(), old = previous.get(boardRowKey(card,column.dataset.col));
        const visible = to.bottom > viewport.top && to.top < viewport.bottom;
        const wasVisible = old && old.rect.bottom > viewport.top && old.rect.top < viewport.bottom;
        if (!visible && !wasVisible) return;
        if (!old) {
          filterAnimate(card, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }]);
        } else {
          const dx = old.rect.left - to.left, dy = old.rect.top - to.top;
          if (Math.abs(dx) + Math.abs(dy) > .5 || Number(old.opacity) < 1)
            filterAnimate(card, [{ opacity: old.opacity, transform: `translate(${dx}px,${dy}px)` }, { opacity: 1, transform: 'none' }]);
        }
      });
    });
    boardSnapshots.set(board,snapshot);
  }

  // ---------- auth ----------
  function renderAuth(mode) {
    const inner = mode === 'change'
      ? `<h1 tabindex="-1">Set a new password</h1>
        <form novalidate onsubmit="return App.setPassword(event)">
          ${field('Current temporary password', `<input class="ctl" type="password" name="cur" autocomplete="current-password" autofocus>`)}
          ${field('New password', `<input class="ctl" type="password" name="pw" autocomplete="new-password">`)}
          ${field('Confirm', `<input class="ctl" type="password" name="pw2">`)}
          <div class="modal-actions"><button class="btn danger" type="button" onclick="App.logout()">Sign out</button><button class="btn primary" type="submit">Save password</button></div>
        </form>`
      : `<h1 tabindex="-1">Sign in</h1>
        <form novalidate onsubmit="return App.login(event)">
          ${field('Username', `<input class="ctl mono" name="username" maxlength="32" autocomplete="username" autofocus>`)}
          ${field('Password', `<input class="ctl" type="password" name="password" autocomplete="current-password">`)}
          <div class="modal-actions"><button class="btn primary" type="submit" style="width:100%;justify-content:center">Sign in</button></div>
        </form>`;
    return `<main class="auth-wrap" id="main" tabindex="-1"><div class="auth-card">
      <div class="logo" role="img" aria-label="oneloop">${I.logo}<span>${I.wordmark}</span></div>${window.Recovery?.expired?'<p class="auth-notice">Your session ended. Sign in to continue.</p>':''}${inner}</div></main>`;
  }

  // ---------- shared descriptions ----------
  const expandedDescriptions = new Set();
  let descriptionObserver,descriptionResizeFrame=0;
  function sizeDescription(animated = false) {
    document.querySelectorAll('.expandable-description').forEach(section=>{
      const input=section.querySelector('.description-content, textarea'),toggle=section.querySelector('.description-toggle');
      const before=input.getBoundingClientRect().height,scrollTop=input.scrollTop;
      uiAnimations.get(input)?.cancel();
      const expanded=expandedDescriptions.has(section.dataset.descriptionKey);
      input.style.overflowY='hidden';input.style.height='0px';
      const fullHeight=Math.max(input.tagName==='TEXTAREA'?96:0,input.scrollHeight+(input.tagName==='TEXTAREA'?2:0));
      const expandedLimit=Math.max(240,Math.round(innerHeight*.8));
      input.style.height=Math.min(fullHeight,expanded?expandedLimit:240)+'px';
      input.style.overflowY=expanded?'auto':'hidden';input.scrollTop=expanded?scrollTop:0;
      toggle.hidden=fullHeight<=240;section.classList.toggle('is-collapsed',fullHeight>240&&!expanded);
      toggle.textContent=expanded?'Show less':'Show more';toggle.setAttribute('aria-expanded',String(expanded));
      if(input.tagName!=='TEXTAREA'){if(fullHeight>240&&(!expanded||fullHeight>expandedLimit))input.setAttribute('tabindex','0');else input.removeAttribute('tabindex');}
      if(animated)animateHeight(input,before);
    });
  }
  function sizeDescriptionEditors() {
    document.querySelectorAll('[data-description-editor]').forEach(input=>{
      const scrollTop=input.scrollTop;input.style.overflowY='hidden';input.style.height='0px';
      input.style.height=Math.min(Math.max(96,input.scrollHeight+2),Math.max(96,Math.min(320,Math.round(innerHeight*.4))))+'px';
      input.style.overflowY='auto';input.scrollTop=scrollTop;
    });
  }
  function descriptionEditorHtml(value,limit,placeholder) {
    return `<textarea class="ctl description-editor" name="desc" data-description-editor maxlength="${limit}" ${placeholder?`placeholder="${esc(placeholder)}"`:''} oninput="App.sizeDescriptionEditors()">${esc(value||'')}</textarea>`;
  }
  function descriptionReadHtml(value,key) {
    return `<section class="peek-description expandable-description" data-description-key="${esc(key)}"><h3>Description</h3><div class="description-preview"><div class="description-content" id="${esc(key)}" role="group" aria-label="Epic description">${esc(value)}</div></div><button type="button" class="description-toggle" aria-controls="${esc(key)}" aria-expanded="false" onclick="App.toggleDescription(this)" hidden>Show more</button></section>`;
  }
  function sizeTaskTitle() {
    const input = document.querySelector('.tp-title');
    if (!input) return;
    input.style.height = '0px';
    input.style.height = (input.scrollHeight + 1) + 'px';
  }
  function mountDescription() {
    cancelAnimationFrame(descriptionResizeFrame);descriptionResizeFrame=0;
    sizeTaskTitle();descriptionObserver?.disconnect();sizeDescription();sizeDescriptionEditors();
    if(typeof ResizeObserver!=='undefined'){
      const widths=new WeakMap();
      descriptionObserver=new ResizeObserver(entries=>{
        let changed=false;for(const {target} of entries){if(widths.get(target)!==target.clientWidth){widths.set(target,target.clientWidth);changed=true;}}
        if(changed){cancelAnimationFrame(descriptionResizeFrame);descriptionResizeFrame=requestAnimationFrame(()=>{descriptionResizeFrame=0;sizeDescription();sizeDescriptionEditors();sizeTaskTitle();});}
      });
      document.querySelectorAll('.expandable-description,[data-description-editor]').forEach(el=>{widths.set(el,el.clientWidth);descriptionObserver.observe(el);});
    }
  }

  function currentBrowserSession() {
    if (!D.session) return null;
    D.browserSessions ||= [];
    let current = D.browserSessions.find(item => item.id === D.session.id && item.userId === D.session.userId && item.revokedAt == null);
    if (!current && !D.session.id) {
      current = { id:uid('web'), userId:D.session.userId, device:'This browser', browser:null, ip:null, createdAt:Date.now(), lastActiveAt:Date.now() };
      D.session.id = current.id; D.browserSessions.push(current);
    }
    return current;
  }
  function revokeAccountAccess(userId, keepSessionId = null, revokeApps = true) {
    const now = Date.now();
    (D.browserSessions || []).forEach(item => { if (item.userId === userId && item.id !== keepSessionId && item.revokedAt == null) item.revokedAt = now; });
    if (revokeApps) (D.appGrants || []).forEach(item => { if (item.userId === userId && item.revokedAt == null) item.revokedAt = now; });
  }
  function renderProfileAccess() {
    const current = currentBrowserSession(), userId = me().id;
    const sessions = (D.browserSessions || []).filter(item => item.userId === userId && (window.Recovery ? Recovery.sessionActive(item) : item.revokedAt == null)).sort((a,b) => Number(b.id === current?.id) - Number(a.id === current?.id) || b.lastActiveAt - a.lastActiveAt);
    const grants = (D.appGrants || []).filter(item => item.userId === userId && item.revokedAt == null && (!item.expiresAt || item.expiresAt > Date.now())).sort((a,b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    const fact = (label,value) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
    const date = value => value ? formatInstant(value) : 'Unavailable';
    const permissions = { read:'Read', manage_roadmap:'Manage Roadmap', manage_board:'Manage Board' };
    const sessionRows = sessions.map(item => `<div class="access-session-row" data-session-id="${esc(item.id)}">
      <div class="access-session-main"><div class="access-session-title">${esc(item.device || 'Unknown device')}${item.id === current?.id ? '<span class="current-session">Current</span>' : ''}</div>
      ${item.browser ? `<div class="access-session-sub">${esc(item.browser)}</div>` : ''}
      <dl class="access-session-facts">${fact('IP address',item.ip || 'Unavailable')}${fact('Last active',item.id === current?.id ? 'Now' : item.lastActiveAt ? date(item.lastActiveAt) : 'Never')}</dl></div>
      ${item.id !== current?.id ? `<button class="btn quiet danger" type="button" aria-label="Revoke ${esc(item.device)} session" onclick="App.revokeSession('${UIArg(item.id)}')">Revoke</button>` : ''}</div>`).join('');
    const appRows = grants.map(item => `<div class="access-session-row" data-grant-id="${esc(item.id)}"><div class="access-session-main">
      <div class="access-session-title">${esc(item.clientName)}<span class="access-client-type">${esc(item.protocol)}</span></div>
      <div class="app-access-scopes">${(item.access || []).map(grant => `<div><span class="access-project">${esc(visibleProjects().find(p=>p.id===grant.projectId)?.name || 'Unavailable project')}</span><span>${esc(grant.permissions.map(permission=>permissions[permission] || permission).join(' · '))}</span></div>`).join('')}</div>
      <dl class="access-session-facts">${fact('Last used',item.lastUsedAt ? date(item.lastUsedAt) : 'Never')}${fact('Connected',date(item.authorizedAt))}${fact('Expires',item.expiresAt ? date(item.expiresAt) : 'No expiry')}</dl>
      </div><button type="button" class="btn quiet danger" aria-label="Revoke ${esc(item.clientName)} access" onclick="App.revokeAppAccess('${UIArg(item.id)}')">Revoke</button></div>`).join('');
    return `<section class="section"><div class="access-section-heading"><h2 tabindex="-1">Sessions</h2><button type="button" class="btn quiet danger" onclick="App.revokeOtherSessions()" ${sessions.some(item=>item.id!==current?.id) ? '' : 'disabled'}>Sign out other sessions</button></div><div class="access-session-list">${sessionRows || '<div class="access-empty">No active sessions</div>'}</div></section>
      <section class="section"><h2 tabindex="-1">Connected apps</h2><div class="access-session-list">${appRows || '<div class="access-empty">No connected apps</div>'}</div></section>`;
  }
  function refreshProfileAccess(status = {}) {
    const host = document.querySelector('.profile-access');
    if (!host) return;
    const hadFocus = host.contains(document.activeElement);
    const before=host.getBoundingClientRect().height;
    setHTML(host,renderProfileAccess() + (status.loading ? '<p class="access-note" role="status">Loading access…</p>' : status.error ? `<p class="access-note" role="alert">${esc(status.error)} <button type="button" class="btn quiet" onclick="App.retryProfileAccess()">Retry</button></p>` : ''));
    fadeContent(host);UIMotion.height(host,before);
    if (hadFocus) (host.querySelector('button:not(:disabled)') || host.querySelector('h2'))?.focus({preventScroll:true});
  }

  function renderProfile() {
    const u = me();
    return `<div class="settings">
      <div class="section">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
          ${avatarHtml(u.id, 56)}
          <div style="display:flex;gap:8px">
            <input type="file" id="avIn" accept="image/*" style="display:none" onchange="App.setAvatar(this)">
            <button class="btn" onclick="document.getElementById('avIn').click()">${u.avatar ? 'Change avatar' : 'Upload avatar'}</button>
            ${u.avatar ? '<button class="btn" onclick="App.removeAvatar()">Remove</button>' : ''}
          </div>
        </div>
        ${field('Username', `<input class="ctl mono" value="${esc(userHandle(u))}" disabled>`)}
        ${field('Full name', `<input class="ctl" name="name" value="${esc(u.name)}" maxlength="80" onblur="App.updMe(this.value)" onkeydown="if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229&&!event.repeat){event.preventDefault();this.blur()}">`)}
      </div>
      <div class="section">
        <h2>Password</h2>
        <form novalidate onsubmit="return App.changePassword(event)">
          ${field('Current password', `<input class="ctl" type="password" name="cur" autocomplete="current-password">`)}
          <div class="field-row">
            ${field('New password', `<input class="ctl" type="password" name="pw" autocomplete="new-password">`)}
            ${field('Confirm', `<input class="ctl" type="password" name="pw2" autocomplete="new-password">`)}
          </div>
          <div class="modal-actions" style="justify-content:flex-start;margin-top:4px"><button class="btn primary" type="submit">Change password</button></div>
        </form>
      </div>
      <div class="profile-access">${renderProfileAccess()}</div>
    </div>`;
  }

  let taskSaveFeedback = null, taskSaveTimer;
  function clearTaskSaved() {
    clearTimeout(taskSaveTimer);taskSaveFeedback=null;
    const status=document.querySelector('.task-save-status');if(status)status.textContent='';
  }
  function taskSaved(id) {
    if(state.view!=='task'||state.taskId!==id)return;
    clearTimeout(taskSaveTimer);taskSaveFeedback={id,owner:me()?.id};
    const status=document.querySelector('.task-save-status');if(status)status.textContent='Saved';
    taskSaveTimer=setTimeout(clearTaskSaved,3000);
  }
  function taskSaving(id, token) {
    if(state.view!=='task'||state.taskId!==id)return;
    clearTimeout(taskSaveTimer);taskSaveFeedback={id,owner:me()?.id,token,saving:true};
    const status=document.querySelector('.task-save-status');if(status)status.textContent='Saving…';
  }
  function clearTaskSaving(token) {
    if(!taskSaveFeedback?.saving||taskSaveFeedback.token!==token)return;
    clearTaskSaved();
  }

  function documentTitle() {
    if(!D.session||!me()?.active||me()?.mustChange)return 'oneloop';
    if(window.Recovery?.pageError||['forbidden','notfound','no-projects'].includes(state.view))return 'oneloop';
    const names={board:'Board',roadmap:'Roadmap',knowledge:'Knowledge base',inbox:'Inbox',profile:'Profile',users:'Users',settings:'Settings',storage:'Storage'};
    if(state.view==='task'){
      const task=taskById(state.taskId);
      if(!task||!canReadTask(task))return 'oneloop';
      return `${task.id} · ${task.title} · oneloop`;
    }
    const label=names[state.view];if(!label)return 'oneloop';
    const p=['board','roadmap','knowledge','settings'].includes(state.view)?project():null;
    return `${label}${p&&canReadProject(p.id)?` · ${p.name}`:''} · oneloop`;
  }
  function updateDocumentTitle(){const title=documentTitle();if(document.title!==title)document.title=title;}
  function awaitingServerTask() {
    return !!(window.OneloopTransport && (state.view === 'notfound'||state.view==='task'&&taskById(state.taskId)?.detailsLoaded===false) && state.taskId &&
      location.hash.startsWith('#/task/') && !['403','404','deleted'].includes(window.Recovery?.pageError));
  }

  // ---------- task page ----------
  function taskActivityHtml(task){
    const feed=taskFeedHtml(task,canBoard()),state=collaboration?.taskFeedState?.(task.id);
    const retry=`<button class="btn quiet" onclick="App.retryTaskActivity('${UIArg(task.id)}')">Retry</button>`;
    if(!feed)return state?.error?`<div class="access-note" role="alert">Could not load activity. ${retry}</div>`:state?.loaded===false?'<div class="access-note" role="status">Loading activity…</div>':'<div class="access-note">No activity yet</div>';
    return state?.error?`<div class="access-note" role="alert">Could not refresh activity. ${retry}</div>${feed}`:feed;
  }
  const feedRowMarkup = new WeakMap();
  function refreshTaskActivity(id,preserveComments=true) {
    if(state.view!=='task'||state.taskId!==id)return;
    updateDocumentTitle();
    const timeline=document.querySelector('.task-page .timeline');if(!timeline)return;
    const active=document.activeElement,before=timeline.getBoundingClientRect().height,rows=UIMotion.rows(timeline,'[data-feed-key]','data-feed-key'),existing=new Map([...timeline.children].filter(el=>el.dataset.feedKey).map(el=>[el.dataset.feedKey,el])),timelineRect=timeline.getBoundingClientRect();
    const template=document.createElement('template');setHTML(template,taskActivityHtml(taskById(id)));
    const next=[...template.content.children],wanted=new Set(next.map(el=>el.dataset.feedKey).filter(Boolean));
    const focusedKey=active?.closest?.('[data-feed-key]')?.dataset.feedKey;
    const focusedControl=active?.matches?.('button')?{comment:active.closest('[data-comment]')?.dataset.comment,replyRoot:active.dataset.replyRoot,action:active.getAttribute('aria-label'),className:active.className}:null;
    const changed=[];
    const children=next.map(el=>{const old=existing.get(el.dataset.feedKey),markup=el.outerHTML;if(old&&((preserveComments&&old.classList.contains('comment-conversation'))||feedRowMarkup.get(old)===markup))return old;feedRowMarkup.set(el,markup);if(old)changed.push(el);return el;});
    const exiting=document.createElement('div');exiting.inert=true;exiting.setAttribute('aria-hidden','true');Object.assign(exiting.style,{position:'absolute',inset:'0',height:before+'px',pointerEvents:'none'});
    const viewport=timeline.closest('.content')?.getBoundingClientRect(),removed=[...existing.keys()].filter(key=>!wanted.has(key)).length;
    if(removed<=20&&!UIMotion.reduced())existing.forEach((el,key)=>{const rect=rows.get(key);if(wanted.has(key)||!rect?.height||viewport&&(rect.bottom<viewport.top||rect.top>viewport.bottom))return;const ghost=el.cloneNode(true);[ghost,...ghost.querySelectorAll('*')].forEach(node=>[...node.attributes].forEach(attr=>{if(attr.name==='id'||attr.name==='name'||attr.name==='tabindex'||attr.name.startsWith('on')||attr.name.startsWith('data-')||attr.name.startsWith('aria-'))node.removeAttribute(attr.name);}));Object.assign(ghost.style,{position:'absolute',top:rect.top-timelineRect.top+'px',left:rect.left-timelineRect.left+'px',width:rect.width+'px',height:rect.height+'px',margin:'0'});exiting.append(ghost);});
    timeline.style.position='relative';
    // Move only rows whose place changed. replaceChildren would detach every row, and browsers cancel a click whose pressed element left the document, even briefly.
    let cursor=timeline.firstChild;for(const child of children){if(child===cursor)cursor=cursor.nextSibling;else timeline.insertBefore(child,cursor);}while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
    if(children.length<=100)changed.forEach(el=>UIMotion.fade(el));if(exiting.children.length){timeline.append(exiting);const animation=UIMotion.animate(exiting,[{opacity:1},{opacity:0}],140);if(animation)animation.finished.then(()=>exiting.remove(),()=>exiting.remove());else exiting.remove();}
    if(active?.isConnected&&timeline.contains(active))active.focus({preventScroll:true});
    else if(focusedKey&&focusedControl){const row=[...timeline.querySelectorAll('[data-feed-key]')].find(el=>el.dataset.feedKey===focusedKey);const target=focusedControl.replyRoot?[...row?.querySelectorAll('[data-reply-root]')||[]].find(el=>el.dataset.replyRoot===focusedControl.replyRoot):focusedControl.comment?[...row?.querySelectorAll('[data-comment] button')||[]].find(el=>el.closest('[data-comment]')?.dataset.comment===focusedControl.comment&&el.getAttribute('aria-label')===focusedControl.action):[...row?.querySelectorAll('button')||[]].find(el=>el.className===focusedControl.className);target?.focus({preventScroll:true});}
    UIMotion.height(timeline,before);UIMotion.reflow(timeline,'[data-feed-key]','data-feed-key',rows);
  }

  function taskFeedHtml(t, canEdit) {
    if(collaboration)return Collab.feedHtml(t,state.activityLimits[t.id]||50);
    // one timeline: activity lines and comment blocks, oldest first
    const items = [...Activity.visible(t.activity).map((a) => ({ k: 'act', ...a })), ...(t.comments || []).map((c, i) => ({ k: 'cmt', i, ...c }))].sort((a, b) => a.ts - b.ts);
    const limit = state.activityLimits[t.id] || 50;
    return (items.length > limit ? `<button class="btn quiet" data-feed-key="load-older" onclick="App.loadOlderActivity('${UIArg(t.id)}')">Load older activity</button>` : '') + items.slice(-limit).map((it) => it.k === 'act'
      ? `<div class="tl-act">${avatarHtml(it.who, 16)}<span><b>${esc((userById(it.who) || { name: it.who }).name)}</b> ${esc(it.text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,''))}</span><span class="act-time">· ${ago(it.ts)}</span></div>`
      : `<div class="tl-cmt"><div class="cmt-head">${avatarHtml(it.who, 20)}<b>${esc((userById(it.who) || { name: it.who }).name)}</b><span class="act-time" title="${new Date(it.ts).toISOString()}">${ago(it.ts)}</span>
          ${canEdit && (it.who === me().id || isAdmin()) ? `<button type="button" class="row-x icon-button" aria-label="Delete comment" onclick="App.delComment('${UIArg(t.id)}',${it.i})">${I.close}</button>` : ''}</div>
          <div class="cmt-body">${esc(it.text)}</div></div>`).join('');

  }
  function renderTask() {
    const t = taskById(state.taskId);
    if (!t) { state.view = 'board'; return renderBoard(); }
    const canEdit = canBoard();
    const atts = window.Uploads?.renderAttachments(t,canEdit) || '';

    const feed = taskActivityHtml(t);

    const late = overdue(t);
    return `<div class="task-page"><div class="task-layout${t.block ? ' has-block' : ''}">
        <div class="task-title-field"><textarea class="tp-title" name="title" aria-label="Task title" rows="1" placeholder="Fix payment validation" required aria-required="true" maxlength="140" oninput="App.sizeTaskTitle()" onkeydown="if(event.key==='Enter' && !event.isComposing && event.keyCode!==229 && !event.repeat){event.preventDefault();this.blur()}" ${canEdit ? `onblur="App.updTask('${UIArg(t.id)}','title',this.value)"` : 'disabled'}>${esc(t.title)}</textarea></div>
      ${t.block ? `<section class="task-block" data-block-id="${esc(t.block.id)}" tabindex="-1" aria-label="Task blocked"><div class="task-block-heading"><strong>${I.blocked}Blocked</strong>${canEdit ? `<button class="btn unblock-action" onclick="App.openModal('unblock','${UIArg(t.id)}')">Unblock task</button>` : ''}</div><p>${collaboration?.blockText(t.block) || esc(t.block.reason)}</p><div class="task-block-footer"><small>${esc(userById(t.block.by)?.name || t.block.by)} · ${ago(t.block.at)}</small>${canEdit ? `<button class="btn block-edit-action" onclick="App.openModal('block','${UIArg(t.id)}')">Edit reason</button>` : ''}</div></section>` : ''}
      <aside class="tp-rail" aria-labelledby="task-properties-heading">
        <div class="task-properties-heading"><h2 id="task-properties-heading">Properties</h2>${canEdit && t.state !== 'done' && !t.block ? `<button class="btn block-task-action" onclick="App.openModal('block','${UIArg(t.id)}')">${I.blocked}Block task</button>` : ''}</div>
        <dl class="task-properties">
          <div class="task-property"><dt>Status</dt><dd>${selectHtml('tpState', { label: 'Status', cls: 'prop', disabled: !canEdit, icon: stIcon(t.state), value: t.state, options: Object.entries(STATUS).map(([v, l]) => ({ v, l, icon: stIcon(v) })), pick: (v) => App.updTask(t.id, 'state', v) })}</dd></div>
          <div class="task-property"><dt>Epic</dt><dd>${selectHtml('tpEpic', { label: 'Epic', cls: 'prop', disabled: !canEdit, icon: I.roadmap, value: t.epicId, search: true, options: epics().filter(e => e.state !== 'done' || e.id === t.epicId).slice().sort((a, b) => d(a.start) - d(b.start)).map((e) => ({ v: e.id, l: e.title })), pick: (v) => App.updTask(t.id, 'epicId', v) })}</dd></div>
          <div class="task-property"><dt>Assignees</dt><dd>${msHtml('tpAssign', t.id, !canEdit)}</dd></div>
          <div class="task-property task-property-date prop-row${late ? ' late' : ''}"><dt>Deadline</dt><dd>${dateHtml('tpDl', { hideLabel: true, cls: 'prop', disabled: !canEdit, icon: I.clock, name: '_dl', value: t.deadline || '', clearable: true, pick: (v) => App.updTask(t.id, 'deadline', v) })}<span class="task-overdue" ${late ? '' : 'hidden'}>Overdue</span></dd></div>
          <div class="task-property"><dt>Created at</dt><dd>${Number.isFinite(t.created)?`<time class="task-created-at" datetime="${new Date(t.created).toISOString()}" title="${formatInstant(t.created)}">${formatInstant(t.created)}</time>`:'<span class="task-created-at">Unavailable</span>'}</dd></div>
        </dl>
      </aside>
      <div class="tp-main">
        <div class="tp-sec task-description expandable-description" data-task="${esc(t.id)}" data-description-key="task-${esc(t.id)}"><h2 id="task-description-label">Description</h2>
          <div class="description-preview"><textarea id="task-description" class="ctl" aria-labelledby="task-description-label" placeholder="${canEdit ? 'Add a description…' : 'No description'}" aria-required="false" maxlength="4000" onfocus="App.expandDescription()" oninput="App.sizeDescription()" ${canEdit ? `onblur="App.updTask('${UIArg(t.id)}','desc',this.value)"` : 'disabled'}>${esc(t.desc || '')}</textarea></div>
          <button type="button" class="description-toggle" aria-controls="task-description" aria-expanded="false" onclick="App.toggleDescription()" hidden>Show more</button></div>
        <div class="tp-sec task-attachments">${window.Uploads?.attachmentHeader(t,canEdit) || '<h2>Attachments</h2>'}
          ${canEdit ? `<input type="file" id="attIn" multiple style="display:none" onchange="App.attachFiles('${UIArg(t.id)}',this)">` : ''}
          ${atts}<div class="upload-list"></div></div>
        <div class="tp-sec task-activity"><h2>Activity</h2>
          <div class="timeline">${feed}</div>
          <div class="comment-composer-home">${collaboration?.composerHtml(t) || ''}</div></div>
      </div>
    </div></div>`;
  }

  function msHtml(key, taskId, disabled) {
    return multiHtml(key, {
      label: 'Assignees',
      cls: 'prop',
      disabled,
      icon: () => { const a = (taskById(taskId)?.assignees || []).filter(userById); return a.length ? `<span class="avs">${a.slice(0, 3).map((x) => avatarHtml(x, 16)).join('')}</span>` : I.person; },
      options: projectMembers().map((u) => ({ v: u.id, l: u.name, sub: userHandle(u) })),
      values: () => taskById(taskId)?.assignees || [],
      toggle: (v) => { clearTaskSaved();if (!App.require('manage_board') || window.Recovery&&!Recovery.ensureOnline()) return; const t = taskById(taskId); if(!t){App.toast('This task is no longer available','error');return;} if(!(t.assignees||[]).includes(v)&&!projectMembers().some(u=>u.id===v)){App.toast('This person is no longer a project member','error');return;} t.assignees = t.assignees || []; const i = t.assignees.indexOf(v); if(bootWindow.OneloopRuntime){const assigneeIds=i===-1?[...t.assignees,v]:t.assignees.filter(id=>id!==v);bootWindow.OneloopRuntime.invoke('task.assignees',{taskId:t.internalId||t.id,assigneeIds}).catch(bootWindow.OneloopRuntime.report);return;} if (i === -1) { t.assignees.push(v); logAct(t, `assigned ${v}`, {field:'assignee:'+v,before:false,after:true}); collaboration?.taskEvent(t,'assigned',[v]); } else { t.assignees.splice(i, 1); logAct(t, `unassigned ${v}`, {field:'assignee:'+v,before:true,after:false}); } taskSaved(taskId); },
      summary: () => { const a = taskById(taskId)?.assignees || []; return a.length ? a.map((x) => (userById(x) || { name: x }).name).join(', ') : 'Unassigned'; },
      onClose: () => render(),
    });
  }

  // ---------- settings ----------
  /** @type {{projectId:string|null,query:string,limit:number}} */
  let memberWindow = {projectId:null, query:'', limit:100};
  document.addEventListener('input', event => {
    const input=event.target;
    if(!(input instanceof HTMLInputElement)||!input.matches('.settings-wide [data-member-search]'))return;
    memberWindow.query=input.value;memberWindow.limit=100;App.refreshUsers();
  });
  document.addEventListener('click', event => {
    if(!(event.target instanceof Element)||!event.target.closest('.settings-wide [data-more-members]'))return;
    memberWindow.limit+=100;App.refreshUsers();
  });
  function renderSettings() {
    const p = project();
    if(memberWindow.projectId!==p.id)memberWindow={projectId:p.id,query:'',limit:100};
    const members = (p.members || []).map((raw) => ({
      record: typeof raw === 'string' ? { userId: raw, permissions: [] } : raw,
      user: userById(typeof raw === 'string' ? raw : raw.userId),
    })).filter((x) => x.user);
    const memberIds = new Set((p.members || []).map((/** @type {any} */ raw) => typeof raw === 'string' ? raw : raw.userId));
    const candidates = D.users.filter((u) => u.active && !memberIds.has(u.id));
    const query=memberWindow.query.toLowerCase();
    const matching=members.filter((/** @type {{user:any}} */ {user})=>!query||`${user.name} ${userHandle(user)}`.toLowerCase().includes(query));
    return `<div class="settings settings-wide">
      <div class="section">
        <h2>Project</h2>
        <div class="project-fields">
          <div class="field-row">
            ${field('Name', `<input class="ctl" name="name" value="${esc(p.name)}" maxlength="60" onblur="App.updateProjectField(this)" onkeydown="if(event.key==='Enter' && !event.isComposing && event.keyCode!==229 && !event.repeat){event.preventDefault();App.updateProjectField(this);this.blur()}">`)}
            <div style="max-width:110px">${field('Task prefix', `<input class="ctl mono" name="key" value="${esc(p.key)}" maxlength="4" onblur="App.updateProjectField(this)" onkeydown="if(event.key==='Enter' && !event.isComposing && event.keyCode!==229 && !event.repeat){event.preventDefault();App.updateProjectField(this);this.blur()}">`)}</div>
          </div>
        </div>
      </div>
      <div class="section">
        <h2>Project access <span class="mono" style="font-size:var(--text-sm);color:var(--ink-ghost)">${members.length}</span></h2>
        <input id="member-search" class="ctl" type="search" aria-label="Search project members" placeholder="Search members" value="${esc(memberWindow.query)}" data-member-search>
        <div class="member-access-list" aria-busy="${UIEscape(!!D.adminUsers?.loading)}">
          ${matching.slice(0,memberWindow.limit).map(({ user: u, record: m }) => `
            <div class="member-access-row ${u.active ? '' : 'off'}">
              <div class="member-person">${avatarHtml(u.id, 24)}<span><b title="${esc(u.name)}">${esc(u.name)}</b><small class="mono">${esc(userHandle(u))}</small></span>${u.active ? '' : '<span class="tag-off">deactivated</span>'}</div>
              <div class="member-grants">
                ${u.admin ? '<span class="admin-access">Full access</span>' : `
                  <label class="permission-check"><input type="checkbox" aria-label="${esc(u.name)}: manage Roadmap" ${(m.permissions || []).includes('manage_roadmap') ? 'checked' : ''} onchange="App.setMemberPermission('${UIArg(u.id)}','manage_roadmap',this.checked,this)"><span><b>Roadmap</b></span></label>
                  <label class="permission-check"><input type="checkbox" aria-label="${esc(u.name)}: manage Board" ${(m.permissions || []).includes('manage_board') ? 'checked' : ''} onchange="App.setMemberPermission('${UIArg(u.id)}','manage_board',this.checked,this)"><span><b>Board</b></span></label>`}
              </div>
              <button class="row-x icon-button" type="button" title="Remove from project" aria-label="Remove ${esc(u.name)} from project" onclick="App.removeMember('${UIArg(u.id)}')">${I.close}</button>
            </div>`).join('') || `<div class="empty-note" style="border:0;text-align:left;padding:4px 0">${query?'No matching members':'No members yet'}</div>`}
        </div>
        ${matching.length>memberWindow.limit?'<button type="button" class="btn quiet" data-more-members>Load more members</button>':''}
        <div style="margin-top:12px;width:260px">${D.adminUsers?.loading&&!D.adminUsers?.loaded ? '<span class="access-note" role="status">Loading users…</span>' : candidates.length
          ? selectHtml('addMember', { label:'Add member', value: '', placeholder: 'Add member…', search: true, options: candidates.map((u) => ({ v: u.id, l: `${u.name} · ${userHandle(u)}` })), pick: (v) => App.addMember(v) })
          : D.adminUsers?.nextCursor ? '' : '<div class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">No users to add</div>'}</div>
        ${D.adminUsers?.nextCursor ? `<button type="button" class="btn quiet" data-more-users onclick="App.loadMoreUsers()" ${D.adminUsers.loading?'disabled':''}>Load more users</button>` : ''}
        ${D.adminUsers?.error ? `<p class="access-note" role="alert">${esc(D.adminUsers.error)} <button type="button" class="btn quiet" onclick="App.retryUsers()">Retry</button></p>` : ''}
      </div>
      ${window.OneloopKnowledge?.settingsHtml(p.id) || ''}
      <div class="section" style="border-color:color-mix(in srgb,var(--err) 25%,transparent)">
        <h2 style="color:var(--err)">Danger zone</h2>
        <button class="btn danger" onclick="App.deleteProject()">Delete project</button>
      </div>
    </div>`;
  }

  function usersCountLabel() {
    if(window.OneloopTransport&&!D.adminUsers?.loaded)return D.adminUsers?.loading?'…':'';
    return String(D.adminUsers?.loaded?D.adminUsers.ids.length:D.users.length);
  }
  function renderUsers() {
    const awaiting = D.adminUsers?.loading && !D.adminUsers.loaded;
    const listed=awaiting?[]:D.adminUsers?.loaded?D.adminUsers.ids.map(userById).filter(Boolean):D.users.slice(0,state.usersLimit);
    const hasMore=D.adminUsers?.loaded?!!D.adminUsers.nextCursor:D.users.length>state.usersLimit;
    return `<div class="settings">
      <div class="section">
        ${awaiting ? '<p class="access-note" role="status">Loading users…</p>' : D.adminUsers?.error ? `<p class="access-note" role="alert">${esc(D.adminUsers.error)} <button type="button" class="btn quiet" onclick="App.retryUsers()">Retry</button></p>` : ''}
        ${listed.map((u) => `
          <button type="button" class="user-row clickable ${u.active ? '' : 'off'}" data-user-id="${esc(u.id)}" onclick="App.openModal('user','${UIArg(u.id)}')">${avatarHtml(u.id, 22)}
            <span class="uname">${esc(u.name)}</span><span class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">${esc(userHandle(u))}</span>
            ${u.active ? '' : '<span class="tag-off">deactivated</span>'}
            ${u.mustChange ? '<span class="tag-off" style="color:var(--warn);border-color:color-mix(in srgb,var(--warn) 30%,transparent)">temporary password</span>' : ''}</button>`).join('')}${!awaiting && hasMore ? '<button class="btn quiet" onclick="App.loadMoreUsers()">Load more users</button>' : ''}
      </div>
    </div>`;
  }

  // ---------- peek ----------
  function sparkline(weekly) {
    const max = Math.max(1,...weekly);
    const bars = weekly.map((v, i) => {
      const h = Math.max(Math.round((v / max) * 24), 4);
      const fill = i >= weekly.length - 2 ? 'var(--run)' : 'rgb(var(--tone-rgb) / 0.14)';
      return `<rect x="${i * 13}" y="${26 - h}" width="9" height="${h}" rx="1.5" fill="${fill}"/>`;
    }).join('');
    return `<svg width="${weekly.length * 13 - 4}" height="26" viewBox="0 0 ${weekly.length * 13 - 4} 26">${bars}</svg>`;
  }

  function renderPeek() {
    const e = epicById(state.peek);
    if (!e) return '';
    const t = trackById(e.trackId);
    const ongoing = !e.end;
    const page=D.epicPageInfo?.[e.id];
    const eTasks = page?.loaded?page.taskIds.map(taskById).filter(Boolean):tasks().filter((x) => x.epicId === e.id);
    const order = { progress: 0, review: 1, planning: 2, done: 3 };
    eTasks.sort((a, b) => order[a.state] - order[b.state] || Number(a.id.slice(a.id.lastIndexOf('-')+1)) - Number(b.id.slice(b.id.lastIndexOf('-')+1)));
    const stateColor = { done: 'var(--ok)', review: 'var(--review)', progress: 'var(--run)', planning: 'var(--ink-faint)' };
    const stateBits = (x) => [stIcon(x.state), `<span style="color:${stateColor[x.state]}">${STATUS[x.state].toLowerCase()}</span>`];
    const rows = eTasks.map((x) => {
      const [dot, m] = stateBits(x);
      return `<div class="task-row">${dot}<span class="tid">${esc(x.id)}</span><span class="tt" title="${esc(x.title)}">${esc(x.title)}</span><span class="tm">${m}</span></div>`;
    }).join('') || '<div class="empty-note" style="margin:14px 0">no tasks yet</div>';

    const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;
    const midBlock = ongoing && e.weekly
      ? `<div data-epic-throughput style="padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px">${sparkline(e.weekly)}
          <div><div class="mono" style="font-size:var(--text-xs);color:var(--ink-soft)">${e.closedThisWeek} closed this week</div>
          <div class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">${e.completedSinceStart ?? e.done} since ${humanShort(d(e.start))} · ${e.open ?? e.total - e.done} open</div></div></div>`
      : e.total ? `<div style="padding:16px 20px;border-bottom:1px solid var(--line)">
          <div style="position:relative;height:6px;background:rgb(var(--tone-rgb) / 0.07);border-radius:3px;overflow:hidden"><div style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:${e.state === 'done' ? 'var(--ok)' : 'var(--run)'}"></div></div>
          <div class="mono" style="font-size:var(--text-xs);color:var(--ink-faint);margin-top:8px">${e.done} of ${e.total} tasks complete · ${pct}%</div></div>` : '';

    return `<div class="scrim" onclick="App.closeOverlays()"></div>
    <aside class="peek" role="dialog" aria-modal="true" aria-labelledby="peek-title">
      <div class="peek-head">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span class="mono" style="font-size:var(--text-xs);letter-spacing:0.1em;color:var(--ink-ghost)">${esc(t ? t.name : '')}</span>
          <button type="button" class="btn icon" aria-label="Close epic" onclick="App.closeOverlays()">${I.close}</button>
        </div>
        <h2 id="peek-title" style="font-size:17px;font-weight:600;letter-spacing:-0.01em">${esc(e.title)}</h2>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="chip idle">${ongoing ? 'ongoing' : e.state}</span>
          <span class="mono" style="font-size:var(--text-xs);color:var(--ink-faint)">${humanShort(d(e.start))} → ${e.end ? humanShort(d(e.end)) : '<span style="color:var(--ink-soft)">no end date</span>'}</span>
        </div>
      </div>
      <div class="peek-body">
      ${midBlock}
      ${e.desc ? descriptionReadHtml(e.desc,'epic-description-'+e.id) : ''}
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px 10px">
        <div style="display:flex;align-items:baseline;gap:7px"><span style="font-size:var(--text-body);font-weight:600;color:var(--ink)">Tasks</span><span class="mono" data-epic-task-total style="font-size:var(--text-xs);color:var(--ink-ghost)">${page?.loaded?page.tasksTotal:eTasks.length}</span></div>
      </div>
      <div class="peek-rows">${rows}${page?.tasksCursor?`<button class="btn quiet" onclick="App.loadMoreEpicTasks('${UIArg(e.id)}')">Load more tasks</button>`:''}
        <div style="padding:14px 0 6px;font-size:var(--text-body);font-weight:600;color:var(--ink)">Activity</div>
        ${actFeed(e.activity, page?.loaded?Number.MAX_SAFE_INTEGER:8)}
        ${page?.activityCursor?`<button class="btn quiet" onclick="App.loadMoreEpicActivity('${UIArg(e.id)}')">Load older activity</button>`:''}
      </div>
      </div>
      <div class="peek-actions">
        ${canRoadmap() ? `${e.state === 'done'
          ? `<button class="btn" onclick="App.reopenEpic('${UIArg(e.id)}')">Reopen</button>`
          : `<button class="btn" onclick="App.closeEpic('${UIArg(e.id)}')">Mark as done</button>`}
        <button class="btn" onclick="App.openModal('epic','${UIArg(e.id)}')">Edit epic</button>
        <button class="btn danger" style="margin-left:auto" onclick="App.deleteEpic('${UIArg(e.id)}')">Delete</button>` : '<span class="access-note" style="margin:0">Read only</span>'}
      </div>
    </aside>`;
  }

  // ---------- modals ----------
  const optionalMark = '<span class="optional-mark">Optional</span>';
  const fieldPlaceholders = {
    Username: 'alex', 'Full name': 'First and last name',
    Password: 'Enter password', 'Current password': 'Current password',
    'New password': 'New password', Confirm: 'Repeat password',
    Name: 'Customer portal', 'Task prefix': 'APP',
    Description: 'Scope and outcome', Goal: 'Target outcome',
  };
  let fieldSequence = 0;
  function field(label, inner, optional = false) {
    let targetId = '';
    inner = inner.replace(/<(input|textarea)\b([^>]*)>/g, (match, tag, attrs) => {
      if (/\bdisabled\b|type="(?:hidden|file|checkbox)"/.test(attrs)) return match;
      if (!/\bplaceholder=/.test(attrs)) attrs += ` placeholder="${esc(fieldPlaceholders[label] || label)}"`;
      attrs = attrs.replace(/\srequired\b/g, '').replace(/\saria-required="[^"]*"/g, '');
      return `<${tag}${attrs}${optional ? ' aria-required="false"' : ' required aria-required="true"'}>`;
    });
    inner = inner.replace(/<(input|textarea|button)\b([^>]*)>/g, (match, tag, attrs) => {
      if (targetId || /type="(?:hidden|file|checkbox)"/.test(attrs)) return match;
      if (tag === 'button' && !/\bsel-btn\b/.test(attrs)) return match;
      targetId = /\bid="([^"]+)"/.exec(attrs)?.[1] || `field-${++fieldSequence}`;
      if(tag==='button'&&/\bsel-btn\b/.test(attrs)&&attrs.includes('aria-haspopup="listbox"')){
        const valueId=/id="([^"]+)" class="sel-label"/.exec(inner)?.[1];
        attrs=attrs.replace(/\saria-labelledby="[^"]*"/,'')+` aria-labelledby="${targetId}-label${valueId?' '+valueId:''}"`;
      }
      return `<${tag}${/\bid=/.test(attrs) ? attrs : `${attrs} id="${UIEscape(targetId)}"`}>`;
    });
    return `<div class="field" data-required="${UIEscape(!optional)}"><label${targetId ? ` id="${esc(targetId)}-label" for="${esc(targetId)}"` : ''}>${label}${optional ? optionalMark : ''}</label>${inner}</div>`;
  }

  const taskDestinationEpics = () => epics().filter(epic => epic.state !== 'done');

  function taskAssigneesHtml(m){
    m.assignees ||= [];
    const sync=()=>{const host=document.querySelector('.task-form-assignee-values');if(host)setHTML(host,m.assignees.map(id=>`<input type="hidden" name="assignees" value="${esc(id)}">`).join(''));};
    const select=multiHtml('mTaskAssignees',{label:'Assignees',search:true,icon:()=>I.person,options:projectMembers().map(u=>({v:u.id,l:u.name,sub:userHandle(u)})),values:()=>m.assignees,
      toggle:id=>{const index=m.assignees.indexOf(id);if(index<0)m.assignees.push(id);else m.assignees.splice(index,1);sync();},clear:()=>{m.assignees=[];sync();},summary:()=>m.assignees.length?m.assignees.map(id=>userById(id)?.name||id).join(', '):'Unassigned'});
    return `${select}<div class="task-form-assignee-values">${m.assignees.map(id=>`<input type="hidden" name="assignees" value="${esc(id)}">`).join('')}</div>`;
  }

  function taskModalHtml(m) {
    if(!taskDestinationEpics().length) return `<h2>New task</h2><div class="sub">No open epics are available.</div><div class="modal-actions"><button class="btn quiet" onclick="App.closeOverlays()">Cancel</button>${canRoadmap()?'<button class="btn primary" onclick="App.openModal(\'epic\')">Create epic</button>':''}</div>`;
    return `<h2>New task</h2>
      <form novalidate onsubmit="return App.saveTask(event)">
        ${field('Title', `<input class="ctl" name="title" placeholder="Fix payment validation" value="${esc(m.title || '')}" maxlength="140" required autofocus>`)}
        ${field('Epic', selectHtml('mEpic', { name: 'epicId', value: taskDestinationEpics().some((e) => e.id === m.epicId) ? m.epicId : '', placeholder: 'Choose an epic', options: taskDestinationEpics().slice().sort((a, b) => d(a.start) - d(b.start)).map((e) => ({ v: e.id, l: e.title })) }))}
        <div class="field-row">
          ${field('Assignees',taskAssigneesHtml(m),true)}
          ${field('Deadline',dateHtml('mTaskDeadline',{label:'Deadline',name:'deadline',value:'',clearable:true,placeholder:'Set deadline'}),true)}
        </div>
        ${field('Description', descriptionEditorHtml(m.desc||'',4000,'Scope and acceptance criteria'), true)}
        <div class="modal-actions"><button class="btn quiet" type="button" onclick="App.closeOverlays()">Cancel</button><button class="btn primary" type="submit">Create task</button></div>
      </form>`;
  }
  function poolRowHtml(p) {
    const writable=p.scope==='mine'?p.ownerId===me()?.id:canBoard();
    return `<div class="pool-row${canBoard()?' promotable':''}" data-pool-item="${UIEscape(p.id)}"><div class="pool-item-main"><div class="pool-item-copy">${canBoard()?`<button type="button" class="txt pool-promote" aria-label="Create task from ${esc(p.title)}" title="${esc(p.title)}" onclick="App.promotePool('${UIArg(p.id)}')">${esc(p.title)}</button>`:`<span class="txt">${esc(p.title)}</span>`}${p.desc?`<span class="pool-description-preview">${esc(p.desc)}</span>`:''}</div><span class="act">${writable||p.desc?`<button type="button" class="btn icon pool-note-toggle" aria-label="${writable?p.desc?'Edit description':'Add description':'View description'} for ${esc(p.title)}" title="${writable?p.desc?'Edit description':'Add description':'View description'}" aria-expanded="false" onclick="App.editPoolDescription(event,'${UIArg(p.id)}')">${I.note}</button>`:''}${canBoard()?`<button type="button" class="btn icon pool-promote-action" aria-label="Create task from ${esc(p.title)}" title="Create task" onclick="App.promotePool('${UIArg(p.id)}')">${I.arrow}</button>`:''}${writable?`<button type="button" class="btn icon pool-delete" aria-label="Delete ${esc(p.title)}" title="Delete item" onclick="App.delPool(event,'${UIArg(p.id)}')">${I.close}</button>`:''}</span></div></div>`;
  }
  function resetPoolCapture(){const capture=document.querySelector('.pool-capture');if(!capture)return;capture.classList.remove('is-expanded');const notes=capture.querySelector('#poolNewDesc');notes.value='';const content=capture.querySelector('.pool-capture-notes');content.inert=true;content.setAttribute('aria-hidden','true');const toggle=capture.querySelector('.pool-capture-toggle');toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Add description');toggle.title='Add description';setHTML(toggle,I.note);}

  function poolReadNotice(empty=false) {
    const page=D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`];
    if(page?.error)return `<div class="pool-read-status access-note" role="alert">Could not ${page.loaded?'refresh':'load'} items. <button class="btn quiet" onclick="App.retryPool()">Retry</button></div>`;
    if(!empty)return '';
    const pending=page?.loaded===false;
    return `<div class="empty-note"${pending?' role="status"':''}>${pending?'Loading items…':'No items'}</div>`;
  }
  function updatePool({ completeItemId } = {}) {
    updateDocumentTitle();
    const view = document.querySelector('.pool-view');
    if (!view) return;
    const list = view.querySelector('.pool-list');
    const listScroll = list.scrollTop;
    const tabChanged = list.dataset.poolScope && list.dataset.poolScope !== state.poolTab;
    const beforeRows = new Map([...list.querySelectorAll('[data-pool-item]')].map(el => [el.dataset.poolItem, el.getBoundingClientRect()]));
    const items = poolItems(state.poolTab);
    const ids = new Set(items.map((item) => item.id));
    list.querySelectorAll('[data-pool-item]').forEach((row) => { if (!ids.has(row.dataset.poolItem)) { if (!tabChanged) exitVisual(row); row.remove(); } });
    list.querySelector('.empty-note')?.remove();
    list.querySelector('.pool-read-status')?.remove();
    let cursor = list.firstElementChild;
    items.forEach((item) => {
      let row = list.querySelector(`[data-pool-item="${UIEscape(item.id)}"]`);
      if (row) {
        const editor=row.querySelector('.pool-description-editor');
        const editedHere = !!editor?.contains(document.activeElement);
        const template = document.createElement('template'); setHTML(template,poolRowHtml(item));
        const fresh = template.content.firstElementChild;
        const actions=element=>[...element.querySelectorAll('.act > button')].map(button=>button.className).join('|');
        const sameActions=row.className===fresh.className&&actions(row)===actions(fresh);
        row.className=fresh.className;
        if(sameActions)patchBoardRow(row.querySelector('.pool-item-main'),fresh.querySelector('.pool-item-main'));
        else row.querySelector('.pool-item-main')?.replaceWith(fresh.querySelector('.pool-item-main'));
        if(item.id===completeItemId){editor?.remove();if(editedHere)row.querySelector('.pool-note-toggle')?.focus({preventScroll:true});}
        else if(editor){
          row.querySelector('.pool-note-toggle')?.setAttribute('aria-expanded','true');
          const reader=editor.querySelector('.pool-note-read');if(reader){reader.textContent=item.desc||'';reader.setAttribute('aria-label',`Description for ${item.title}`);}
        }
      }
      if (!row) { const template = document.createElement('template'); setHTML(template,poolRowHtml(item)); row = template.content.firstElementChild; }
      if (row !== cursor) list.insertBefore(row, cursor);
      cursor = row.nextElementSibling;
    });
    if (!items.length) setHTML(list,poolReadNotice(true));
    else if(D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`]?.error){const note=document.createElement('template');setHTML(note,poolReadNotice());list.append(note.content);}
    list.querySelector('.pool-load-more')?.remove();
    const page=D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`];
    if(page?.nextCursor){const more=document.createElement('button');more.className='btn quiet pool-load-more';more.textContent='Load more';more.addEventListener('click',()=>App.loadMorePool());list.append(more);}
    view.querySelectorAll('[data-pool-tab]').forEach((button) => {
      const selected = button.dataset.poolTab === state.poolTab;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.querySelector('span').textContent = D.poolPageInfo?.[`${state.projectId}:${button.dataset.poolTab}`]?.total ?? poolItems(button.dataset.poolTab).length;
    });
    const input = view.querySelector('#poolAdd');
    input.hidden = state.poolTab === 'project' && !canBoard();
    view.querySelector('.pool-capture').hidden=input.hidden;
    if(tabChanged){input.value='';resetPoolCapture();view.querySelectorAll('.pool-description-editor').forEach(el=>el.remove());view.querySelectorAll('.pool-note-toggle').forEach(el=>el.setAttribute('aria-expanded','false'));}
    const mineTotal=D.poolPageInfo?.[`${state.projectId}:mine`]?.total,teamTotal=D.poolPageInfo?.[`${state.projectId}:project`]?.total;
    document.querySelectorAll('[data-pool-count]').forEach((el) => { el.textContent = Number.isFinite(mineTotal)&&Number.isFinite(teamTotal)?mineTotal+teamTotal:poolItems().length; });
    list.dataset.poolScope = state.poolTab;
    if (!tabChanged) list.scrollTop = listScroll;
    if (tabChanged) fadeContent(list);
    else list.querySelectorAll('[data-pool-item]').forEach(row => {
      const from = beforeRows.get(row.dataset.poolItem), to = row.getBoundingClientRect();
      if (!from) uiAnimate(row, [{ opacity:0,transform:'translateY(4px)' },{ opacity:1,transform:'none' }]);
      else if (Math.abs(from.top - to.top) > 1) uiAnimate(row, [{transform:`translateY(${from.top - to.top}px)`},{transform:'none'}]);
    });
  }

  function renderModal() {
    const m = state.modal;
    if (!m) return '';
    let body = '';
    if (['block','unblock','completeBlocked'].includes(m.type)) {
      const task=taskById(m.id),blocking=m.type==='block',complete=m.type==='completeBlocked';
      if(!task)return '';
      body=`<h2>${blocking ? task.block ? 'Edit block reason' : 'Block task' : complete ? 'Unblock and complete task?' : 'Unblock task'}</h2>
        ${!blocking ? `<p class="sub">${esc(task.block?.reason || '')}</p>` : ''}
        <form novalidate data-block-action onsubmit="return App.saveBlock(event,'${UIArg(task.id)}','${UIArg(m.type)}')">
          ${field(blocking?'Reason':'Resolution',blocking ? Collab.blockReasonHtml(task) : `<textarea class="ctl" name="reason" maxlength="500" placeholder="How was this resolved?" onkeydown="App.commentKey(event)"></textarea>`,!blocking)}
          <div class="modal-actions"><button type="button" class="btn quiet" onclick="App.closeOverlays()">Cancel</button><button class="btn primary">${blocking?'Save':complete?'Unblock and complete':'Unblock'}</button></div>
        </form>`;
    } else if (m.type === 'epic') {
      const e = m.id ? epicById(m.id) : null;
      body = `<h2>${e ? 'Edit epic' : 'New epic'}</h2>
      <form novalidate onsubmit="return App.saveEpic(event,'${UIArg(m.id || '')}')">
        ${field('Title', `<input class="ctl" name="title" placeholder="Payment integration" value="${esc(e ? e.title : '')}" maxlength="120" required autofocus>`)}
        ${field('Track', selectHtml('mTrack', { name: 'trackId', value: e ? e.trackId : (m.trackId || ''), placeholder: 'Choose a track', options: tracks().map((t) => ({ v: t.id, l: t.name })) }))}
        <div class="field-row">
          ${field('Start', dateHtml('mStart', { name: 'start', value: e ? e.start : iso(today), max: () => dateValue('mEnd'), maxError: 'Start date cannot be after the end date.' }))}
          ${field('End', dateHtml('mEnd', { name: 'end', value: (e && e.end) || '', clearable: true, min: () => dateValue('mStart'), minError: 'End date cannot be before the start date.', placeholder: 'No end date' }), true)}
        </div>
        ${field('Description', descriptionEditorHtml(e?.desc,2000), true)}
        <div class="modal-actions"><button class="btn quiet" type="button" onclick="App.closeOverlays()">Cancel</button><button class="btn primary" type="submit">${e ? 'Save' : 'Create epic'}</button></div>
      </form>`;
    } else if (m.type === 'milestone') {
      const ms = m.id ? D.milestones.find((x) => x.id === m.id) : null;
      body = `<h2>${ms ? 'Edit milestone' : 'New milestone'}</h2>
      <form novalidate onsubmit="return App.saveMilestone(event,'${UIArg(m.id || '')}')">
        ${field('Name', `<input class="ctl" name="name" placeholder="Public launch" value="${esc(ms ? ms.name : '')}" maxlength="60" required autofocus>`)}
        ${field('Date', dateHtml('mDate', { name: 'date', value: ms ? ms.date : iso(today) }))}
        ${field('Goal', descriptionEditorHtml(ms?.desc,500), true)}
        <div class="modal-actions">${ms ? `<button class="btn danger" type="button" style="margin-right:auto" onclick="App.deleteMilestone('${UIArg(ms.id)}')">Delete</button>` : ''}<button class="btn quiet" type="button" onclick="App.closeOverlays()">Cancel</button><button class="btn primary" type="submit">${ms ? 'Save' : 'Create milestone'}</button></div>
      </form>`;
    } else if (m.type === 'track') {
      const t = m.id ? trackById(m.id) : null;
      body = `<h2>${t ? 'Rename track' : 'New track'}</h2>
      <form novalidate onsubmit="return App.saveTrack(event,'${UIArg(m.id || '')}')">
        ${field('Name', `<input class="ctl" name="name" placeholder="Backend & API" value="${esc(t ? t.name : '')}" maxlength="60" required autofocus>`)}
        <div class="modal-actions"><button class="btn quiet" type="button" onclick="App.closeOverlays()">Cancel</button><button class="btn primary" type="submit">${t ? 'Save' : 'Create track'}</button></div>
      </form>`;
    } else if (m.type === 'task') {
      body = taskModalHtml(m);
    } else if (m.type === 'project') {
      body = `<h2>New project</h2>
      <form novalidate onsubmit="return App.saveProjectNew(event)">
        ${field('Name', `<input class="ctl" name="name" maxlength="60" required autofocus>`)}
        ${field('Task prefix', `<input class="ctl mono" name="key" placeholder="APP" maxlength="4">`)}
        <div class="modal-actions"><button class="btn quiet" type="button" onclick="App.closeOverlays()">Cancel</button><button class="btn primary" type="submit">Create project</button></div>
      </form>`;
    } else if (m.type === 'user') {
      const u = m.id ? userById(m.id) : null;
      const lastAdmin = u && u.admin && u.active && activeAdmins().length === 1;
      body = `<h2>${u ? 'Edit user' : 'New user'}</h2>
      <form novalidate onsubmit="return App.saveUser(event,'${UIArg(m.id || '')}')">
        ${field('Username', `<input class="ctl mono" name="username" value="${esc(u ? userHandle(u) : '')}" ${u ? 'disabled' : 'autofocus'} maxlength="32">`)}
        ${field('Full name', `<input class="ctl" name="name" value="${esc(u ? u.name : '')}" maxlength="80" ${u ? 'autofocus' : ''}>`)}
        <label class="check" style="margin-bottom:5px"><input type="checkbox" name="admin" ${u && u.admin ? 'checked' : ''} ${lastAdmin ? 'disabled' : ''}> Admin${lastAdmin ? ' <span class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">· last active admin</span>' : ''}</label>
        ${u ? `<label class="check" style="margin-bottom:14px"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} ${lastAdmin ? 'disabled' : ''}> Active</label>` : ''}
        <div class="modal-actions">
          ${u ? `<button class="btn" type="button" style="margin-right:auto" onclick="App.resetPassword('${UIArg(u.id)}')">Reset password</button>` : ''}
          <button class="btn quiet" type="button" onclick="App.closeOverlays()">Cancel</button>
          <button class="btn primary" type="submit">${u ? 'Save' : 'Create user'}</button>
        </div>
      </form>`;
    } else if (m.type === 'temppw') {
      const user=userById(m.id),account=user?.username||user?.name||'Account';
      body = `<h2>Temporary password</h2>
      <div class="temporary-password-meta"><strong>${esc(account)}</strong><span>Shown once</span></div>
      <div class="pw-box"><span class="mono" id="tmpPw">${esc(m.pw)}</span><button class="btn" type="button" aria-label="Copy temporary password" onclick="App.copyTemporaryPassword()">Copy</button></div>
      <div class="modal-actions"><button class="btn primary" onclick="App.closeOverlays()">Done</button></div>`;
    } else if (m.type === 'pool') {
      const mine = poolItems('mine'), proj = poolItems('project');
      const pl = state.poolTab === 'mine' ? mine : proj;
      const canWritePool = state.poolTab === 'mine' || canBoard();
      const rows = pl.length?pl.map(poolRowHtml).join('')+poolReadNotice():poolReadNotice(true);
      body = `<div class="pool-view"><div class="pool-head"><h2>Pool</h2>
        <div class="seg" style="margin-left:auto">
          <button type="button" class="${state.poolTab === 'mine' ? 'on' : ''}" data-pool-tab="mine" aria-pressed="${state.poolTab === 'mine'}" onclick="App.setPoolTab('mine')">My <span class="mono" style="font-size:var(--text-xs);opacity:.7">${D.poolPageInfo?.[`${state.projectId}:mine`]?.total ?? mine.length}</span></button>
          <button type="button" class="${state.poolTab === 'project' ? 'on' : ''}" data-pool-tab="project" aria-pressed="${state.poolTab === 'project'}" onclick="App.setPoolTab('project')">Team <span class="mono" style="font-size:var(--text-xs);opacity:.7">${D.poolPageInfo?.[`${state.projectId}:project`]?.total ?? proj.length}</span></button>
        </div>
        <button type="button" class="btn icon" aria-label="Close pool" title="Close pool" onclick="App.closeOverlays()">${I.close}</button>
      </div>
      <div class="pool-capture" ${canWritePool?'':'hidden'}><div class="pool-capture-title"><input id="poolAdd" class="ctl" placeholder="Add an item" aria-label="Add pool item" maxlength="140" ${canWritePool?'':'hidden'} onkeydown="App.poolKey(event)"><button type="button" class="btn icon pool-capture-toggle" aria-label="Add description" title="Add description" aria-expanded="false" aria-controls="pool-capture-notes" onclick="App.togglePoolDescription()">${I.note}</button></div><div class="pool-capture-notes" id="pool-capture-notes" aria-hidden="true" inert><div><label for="poolNewDesc">Description ${optionalMark}</label><textarea id="poolNewDesc" class="ctl" maxlength="2000" placeholder="A little context for later…" onkeydown="App.poolDescriptionKey(event)"></textarea><div class="pool-description-actions"><button type="button" class="btn primary" onclick="App.addPoolItem()">Add item</button></div></div></div></div>
      <div class="pool-list" data-pool-scope="${UIEscape(state.poolTab)}">${rows}${D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`]?.nextCursor?'<button class="btn quiet pool-load-more" onclick="App.loadMorePool()">Load more</button>':''}</div></div>`;
    } else if (m.type === 'knowledge') {
      body = window.OneloopKnowledge?.modalHtml() || '';
    } else if (m.type === 'confirm') {
      body = `<h2>${esc(m.title)}</h2><div class="sub">${m.text}</div>
      <div class="modal-actions"><button class="btn quiet" onclick="App.closeOverlays()">Cancel</button>${m.blocked ? '' : `<button class="btn danger" onclick="App.confirmYes()">${esc(m.action)}</button>`}</div>`;
    }
    body = body.replace('<h2', '<h2 id="modal-title"');
    return `<div class="scrim" onclick="App.closeOverlays()"></div><div class="modal-wrap"><div class="modal${m.type === 'pool' ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" onclick="event.stopPropagation()">${body}</div></div>`;
  }

  function renderMenu() {
    const m = state.menu;
    if (!m) return '';
    const themeControl = () => `<div class="seg theme-options" role="group" aria-label="Theme">${['light', 'dark'].map((theme) => `<button type="button" data-theme-option="${UIEscape(theme)}" class="${window.Theme.current === theme ? 'on' : ''}" aria-pressed="${window.Theme.current === theme}" onclick="App.setTheme('${UIArg(theme)}')"><span class="menu-icon" aria-hidden="true">${theme === 'light' ? I.sun : I.moon}</span>${theme === 'light' ? 'Light' : 'Dark'}</button>`).join('')}</div>`;
    const items = m.items.map((it) => it.theme ? themeControl() : it.sep ? '<div class="sep"></div>' : it.projectId ? `<button type="button" class="project-option${it.projectId===state.projectId?' selected':''}" aria-current="${it.projectId===state.projectId}" title="${esc(it.projectName)}" onclick="App.menuAction(${it.i})"><span class="project-option-avatar" aria-hidden="true">${esc(it.projectName.slice(0,1).toUpperCase())}</span><span class="project-option-name">${esc(it.projectName)}</span><span class="project-option-check" aria-hidden="true">${it.projectId===state.projectId?I.tick:''}</span></button>` :
      `<button class="${it.danger ? 'danger' : ''}" onclick="App.menuAction(${it.i})">${it.icon ? `<span class="menu-icon" aria-hidden="true">${it.icon}</span>` : ''}${it.label}</button>`).join('');
    return `<div class="scrim menu-scrim" style="background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none" onclick="App.closeOverlays()"></div>
      <div ${m.projectMenu?'id="project-switcher-menu" role="group" aria-label="Projects"':'id="action-menu"'} class="menu${m.version ? ' profile-menu' : m.projectMenu ? ' project-menu' : m.commentId||m.taskActions ? ' comment-menu' : ''}" style="left:${m.x}px;top:${m.y}px">${items}${m.version && window.ONELOOP_BUILD ? `<div class="menu-version"><span aria-hidden="true">v${esc(window.ONELOOP_BUILD.version)} · ${esc(window.ONELOOP_BUILD.build)}</span><span class="sr-only">Version ${esc(window.ONELOOP_BUILD.version)}, build ${esc(window.ONELOOP_BUILD.build)}</span></div>` : ''}</div>`;
  }
  let lastMenuTrigger = null;
  function dismissMenu(restoreFocus=true){
    const trigger=state.menu?.trigger;
    if (trigger) lastMenuTrigger = trigger;
    state.menu=null;document.querySelector('#overlay-root > .menu-scrim')?.remove();document.querySelector('#overlay-root > .menu')?.remove();
    if(trigger?.isConnected){trigger.setAttribute('aria-expanded','false');if(restoreFocus)trigger.focus({preventScroll:true});}
  }

  // Full SPA renders replace the opener as well as the dialog. Remember its
  // identifying attributes so dismissing a dialog can focus its new counterpart.
  const overlayReturn = { modal:null, peek:null };
  function rememberOpener(element) {
    const el = element?.closest?.('button,a[href],[role="button"],input,textarea') || element;
    if (!el || el === document.body) return null;
    return { element:el, id:el.id, action:el.getAttribute(bootWindow.OneloopEventAttribute?.('onclick') || 'onclick'), label:el.getAttribute('aria-label'), name:el.getAttribute('name'), tag:el.tagName,
      epic:el.dataset.epic, milestone:el.dataset.milestone, text:el.textContent.trim(),
      selection: typeof el.selectionStart === 'number' ? [el.selectionStart,el.selectionEnd,el.selectionDirection] : null,
      scope:el.closest('.topbar') ? '.topbar' : el.closest('.sidebar') ? '.sidebar' : el.closest('.peek') ? '.peek' : el.closest('.modal') ? '.modal' : '#app' };
  }
  function restoreOpener(record) {
    const app = document.getElementById('app');
    let target = record?.element?.isConnected && !record.element.closest('[inert],[hidden]') ? record.element : null;
    if (!target && record?.id) target = document.getElementById(record.id);
    if (!target && record?.epic) target = [...app.querySelectorAll('[data-epic]')].find(el => el.dataset.epic === record.epic);
    if (!target && record?.milestone) target = [...app.querySelectorAll('[data-milestone]')].find(el => el.dataset.milestone === record.milestone);
    if (!target && record?.action) target = [...app.querySelectorAll(`[${bootWindow.OneloopEventAttribute?.('onclick') || 'onclick'}]`)].find(el => el.getAttribute(bootWindow.OneloopEventAttribute?.('onclick') || 'onclick') === record.action);
    if (!target && record?.label) target = [...app.querySelectorAll('[aria-label]')].find(el => el.getAttribute('aria-label') === record.label);
    if (!target && record?.name) target = app.querySelector(`${record.tag?.toLowerCase() || 'input'}[name="${record.name}"]`);
    if (!target && record?.text) target = [...app.querySelectorAll(`${record.scope} ${record.tag.toLowerCase()}`)].find(el => el.textContent.trim() === record.text);
    if (!target || target.closest('[inert],[hidden]') || target.disabled) target = ['.modal button','.peek button','.topbar button','.menu-btn']
      .flatMap(selector => [...app.querySelectorAll(selector)]).find(el => !el.closest('[inert],[hidden]') && !el.disabled);
    target?.focus({preventScroll:true});
    if(record?.selection && typeof target?.setSelectionRange === 'function')try{target.setSelectionRange(...record.selection);}catch{}
  }
  const overlayControls = panel => [...panel.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled):not([type="hidden"]),textarea:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.closest('[hidden],[inert]') && el.getAttribute('tabindex') !== '-1');
  function syncSidebar() {
    const app = document.getElementById('app'), open = innerWidth <= 900 && state.sideOpen;
    const overlay = !!app.querySelector('.modal,.peek');
    const sidebar = app.querySelector('.sidebar'), main = app.querySelector('.main');
    if (sidebar) sidebar.inert = overlay || innerWidth <= 900 && !state.sideOpen;
    if (main) {
      main.inert = overlay;
      for (const child of main.children) child.inert = open && !child.classList.contains('page-header');
      const topbar = main.querySelector('.topbar'); if (topbar) topbar.inert = open;
    }
    const skip = app.querySelector('.skip-link'); if (skip) skip.inert = open || overlay;
    app.querySelector('.menu-btn')?.setAttribute('aria-expanded', String(innerWidth <= 900 ? !!state.sideOpen : !state.rail));
  }
  function syncOverlayFocus({ oldModal, oldPeek, oldFocus, oldModalKey, oldPeekKey, oldPanelFocus }) {
    const app = document.getElementById('app');
    const modal = app.querySelector('.modal'), peek = app.querySelector('.peek');
    const shellInert = !!(modal || peek);
    for (const selector of ['.main','.sidebar','.side-scrim']) {
      const node = app.querySelector(`:scope > ${selector}`); if (node) node.inert = shellInert || selector === '.sidebar' && window.innerWidth <= 900 && !state.sideOpen;
    }
    syncSidebar();
    if (peek) peek.inert = !!modal;
    if (modal && !oldModal) overlayReturn.modal = rememberOpener(oldFocus?.closest?.('.menu') ? lastMenuTrigger : oldFocus);
    if (peek && !oldPeek) overlayReturn.peek = rememberOpener(oldFocus);
    if (modal || peek) {
      const panel = modal || peek;
      const externalLayer = document.querySelector('.confirmation-layer,.file-overlay') || app.inert;
      const samePanel = modal ? oldModal && oldModalKey === overlayKey('.modal') : oldPeek && !oldModal && oldPeekKey === overlayKey('.peek');
      if (oldModal && !modal && !externalLayer) restoreOpener(overlayReturn.modal);
      else if (!externalLayer && samePanel && oldPanelFocus) restoreOpener(oldPanelFocus);
      else if (!externalLayer && (!samePanel || document.activeElement === document.body)) {
        const preferred = modal?.querySelector('[autofocus]:not(:disabled)') || (state.modal?.type === 'pool' ? modal?.querySelector('#poolAdd:not([hidden])') : null) || (peek && !modal ? peek.querySelector('button') : null);
        (preferred || overlayControls(panel)[0] || panel)?.focus({preventScroll:true});
      }
    } else if (oldModal || oldPeek) {
      restoreOpener(overlayReturn.modal || overlayReturn.peek);
      overlayReturn.modal = overlayReturn.peek = null;
    }
    if (oldModal && !modal) overlayReturn.modal = null;
    if (oldPeek && !peek) overlayReturn.peek = null;
  }

  // ---------- shell ----------
  const roadmapStat = (label,value) => `<span class="roadmap-stat"><span>${label}</span><strong>${value}</strong></span>`;
  function renderTopbar() {
    if (state.view === 'knowledge') return window.OneloopKnowledge?.topbar() || '<h1>Knowledge base</h1>';
    if (state.view === 'notfound') return awaitingServerTask() ? '<h1>Task</h1>' : '<h1>Page not found</h1>';
    if (state.view === 'no-projects') return '<h1>Projects</h1>';
    if (state.view === 'forbidden') return '<h1>Access denied</h1>';
    if (state.view === 'roadmap') {
      return `<h1>Roadmap</h1><div class="roadmap-meta" role="group" aria-label="Roadmap summary"><span class="roadmap-structure-stats">${roadmapStat('Tracks',tracks().length)}${roadmapStat('Epics',epics().length)}${roadmapStat('Milestones',milestones().length)}</span></div>
      <div class="right">
        <button class="btn quiet" onclick="App.goToday()">Today</button>
        ${canRoadmap() ? `<button class="btn" onclick="App.openModal('milestone')"><span class="ms-diamond" style="border-color:var(--ink-muted)"></span> Milestone</button>
        <button class="btn primary" onclick="App.openModal('epic')">${I.plus} Epic</button>` : '<span class="read-only-pill">read only</span>'}
      </div>`;
    }
    if (state.view === 'board') {
      const applyBoard = applyBoardFilters;
      const epicOpts = (state.boardTracks.length ? epics().filter((e) => state.boardTracks.includes(e.trackId)) : epics()).slice().sort((a, b) => d(a.start) - d(b.start));
      const updateEpicFilter = () => {
        const choices = (state.boardTracks.length ? epics().filter(epic => state.boardTracks.includes(epic.trackId)) : epics()).slice().sort((a,b)=>d(a.start)-d(b.start));
        const allowed = new Set(choices.map(epic=>epic.id));
        state.boardEpics.splice(0,state.boardEpics.length,...state.boardEpics.filter(id=>allowed.has(id)));
        const def = MULTI.fEpic;
        if(def) { def.options=choices.map(epic=>({v:epic.id,l:epic.title})); const button=document.querySelector('[data-filter-key="fEpic"]');if(button){button.querySelector('.sel-label').textContent=def.summary();button.title=def.summary();button.classList.toggle('empty',!state.boardEpics.length);} }
      };
      const mk = (key, arr, all, noun, options, extra) => multiHtml(key, Object.assign({
        options, search: options.length > 6,
        values: () => arr,
        toggle: (v) => { const i = arr.indexOf(v); if (i === -1) arr.push(v); else arr.splice(i, 1); if(key==='fTrack')updateEpicFilter(); applyBoard(); },
        clear: () => { arr.length = 0; if(key==='fTrack')updateEpicFilter(); applyBoard(); },
        summary: () => arr.length === 0 ? all : arr.length === 1 ? ((MULTI[key]?.options || options).find((o) => o.v === arr[0]) || {}).l || all : `${arr.length} ${noun}`,
      }, extra || {}));
      const meId = me().id;
      const assigneeOpts = [{ v: meId, l: me().name, sub: 'My tasks', pinned: true }, { v: NO_ASSIGNEE, l: 'No assignee', pinned: true }, ...projectMembers().filter((u) => u.id !== meId).map((u) => ({ v: u.id, l: u.name, sub: userHandle(u) }))];
      return `<h1>Board</h1>
      <div class="right board-filters">
        <input class="ctl" data-board-search style="width:170px" aria-label="Search tasks" placeholder="Search tasks" value="${esc(state.boardQ)}" oninput="App.setBoardQ(this.value,event)" onkeydown="App.boardSearchKey(event)">
        ${mk('fTrack', state.boardTracks, 'All tracks', 'tracks', tracks().map((t) => ({ v: t.id, l: t.name })), { width: 140 })}
        ${mk('fEpic', state.boardEpics, 'All epics', 'epics', epicOpts.map((e) => ({ v: e.id, l: e.title })), { search: true, width: 180 })}
        ${mk('fAssignee', state.boardAssignees, 'All assignees', 'assignees', assigneeOpts, { search: true, width: 150 })}
        <button class="btn blocked-filter" aria-pressed="${state.boardBlocked}" onclick="App.setBlockedFilter(this)">${I.blocked}Blocked<span class="blocked-filter-count" title="Blocked tasks in this project">${D.projectTaskCounts?.[state.projectId]?.blocked ?? tasks().filter(t=>t.block && t.state!=='done').length}</span></button>
        <button class="btn quiet" onclick="App.openModal('pool')">Pool <span class="mono" data-pool-count style="font-size:var(--text-xs);color:var(--ink-ghost)">${Number.isFinite(D.poolPageInfo?.[`${state.projectId}:mine`]?.total)&&Number.isFinite(D.poolPageInfo?.[`${state.projectId}:project`]?.total)?D.poolPageInfo[`${state.projectId}:mine`].total+D.poolPageInfo[`${state.projectId}:project`].total:poolItems().length}</span></button>
        ${canBoard() ? `<button class="btn primary" onclick="App.openModal('task')">${I.plus} Task</button>` : '<span class="read-only-pill">read only</span>'}
      </div>`;
    }
    if (state.view === 'task') {
      const t = taskById(state.taskId);
      if (!t) return '<h1>Board</h1>';
      return `<button class="btn icon" onclick="App.nav('board')" title="Back to Board" aria-label="Back to Board"><span aria-hidden="true">←</span></button>
      <h1 style="display:flex;align-items:center;gap:8px"><span class="mono">${esc(t.id)}</span></h1>
      <span class="chip idle task-status-chip">${stIcon(t.state)}${STATUS[t.state]}</span>${t.block ? `<span class="blocked-badge">${I.blocked}Blocked</span>` : ''}<span class="task-save-status" role="status" aria-live="polite">${taskSaveFeedback?.id===t.id?taskSaveFeedback.saving?'Saving…':'Saved':''}</span>
      ${canBoard() ? `<div class="right"><button class="btn icon task-actions-button" aria-label="Task actions" title="Task actions" aria-controls="action-menu" aria-expanded="${!!state.menu?.taskActions}" onclick="App.taskActions(event,'${UIArg(t.id)}')">${I.kebab}</button></div>` : '<div class="right"><span class="read-only-pill">read only</span></div>'}`;
    }
    if (state.view === 'storage') return '<h1>Storage</h1><span class="meta">All projects</span>';
    if (state.view === 'inbox') return '<h1>Inbox</h1>';
    if (state.view === 'profile') return `<h1>Profile</h1><span class="meta">${esc(userHandle(me()))}</span>`;
    if (state.view === 'users') return `<h1>Users</h1><span class="meta users-count">${usersCountLabel()}</span><div class="right"><button class="btn primary" onclick="App.openModal('user')">${I.plus} New user</button></div>`;
    return `<h1>Settings</h1><span class="meta" title="${esc(project().name)}">${esc(project().name)}</span>`;
  }

  let paintedPage=null;
  const pageScope=()=>JSON.stringify([D.session?.id,D.session?.userId,state.view,state.projectId,state.taskId]);
  let rendering=false,paintedScope=null,backgroundRenderTimer=null,pressedTaskControl=false,pressedControlTimer=null;
  const renderScope=()=>JSON.stringify([D.session?.id,D.session?.userId,location.hash,state.view,state.projectId,state.taskId,state.modal?.type,state.modal?.id,state.peek]);
  // Keep live metadata current without removing an active control or overlay.
  function refreshBackground(){
    clearTimeout(backgroundRenderTimer);
    const authorized=D.session&&(!['task','board','roadmap','settings'].includes(state.view)||canReadProject(state.projectId))&&(!window.Recovery?.pageError);
    // WebKit may blur an editor without focusing the pressed button. Keep its
    // DOM target alive through pointer release/click, including slow presses.
    const busy=POP.el||state.modal||state.peek||pendingConfirmation||document.activeElement?.closest('.task-page,.peek,.modal')||pressedTaskControl;
    if(authorized&&busy&&!(state.view==='task'&&!canBoard()&&document.querySelector('.tp-title:not(:disabled)'))){backgroundRenderTimer=setTimeout(refreshBackground,100);return;}
    render();
  }
  // Snapshot immediately around the DOM swap, never across an awaited read.
  function render(){
    clearTimeout(backgroundRenderTimer);
    if(!bootWindow.ONELOOP_DEFER_BOOT_RENDER)D.peopleVersion=(D.peopleVersion||0)+1;
    const scope=renderScope(),active=document.activeElement;
    const preserve=paintedScope===scope&&!window.Recovery?.pageError&&(!D.session||canReadProject(state.projectId)||['profile','users','inbox','storage'].includes(state.view));
    const focused=preserve&&active?.matches('input:not([type=file]),textarea')?{opener:rememberOpener(active),value:active.value,scrollTop:active.scrollTop}:null;
    const focusedControl=preserve&&!focused&&active?.closest('#app')?rememberOpener(active):null;
    const snapshot=focused?window.OneloopRecovery?.captureEditor?.():null;
    if(snapshot)snapshot.controls=snapshot.controls.filter(control=>control.key===snapshot.activeKey);
    rendering=true;
    try{
      renderContent();
      const board=document.querySelector('.board');if(board)boardSnapshots.set(board,boardSnapshot());
      if(document.getElementById('rmScroll')&&document.querySelector('.content')?.clientHeight!==roadmapHeight)App.refreshRoadmap();
      migrateEvents?.();
      if (paintedPage !== pageScope() && document.activeElement === document.body && !document.querySelector('.modal,.peek') && !document.getElementById('app').inert) {
        const target = document.querySelector('.topbar h1') || document.querySelector('.auth-card [autofocus]');
        target?.focus({preventScroll:true});
      }
      if(scope===renderScope()&&focused){
        if(snapshot)window.OneloopRecovery.restoreEditor(snapshot);
        restoreOpener(focused.opener);
        const target=document.activeElement;
        if(target?.matches('input,textarea')){target.value=focused.value;target.scrollTop=focused.scrollTop;if(focused.opener.selection)try{target.setSelectionRange(...focused.opener.selection);}catch{}}
      }
      if(focusedControl && document.activeElement===document.body)restoreOpener(focusedControl);
      const sidebar=document.querySelector('.sidebar');
      if(innerWidth<=900 && state.sideOpen && sidebar && !sidebar.inert && !sidebar.closest('[inert]') && document.activeElement===document.body)sidebar.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
    }finally{rendering=false;paintedScope=renderScope();paintedPage=pageScope();}
  }
  function renderOverlays(){
    const root=document.getElementById('overlay-root');
    if(!root||!D.session||!me()?.active){render();return;}
    const oldModalElement=/** @type {HTMLElement|null} */(root.querySelector('.modal')),oldPeekElement=/** @type {HTMLElement|null} */(root.querySelector('.peek')),oldFocus=document.activeElement;
    const focus={oldModal:!!oldModalElement,oldPeek:!!oldPeekElement,oldFocus,oldModalKey:oldModalElement?.dataset.motionKey,oldPeekKey:oldPeekElement?.dataset.motionKey,oldPanelFocus:(oldModalElement||oldPeekElement)?.contains(oldFocus)?rememberOpener(oldFocus):null};
    collaboration?.beforeRender({userId:me()?.id,projectId:state.projectId,view:state.view,taskId:state.taskId,modal:state.modal});
    const motion=prepareRenderMotion(true);hideEpicTip();closePop(true);
    const template=document.createElement('template');setHTML(template,`${state.peek?renderPeek():''}${renderModal()}${renderMenu()}`);
    // A modal over a drawer must retain that drawer's open editor and scroll.
    const nextPeek=template.content.querySelector('.peek');
    if(nextPeek&&oldPeekElement&&focus.oldPeekKey===state.peek)nextPeek.replaceWith(oldPeekElement);
    root.replaceChildren(template.content);
    document.getElementById('app').classList.toggle('side-open',!!state.sideOpen);
    document.querySelector('.switcher-btn')?.setAttribute('aria-expanded',String(!!state.menu?.projectMenu));
    document.querySelector('.me-chip')?.setAttribute('aria-expanded',String(!!state.menu?.version));
    migrateEvents?.();mountDescription();collaboration?.mount();
    finishRenderMotion(motion,true);if(state.menu)placeMenu();syncOverlayFocus(focus);Reflect.set(App,'_focusPool',false);
    paintedScope=renderScope();
  }
  function renderContent() {
    if(state.view!=='board'||!D.session)cancelBoardSearch();
    window.OneloopKnowledge?.beforeRender();
    const oldModalElement = document.querySelector('#overlay-root > .modal-wrap .modal');
    const oldPeekElement = document.querySelector('#overlay-root > .peek');
    const oldModal = !!oldModalElement, oldPeek = !!oldPeekElement;
    const oldFocus = document.activeElement;
    const oldModalKey = oldModalElement?.dataset.motionKey,oldPeekKey = oldPeekElement?.dataset.motionKey;
    const oldPanelFocus = (oldModalElement || oldPeekElement)?.contains(oldFocus) ? rememberOpener(oldFocus) : null;
    fieldSequence = 0;
    if(state.modal?.type==='temppw'&&(!D.session||state.modal.ownerSession!==D.session.id||state.modal.ownerId!==me()?.id||!isAdmin()))state.modal=null;
    if(taskSaveFeedback&&(state.view!=='task'||state.taskId!==taskSaveFeedback.id||me()?.id!==taskSaveFeedback.owner))clearTaskSaved();
    today.setTime(instanceToday().getTime());
    window.Recovery?.enforceSession();
    if (pendingConfirmation && (pendingConfirmation.session !== D.session?.id || pendingConfirmation.hash !== location.hash || !D.session)) pendingConfirmation.close(false, false);
    window.Uploads?.validateAccess();
    collaboration?.beforeRender({userId:me()?.id,projectId:state.projectId,view:state.view,taskId:state.taskId,modal:state.modal});
    const renderMotion = prepareRenderMotion();
    clearFilterMotion();
    hideEpicTip();
    closePop(true);
    if (!D.session) { updateDocumentTitle();setHTML(document.getElementById('app'),renderAuth('login')); return; }
    if (me().mustChange) { updateDocumentTitle();setHTML(document.getElementById('app'),renderAuth('change')); return; }
    if(state.view==='task'&&!canReadTask(taskById(state.taskId))){state.view='forbidden';state.peek=null;state.modal=null;}
    if(state.peek&&!canReadProject(trackById(epicById(state.peek)?.trackId)?.projectId))state.peek=null;
    if(state.modal&&!canReadProject(state.projectId)&&!['user','project','temppw'].includes(state.modal.type))state.modal=null;
    if (!visibleProjects().find((p) => p.id === state.projectId)) state.projectId = (visibleProjects()[0] || {}).id;
    if (['settings','users','storage'].includes(state.view) && !isAdmin()) state.view = 'forbidden';
    if(!project()&&['roadmap','board','knowledge','settings'].includes(state.view))state.view='no-projects';
    updateDocumentTitle();
    const c = counts();
    const p = project() || {name:'No projects'};
    const u = me();
    const error = window.Recovery?.pageError || (state.view === 'notfound' && !awaitingServerTask() ? '404' : state.view === 'forbidden' ? '403' : null);
    const view = state.view==='no-projects' ? `<div class="page-empty"><h2>No projects available</h2><p>${isAdmin()?'Create the first project to start planning work.':'Ask an admin to add you to a project.'}</p>${isAdmin()?'<button class="btn primary" onclick="App.openModal(\'project\')">Create project</button>':''}</div>` : error ? window.Recovery?.errorHtml(error) || `<div class="page-error"><h2>${error === '403' ? 'Access denied' : 'Page not found'}</h2><button class="btn quiet" onclick="App.nav('board')">Back to Board</button></div>` : awaitingServerTask() ? '<div class="pending-task-route" role="status" aria-label="Loading task"></div>' : state.view === 'knowledge' ? window.OneloopKnowledge?.render(state.projectId) || '' : state.view === 'roadmap' ? renderRoadmap() : state.view === 'board' ? renderBoard() : state.view === 'task' ? renderTask() : state.view === 'profile' ? renderProfile() : state.view === 'users' ? renderUsers() : state.view === 'inbox' ? collaboration?.inboxHtml() || '' : state.view === 'storage' ? `<div class="workspace-page storage-page">${window.Uploads?.storageHtml() || ''}</div>` : renderSettings();
    const appRoot = document.getElementById('app'), shell = document.createElement('template');
    setHTML(shell,`
      <a class="skip-link" href="#main">Skip to content</a>
      <div class="side-scrim" onclick="App.toggleSidebar(false)"></div>
      <nav class="sidebar" aria-label="Main navigation" ${window.innerWidth <= 900 && !state.sideOpen ? 'inert' : ''}>
        <div class="sidebar-brand has-inbox"><div class="logo" role="img" aria-label="oneloop">${I.logo}<span class="lbl">${I.wordmark}</span></div>${collaboration?.inboxNav(state.view) || ''}</div>
        <div class="switcher"><button class="switcher-btn btn" style="border-color:rgb(var(--tone-rgb) / 0.06)" ${!project()&&!isAdmin()?'disabled':''} onclick="App.projectMenu(event)" title="${esc(p.name)}" aria-label="Project: ${esc(p.name)}" aria-expanded="${!!state.menu?.projectMenu}" aria-controls="project-switcher-menu">
          <span class="project-identity"><span class="avatar">${esc(p.name[0].toUpperCase())}</span><span class="lbl project-name">${esc(p.name)}</span></span><span class="lbl project-chevron">${I.chev}</span></button></div>
        <div class="nav">
          <button class="nav-item ${state.view === 'roadmap' ? 'on' : ''}" ${state.view === 'roadmap' ? 'aria-current="page"' : ''} onclick="App.nav('roadmap')" title="Roadmap">${I.roadmap}<span class="lbl">Roadmap</span></button>
          <button class="nav-item ${state.view === 'board' || state.view === 'task' ? 'on' : ''}" ${state.view === 'board' || state.view === 'task' ? 'aria-current="page"' : ''} onclick="App.nav('board')" title="Board">${I.board}<span class="lbl">Board</span><span class="end lbl mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">${c.open}</span></button>
          <button class="nav-item ${state.view === 'knowledge' ? 'on' : ''}" ${state.view === 'knowledge' ? 'aria-current="page"' : ''} onclick="App.nav('knowledge')" title="Knowledge">${I.knowledge}<span class="lbl">Knowledge</span></button>
          ${isAdmin() ? `<button class="nav-item ${state.view === 'settings' ? 'on' : ''}" onclick="App.nav('settings')" title="Settings">${I.settings}<span class="lbl">Settings</span></button>` : ''}
        </div>
        <div class="sidebar-bottom"><div class="profile-area"><button class="me-chip" onclick="App.userMenu(event)" title="${esc(u.name)}" aria-controls="action-menu" aria-expanded="${!!state.menu?.version}">${avatarHtml(u.id, 20)}
          <span class="lbl uname">${esc(u.name)}</span><span class="lbl profile-chevron">${I.chev}</span></button></div></div>
      </nav>
      <div class="main">
        <div class="page-header"><button type="button" class="btn icon menu-btn" aria-label="Toggle sidebar" aria-expanded="${window.innerWidth <= 900 ? !!state.sideOpen : !state.rail}">${I.menu}</button><header class="topbar${state.view === 'board' ? ' board-topbar' : ['settings','profile','users','inbox','storage'].includes(state.view) ? ' form-topbar'+(['inbox','storage'].includes(state.view)?' workspace-topbar':'') : ''}">${renderTopbar().replaceAll('<h1','<h1 tabindex="-1"')}</header></div>${window.Recovery?.connectionHtml() || ''}
        <main id="main" tabindex="-1" class="content${['settings','profile','users','inbox','storage'].includes(state.view) ? ' form-content'+(['inbox','storage'].includes(state.view)?' workspace-content':'') : ''}">${view}</main>

      </div>
      <div id="overlay-root" style="display:contents">${state.peek ? renderPeek() : ''}${renderModal()}${renderMenu()}</div>
      `);
    // Browsers drop a click when the pressed element leaves the document before
    // mouseup, even if it returns. So a render, such as the route-loading
    // indicator, must not detach an unchanged sidebar: replace only the nodes
    // around it, keeping its listeners and focus.
    const oldSidebar = appRoot.querySelector(':scope > .sidebar'), newSidebar = [...shell.content.children].find(node => node.classList.contains('sidebar'));
    const keptSidebar = !!oldSidebar && !!newSidebar && oldSidebar.isEqualNode(newSidebar);
    if (keptSidebar) {
      const nodes = [...shell.content.childNodes], at = nodes.indexOf(newSidebar);
      for (const node of [...appRoot.childNodes]) if (node !== oldSidebar) node.remove();
      oldSidebar.before(...nodes.slice(0, at));
      oldSidebar.after(...nodes.slice(at + 1));
    } else appRoot.replaceChildren(shell.content);

    document.querySelector('.skip-link')?.addEventListener('click', event => { event.preventDefault(); document.getElementById('main')?.focus(); });
    const appEl = document.getElementById('app');
    appEl.classList.toggle('side-open', !!state.sideOpen);
    appEl.classList.toggle('rail', !!state.rail);
    const mb = document.querySelector('.menu-btn');
    if (mb) mb.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); App.toggleSidebar(); });
    if (TOUCH && !keptSidebar) {
      const sb = document.querySelector('.sidebar');
      if (sb) sb.addEventListener('click', (e) => {
        if (state.rail && window.innerWidth > 900 && !e.target.closest('.nav-item, .me-chip, .switcher-btn')) App.toggleSidebar(false);
      });
    }

    document.querySelectorAll('.timeline > [data-feed-key]').forEach(el=>feedRowMarkup.set(el,el.outerHTML));
    migrateEvents?.();
    mountDescription();
    if (state.view === 'task') window.Uploads?.mount(state.taskId);
    if (state.view === 'roadmap' && !error) mountRoadmap();
    window.OneloopKnowledge?.mount();
    finishRenderMotion(renderMotion);
    if (state.menu) placeMenu();
    collaboration?.mount();
    syncOverlayFocus({ oldModal, oldPeek, oldFocus, oldModalKey, oldPeekKey, oldPanelFocus });
    App._focusPool = false;
  }

  // ---------- roadmap mount: scroll + zoom ----------
  function mountRoadmapCalendar(sc) {
    const start = new Date(Number(sc.dataset.rangeStart)), end = new Date(Number(sc.dataset.rangeEnd));
    const ppd = state.pxPerDay, width = sc.clientWidth || window.innerWidth;
    const x = dt => Math.round((dt - start) / DAY * ppd);
    // One viewport of overscan each way keeps scrolling smooth with bounded DOM.
    const first = new Date(Math.max(+start, +start + (sc.scrollLeft - width - RAIL) / ppd * DAY));
    const last = new Date(Math.min(+end, +start + (sc.scrollLeft + width * 2) / ppd * DAY));
    first.setUTCDate(1); first.setUTCHours(0, 0, 0, 0);
    const key = `${first.getUTCFullYear()}:${first.getUTCMonth()}:${last.getUTCFullYear()}:${last.getUTCMonth()}`;
    if (sc.dataset.calendarKey === key) return;
    sc.dataset.calendarKey = key;
    let months = '', seps = '', axisSeps = '';
    for (let m = new Date(first); m < last; m.setUTCMonth(m.getUTCMonth() + 1)) {
      const next = new Date(m); next.setUTCMonth(next.getUTCMonth() + 1);
      const ms = new Date(Math.max(+m, +start)), me = new Date(Math.min(+next, +end));
      const label = m.toLocaleDateString('en-US', { timeZone:'UTC', month: 'short' }) + (m.getUTCMonth() === 0 || +m === +first ? ' ' + String(m.getUTCFullYear()).slice(2) : '');
      if (x(me) - x(ms) > 46) months += `<div class="rm-month" style="left:${x(ms)}px;width:${x(me) - x(ms)}px">${label}</div>`;
      const bx = x(next);
      if (next < end) {
        seps += `<div style="position:absolute;left:${RAIL + bx}px;top:${sc.dataset.axisHeight}px;bottom:${MONTH_ROW}px;width:1px;background:var(--line-soft)"></div>`;
        axisSeps += `<div class="rm-axis-divider" aria-hidden="true" style="left:${bx}px"></div>`;
      }
    }
    sc.querySelector('.rm-calendar-axis').innerHTML = axisSeps;
    sc.querySelector('.rm-calendar-lines').innerHTML = seps;
    sc.querySelector('.rm-month-grid').innerHTML = axisSeps + months;
  }

  let roadmapGestureCleanup = () => {};
  function mountRoadmap() {
    roadmapGestureCleanup();
    const sc = document.getElementById('rmScroll');
    if (!sc) return;
    if (state.rmScrollLeft === null) {
      const { start } = rmRange();
      state.rmScrollLeft = Math.max(RAIL + (today - start) / DAY * state.pxPerDay - sc.clientWidth * 0.42, 0);
    }
    sc.scrollLeft = state.rmScrollLeft;
    sc.scrollTop = state.rmScrollTop;
    mountRoadmapCalendar(sc);
    let calendarFrame = 0;
    sc.addEventListener('scroll', () => {
      state.rmScrollLeft = sc.scrollLeft; state.rmScrollTop = sc.scrollTop;
      if (!calendarFrame) calendarFrame = requestAnimationFrame(() => {
        calendarFrame = 0;
        if (sc.isConnected) mountRoadmapCalendar(sc);
      });
    });
    const canvas = /** @type {HTMLElement} */(sc.querySelector('.rm-canvas'));
    const sample = sc.querySelector('.bar');
    /** @type {number|null} */ let sizeFrame = null;
    const sizeObserver = typeof ResizeObserver === 'undefined' || !sample ? null : new ResizeObserver(() => {
      if(sizeFrame===null && sc.isConnected && Math.ceil(sample.getBoundingClientRect().height)!==Number(sc.dataset.barHeight)){
        sizeFrame=requestAnimationFrame(()=>{sizeFrame=null;if(sc.isConnected)App.refreshRoadmap();});
      }
    });
    if(sample)sizeObserver?.observe(sample);
    /** @type {{kind:string,cx:number,start:Date,ppd0:number,next:number,date:number,distance?:number}|null} */ let gesture = null;
    /** @type {number|null} */ let frame = null;
    /** @type {number|null} */ let idle = null;
    const clamp = (/** @type {number} */ value) => Math.min(Math.max(value, 2.2), 42);
    /** @param {number} cx @param {string} kind */
    function begin(cx, kind) {
      hideEpicTip();
      const {start} = rmRange();
      gesture = {kind, cx, start, ppd0:state.pxPerDay, next:state.pxPerDay,
        date:+start + (sc.scrollLeft + cx - RAIL) / state.pxPerDay * DAY};
      canvas.style.transformOrigin = (sc.scrollLeft + cx) + 'px 0';
      canvas.style.willChange = 'transform';
    }
    function paint() {
      frame = null;
      if (!gesture || !sc.isConnected) return;
      const scale = gesture.next / gesture.ppd0;
      canvas.style.transform = `scaleX(${scale})`;
      sc.querySelectorAll(/** @type {'div'} */('.rail-cell')).forEach(el => {
        el.style.transformOrigin = '0 0'; el.style.transform = `scaleX(${1 / scale})`;
      });
    }
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(paint); };
    function finish() {
      if (!gesture) return;
      const current = gesture; gesture = null;
      cleanup();
      if (!sc.isConnected || state.view !== 'roadmap') return;
      state.pxPerDay = current.next;
      state.rmScrollLeft = Math.max(RAIL + (current.date-current.start) / DAY * current.next-current.cx, 0);
      App.refreshRoadmap({zoom:true});
    }
    const movePinch = (/** @type {TouchEvent} */ e) => {
      if (gesture?.kind !== 'pinch' || e.touches.length !== 2) return;
      e.preventDefault();
      gesture.next = clamp(gesture.ppd0 * dist(e.touches) / gesture.distance);
      schedule();
    };
    function cleanup() {
      if(calendarFrame)cancelAnimationFrame(calendarFrame);
      sizeObserver?.disconnect();if(sizeFrame!==null)cancelAnimationFrame(sizeFrame);sizeFrame=null;
      clearTimeout(idle); if (frame !== null) cancelAnimationFrame(frame);
      frame = null; sc.removeEventListener('touchmove', movePinch);
      canvas.style.transform = ''; canvas.style.willChange = '';
      sc.querySelectorAll(/** @type {'div'} */('.rail-cell')).forEach(el => el.style.transform = '');
    }
    roadmapGestureCleanup = cleanup;
    sc.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (gesture?.kind === 'pinch') return;
      const cx = e.clientX-sc.getBoundingClientRect().left;
      if (!gesture) begin(cx, 'wheel');
      // Re-anchor on the same date under a moving pointer at the pending scale.
      gesture.date += (cx-gesture.cx) / gesture.next * DAY;
      gesture.cx = cx;
      gesture.next = clamp(gesture.next * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      schedule(); clearTimeout(idle); idle = setTimeout(finish, 120);
    }, {passive:false});
    const dist = (/** @type {TouchList} */ touches) => Math.hypot(touches[0].clientX-touches[1].clientX, touches[0].clientY-touches[1].clientY);
    sc.addEventListener('touchstart', e => {
      if (e.touches.length !== 2 || !dist(e.touches) || gesture) return;
      const cx = (e.touches[0].clientX+e.touches[1].clientX)/2-sc.getBoundingClientRect().left;
      begin(cx, 'pinch'); gesture.distance = dist(e.touches);
      sc.addEventListener('touchmove', movePinch, {passive:false});
    }, {passive:true});
    const endPinch = () => { if (gesture?.kind === 'pinch') finish(); };
    sc.addEventListener('touchend', endPinch, {passive:true});
    sc.addEventListener('touchcancel', endPinch, {passive:true});
  }

  // Layout motion uses the current painted positions, so a new drag can interrupt it.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const layoutAnimations = new WeakMap();
  const motionKey = (el) => el.dataset.task || el.dataset.track;
  const motionRects = (selector) => new Map([...document.querySelectorAll(selector)].map((el) => [motionKey(el), el.getBoundingClientRect()]));
  function animateLayout(before, selector, skipId) {
    document.querySelectorAll(selector).forEach((el) => {
      const from = before.get(motionKey(el));
      layoutAnimations.get(el)?.cancel();
      if (!from || motionKey(el) === skipId || reducedMotion.matches) return;
      const to = el.getBoundingClientRect();
      const x = from.left - to.left, y = from.top - to.top;
      if (Math.abs(x) + Math.abs(y) < 1) return;
      const animation = el.animate([
        { transform: `translate(${x}px, ${y}px)` },
        { transform: 'translate(0, 0)' },
      ], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
      layoutAnimations.set(el, animation);
    });
  }
  function settleCard(card, from) {
    if (!card || !from || reducedMotion.matches) return;
    const to = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.removeAttribute('data-task');
    ghost.removeAttribute('data-reorderable');
    ghost.classList.remove('dragging');
    ghost.classList.add('drag-settle');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.style.cssText = `left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px`;
    document.body.appendChild(ghost);
    card.classList.add('settling');
    const animation = ghost.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(1.025)`, opacity: 0.9 },
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
    ], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    const cleanup = () => { ghost.remove(); card.classList.remove('settling'); };
    animation.finished.then(cleanup, cleanup);
  }

  function refreshEpicSummary() {
    if (!state.peek) return;
    const old = document.querySelector('[data-epic-throughput]');
    if (!old) return;
    const template = document.createElement('template'); setHTML(template,renderPeek());
    const next = template.content.querySelector('[data-epic-throughput]');
    if (next) old.replaceWith(next);
  }

  // ---------- actions ----------
  const App = {
    /** Production compatibility boundary. New modules must not reach private state directly. */
    context() { return { view:state.view, taskId:state.taskId, projectId:state.projectId, poolTab:state.poolTab, board:{trackIds:[...state.boardTracks],epicIds:[...state.boardEpics],assigneeIds:[...state.boardAssignees],search:state.boardQ,blocked:state.boardBlocked}, modal:state.modal ? { ...state.modal } : null }; },
    updateDocumentTitle,
    refreshCounts() {
      const badge=document.querySelector('.sidebar .nav-item[title="Board"] .end');
      const open=String(counts().open);if(badge&&badge.textContent!==open)badge.textContent=open;
      const blocked=document.querySelector('.blocked-filter-count');
      const blockedCount=String(D.projectTaskCounts?.[state.projectId]?.blocked??tasks().filter(task=>task.block&&task.state!=='done').length);
      if(blocked&&blocked.textContent!==blockedCount)blocked.textContent=blockedCount;
      const mine=D.poolPageInfo?.[`${state.projectId}:mine`]?.total,team=D.poolPageInfo?.[`${state.projectId}:project`]?.total;
      const poolTotal=Number.isFinite(mine)&&Number.isFinite(team)?mine+team:poolItems().length;
      document.querySelectorAll('[data-pool-count]').forEach(el=>{if(el.textContent!==String(poolTotal))el.textContent=String(poolTotal);});
    },
    refreshEpic() {
      if (!state.peek) return;
      const peek=document.querySelector('#overlay-root > .peek'),rows=peek?.querySelector('.peek-rows');
      if (!rows) return;
      const template=document.createElement('template');setHTML(template,renderPeek());
      const next=template.content.querySelector('.peek-rows');
      if (!next) return;
      const total=peek.querySelector('[data-epic-task-total]'),nextTotal=template.content.querySelector('[data-epic-task-total]');
      if(total&&nextTotal)total.textContent=nextTotal.textContent;
      const focus=rows.contains(document.activeElement)?rememberOpener(document.activeElement):null;
      const peekScroll=peek.scrollTop,rowsScroll=rows.scrollTop;
      rows.replaceWith(next);peek.scrollTop=peekScroll;next.scrollTop=rowsScroll;
      if (focus && !peek.inert && !document.querySelector('.confirmation-layer,.file-overlay')) restoreOpener(focus);
    },
    refreshPool: updatePool,
    refreshProfileAccess,
    refreshUsers({loadingOnly=false}={}) {
      if (loadingOnly) {
        document.querySelector(state.view==='settings'?'.member-access-list':'.content .settings')?.setAttribute('aria-busy', String(!!D.adminUsers?.loading));
        document.querySelectorAll('[data-more-users]').forEach(button=>button.disabled=!!D.adminUsers?.loading);
        return;
      }
      if (state.view === 'settings') {
        const settings = document.querySelector('.settings-wide');
        const section = settings?.querySelectorAll(':scope > .section')[1];
        if (!section) return;
        const focus = section.contains(document.activeElement) ? rememberOpener(document.activeElement) : null;
        closePop(true);
        const template = document.createElement('template'); setHTML(template,renderSettings());
        section.replaceWith(template.content.querySelectorAll('.section')[1]);
        if (focus) restoreOpener(focus);
        return;
      }
      if (state.view !== 'users') return;
      const content = document.querySelector('.content'), count = document.querySelector('.users-count');
      if (!content) return;
      const scroll = content.scrollTop, focus = document.activeElement, userId = focus?.matches?.('.user-row') ? focus.dataset.userId : null;
      setHTML(content,renderUsers()); content.scrollTop = scroll;
      if (count) count.textContent = usersCountLabel();
      if (userId) [...content.querySelectorAll('.user-row')].find(el => el.dataset.userId === userId)?.focus({preventScroll:true});
    },
    validateFormDates,
    noteTaskSaving: taskSaving,
    clearTaskSaving,
    retryTaskActivity(id){collaboration?.retryTaskPage?.(id);},
    confirm: askConfirmation,
    fieldError: failField,
    showBlocked(title, text) { state.modal = { type:'confirm', title, text, blocked:true }; renderOverlays(); },
    showTemporaryPassword(id, password) { state.modal = { type:'temppw', id, pw:password, ownerSession:D.session?.id, ownerId:me()?.id }; renderOverlays(); },
    async copyTemporaryPassword() {
      const modal=state.modal;
      if(modal?.type!=='temppw'||!isAdmin()||modal.ownerSession!==D.session?.id||modal.ownerId!==me()?.id)return;
      try{
        await navigator.clipboard.writeText(modal.pw);
        if(state.modal===modal)App.toast('Copied');
      }catch{
        if(state.modal===modal)App.toast('Could not copy. Select the password and copy it manually.','error');
      }
    },
    selectProject(id) { if(!visibleProjects().some(project=>project.id===id))return;state.projectId=id;state.rmScrollLeft=null;state.boardTracks=[];state.boardEpics=[];state.boardAssignees=[];state.boardQ='';state.boardBlocked=false;if(state.view==='knowledge'){window.OneloopKnowledge?.route('knowledge',id);setLocalHash('#/knowledge');}render(); },
    // A drop animates its own card; it passes { animate: false } so the refresh does not move it again.
    refreshBoard(options) { applyBoardFilters(false,true,options); App.refreshCounts(); },
    refreshRoadmap({zoom=false}={}) {
      refreshEpicSummary();
      if(state.view!=='roadmap'){refreshBackground();return;}
      const content=document.querySelector('.content'),scroll=document.getElementById('rmScroll');
      if(!content||!scroll){render();return;}
      roadmapGestureCleanup();
      const before=zoom?null:motionRects('.lane'),left=zoom?state.rmScrollLeft:scroll.scrollLeft,top=scroll.scrollTop;
      const focus=document.activeElement,focusType=focus?.dataset?.epic?'epic':focus?.dataset?.milestone?'milestone':null,focusId=focusType?focus.dataset[focusType]:null;
      setHTML(content,renderRoadmap());mountRoadmap();
      const next=document.getElementById('rmScroll');if(next){next.scrollLeft=left;next.scrollTop=top;}
      if(focusId){const equivalent=[...content.querySelectorAll(`[data-${focusType}]`)].find(el=>el.dataset[focusType]===focusId);(equivalent||document.querySelector('.topbar button'))?.focus({preventScroll:true});}
      updateDocumentTitle();
      if(before)animateLayout(before,'.lane');
      App.refreshCounts();
    },
    acceptMoreBoard(col) {
      state.boardLimits[col]=(state.boardLimits[col]||50)+50;
      const board=document.querySelector('.board'),column=board?.querySelector(`[data-col="${UIEscape(col)}"]`),list=column?.querySelector('.col-cards');
      if(!list||state.view!=='board')return;
      const ids=new Set([...list.querySelectorAll(/** @type {'div'} */('[data-task]'))].map(card=>card.dataset.task));
      const template=document.createElement('template');setHTML(template,renderBoard({column:col,excludeIds:ids}));
      const next=template.content.querySelector('.col-cards'),more=list.querySelector('.board-load-more');
      for(const card of next.querySelectorAll('.card')){list.insertBefore(card,more);UIMotion.enter(card);}
      if(list.querySelector('.card'))list.querySelector('.empty-note')?.remove();
      const nextMore=next.querySelector('.board-load-more');
      if(!nextMore){const focused=more?.contains(document.activeElement);more?.remove();if(focused)list.querySelector(/** @type {'button'} */('.card:last-of-type .title'))?.focus({preventScroll:true});}
      else if(!more)list.append(nextMore);
      column.querySelector('.col-head .mono').textContent=template.content.querySelector('.col-head .mono').textContent;
      boardSnapshots.set(board,boardSnapshot());
    },
    acceptMoreUsers() { if(state.view==='settings'){App.refreshUsers();return;}state.usersLimit+=50;render(); },
    nav(v) { window.Recovery?.clearPageError(); state.view = v; state.menu = null; state.peek = null; state.modal = null; state.sideOpen = false; if (v === 'knowledge') window.OneloopKnowledge?.route(v, state.projectId); setLocalHash('#/' + v); render(); },
    require(permission) {
      if (hasPermission(permission)) return true;
      App.toast(`${permission === 'manage_roadmap' ? 'Roadmap' : 'Board'}: read only`, 'info');
      return false;
    },
    toggleSidebar(force) {
      // The shell binds only click, which covers pointer and keyboard activation.
      const appEl = document.getElementById('app');
      if (window.innerWidth <= 900) {
        // phone: a drawer under the top bar; the same button opens and closes it
        state.sideOpen = typeof force === 'boolean' ? force : !state.sideOpen;
        appEl.classList.toggle('side-open', state.sideOpen);
        syncSidebar();
        (state.sideOpen ? document.querySelector('.sidebar button:not(:disabled)') : document.querySelector('.menu-btn'))?.focus({preventScroll:true});
        return;
      }
      // desktop: full sidebar or icon rail, remembered
      state.rail = typeof force === 'boolean' ? force : !state.rail;
      appEl.classList.toggle('rail', state.rail);
      document.querySelector('.menu-btn').setAttribute('aria-expanded', String(!state.rail));
      try { localStorage.setItem('oneloop.sidebar', state.rail ? 'rail' : 'full'); } catch {}
    },
    // auth & profile
    login(ev) {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const uname = String(f.get('username') || '').trim().toLowerCase();
      const u = userById(uname);
      if (!u) return failField(ev.target, 'username', 'No such user.');
      if (!u.active) return failField(ev.target, 'username', 'This account is deactivated.');
      if (!f.get('password')) return failField(ev.target, 'password', 'Enter your password.');
      const complete = () => { D.session = { userId:u.id,authenticatedAt:Date.now() }; currentBrowserSession(); state.rmScrollLeft = null; const target=window.Recovery?.consumeReturn() || '#/roadmap'; setLocalHash(target); resolveRoute(); render(); };
      if (window.Recovery) Recovery.loginAtLimit(u,complete); else complete(); return false;
    },
    logout() {
      if (!D.session) return;
      const userId = me().id, sessionId = D.session.id;
      askConfirmation({ title:'Sign out?', text:'End your current browser session.', action:'Sign out', confirm:() => {
        if (!D.session || me().id !== userId || D.session.id !== sessionId) return;
        const current = currentBrowserSession(); if (current) current.revokedAt = Date.now();
        window.Uploads?.clearAccount(userId); clearToasts(); D.session = null; state.modal = null; state.menu = null; state.peek = null; render();
      } });
    },
    setPassword(ev) {
      ev.preventDefault();
      const f = new FormData(ev.target);
      if ([...String(f.get('pw') || '')].length < 5) return failField(ev.target, 'pw', 'Use at least 5 characters.');
      if (f.get('pw') !== f.get('pw2')) return failField(ev.target, 'pw2', 'Passwords do not match.');
      me().mustChange = false; App.toast('Password set'); render(); return false;
    },
    changePassword(ev) {
      ev.preventDefault();
      const f = new FormData(ev.target);
      if (!f.get('cur')) return failField(ev.target, 'cur', 'Enter your current password.');
      if ([...String(f.get('pw') || '')].length < 5) return failField(ev.target, 'pw', 'Use at least 5 characters.');
      if (f.get('pw') !== f.get('pw2')) return failField(ev.target, 'pw2', 'Passwords do not match.');
      D.session.authenticatedAt=Date.now(); revokeAccountAccess(me().id, currentBrowserSession()?.id);
      App.toast('Password changed. Other sessions and app access revoked'); render(); return false;
    },
    updMe(v) { const nv = cleanStr(v, 80); if (!nv) return failField(document.querySelector('.settings'), 'name', 'Enter your full name.'); me().name = nv; const chip = document.querySelector('.me-chip'); if (chip) { chip.title = nv; chip.querySelector('.uname').textContent = nv; } App.toast('Profile saved'); },
    setAvatar(input) {
      const file = input.files[0]; if (!file) return;
      const r = new FileReader();
      r.onload = () => { me().avatar = r.result; App.toast('Avatar updated'); render(); };
      r.readAsDataURL(file);
    },
    removeAvatar() { const userId = me().id; askConfirmation({ title:'Remove avatar?', text:'Your account will use its default avatar.', action:'Remove avatar', confirm:() => { if (me()?.id !== userId) return; me().avatar = null; render(); } }); },
    userMenu(ev) {
      const r = ev.currentTarget.getBoundingClientRect();
      App._openMenu([
        { theme: true },
        { sep: true },
        { label: 'Profile', icon: I.person, fn: () => App.nav('profile') },
        ...(isAdmin() ? [{ label: 'Users', icon: I.users, fn: () => App.nav('users') },{ label: 'Storage', icon: I.storage, fn: () => App.nav('storage') }] : []),
        { sep: true },
        { label: 'Sign out', icon: I.signOut, danger: true, fn: () => App.logout() },
      ], r.left, r.top, { version: true, above: true, trigger:ev.currentTarget });
    },
    setTheme(value) { window.Theme.set(value); },
    clearTaskSaved,
    noteTaskSaved:taskSaved,
    sizeDescription,
    sizeDescriptionEditors,
    sizeTaskTitle,
    expandDescription() {
      const section = document.querySelector('.task-description');
      if (section) expandedDescriptions.add(section.dataset.descriptionKey);
      sizeDescription(true);
    },
    toggleDescription(button) {
      const section = button?.closest('.expandable-description') || document.querySelector('.task-description');
      if (!section) return;
      const id = section.dataset.descriptionKey;
      if (expandedDescriptions.has(id)) expandedDescriptions.delete(id);
      else expandedDescriptions.add(id);
      sizeDescription(true);
    },
    revokeSession(id) {
      if (!D.session || id === D.session.id) return false;
      const item = (D.browserSessions || []).find(item => item.id === id && item.userId === me().id && item.revokedAt == null);
      if (!item) return false;
      return askConfirmation({ title:'Revoke session?', text:`${item.device || 'This device'} will need to sign in again.`, action:'Revoke session', confirm:() => {
        if (!D.session || item.userId !== me().id || id === D.session.id || item.revokedAt != null) return;
        item.revokedAt = Date.now(); refreshProfileAccess(); App.toast('Session revoked');
      } });
    },
    revokeOtherSessions() {
      if (!D.session) return false;
      const current = currentBrowserSession();
      if (!current || !(D.browserSessions || []).some(item => item.userId === me().id && item.id !== current.id && item.revokedAt == null)) return false;
      return askConfirmation({ title:'Sign out other sessions?', text:'All other browser sessions will end. Connected apps will keep their access.', action:'Sign out other sessions', confirm:() => {
        if (!D.session || me().id !== current.userId || D.session.id !== current.id) return;
        revokeAccountAccess(me().id, current.id, false); refreshProfileAccess(); App.toast('Other sessions signed out');
      } });
    },
    revokeAppAccess(id) {
      if (!D.session) return false;
      const grant = (D.appGrants || []).find(item => item.id === id && item.userId === me().id && item.revokedAt == null);
      if (!grant) return false;
      return askConfirmation({ title:`Revoke ${grant.clientName} access?`, text:'This app will lose access to its authorized projects until you reconnect it.', action:'Revoke access', confirm:() => {
        if (!D.session || me().id !== grant.userId || grant.revokedAt != null) return;
        grant.revokedAt = Date.now(); refreshProfileAccess(); App.toast(`${grant.clientName} access revoked`);
      } });
    },

    // users (admin)
    saveUser(ev, id) {
      ev.preventDefault();
      if (!isAdmin()) return false;
      const f = new FormData(ev.target);
      const name = cleanStr(f.get('name'), 80);
      if (id) {
        const u = userById(id);
        const wantAdmin = ev.target.elements.admin.disabled ? u.admin : f.get('admin') !== null;
        const wantActive = ev.target.elements.active.disabled ? u.active : f.get('active') !== null;
        if (u.admin && u.active && activeAdmins().length === 1 && (!wantAdmin || !wantActive)) return failField(ev.target, 'name', 'This is the last active admin.');
        if (!name) return failField(ev.target, 'name', 'Give the user a name.');
        const apply = () => {
          if (!isAdmin()) return;
          if (u.admin && u.active && activeAdmins().length === 1 && (!wantAdmin || !wantActive)) return;
          Object.assign(u, { name, admin: wantAdmin, active: wantActive });
          if (!wantActive) revokeAccountAccess(u.id);
          if (u.id === me().id && !wantActive) { D.session = null; state.modal = null; render(); return; }
          App.toast(`${u.id} saved`); state.modal = null; render();
        };
        if (u.active && !wantActive) askConfirmation({title:'Deactivate user?',text:`${u.name} will lose access, including existing sessions and connected apps.`,action:'Deactivate user',confirm:apply});
        else if (u.admin && !wantAdmin) askConfirmation({title:'Remove admin access?',text:`${u.name} will keep only their project permissions.`,action:'Remove admin access',confirm:apply});
        else apply();
        return false;
      }
      const uname = String(f.get('username') || '');
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(uname)) return failField(ev.target, 'username', '3–32 characters: a–z, 0–9, dots, dashes.');
      if (userById(uname)) return failField(ev.target, 'username', 'That username is taken.');
      if (!name) return failField(ev.target, 'name', 'Give the user a name.');
      const pw = genPassword();
      D.users.push({ id: uname, name, admin: f.get('admin') !== null, active: true, avatar: null, mustChange: true });
      App.showTemporaryPassword(uname,pw); return false;
    },
    resetPassword(id) {
      if (!isAdmin() || !userById(id)) return;
      askConfirmation({ title:'Reset password?', text:`${userById(id).name}'s sessions and app access will be revoked. A temporary password will be created.`, action:'Reset password', confirm:() => {
        if (!isAdmin()) return;
        const u = userById(id); if (!u) return;
        const pw = genPassword(); u.mustChange = true; revokeAccountAccess(id);
        App.showTemporaryPassword(id,pw);
      } });
    },

    // members (admin)
    addMember(uid) {
      if (!isAdmin()) return;
      const p = project();
      p.members = p.members || [];
      if (!memberRecord(uid)) p.members.push({ userId: uid, permissions: [] });
      App.toast(`${uid} added — read only`); render();
    },
    setMemberPermission(userId, permission, enabled, input) {
      if (!isAdmin() || !['manage_board','manage_roadmap'].includes(permission)) return;
      const p = project(), membership = memberRecord(userId);
      if (!membership) return;
      const apply = () => {
        if (!isAdmin() || project().id !== p.id || !memberRecord(userId)) return;
        let record = memberRecord(userId);
        if ((p.members || []).includes(userId)) { record = {userId,permissions:[]}; p.members[p.members.indexOf(userId)] = record; }
        record.permissions ||= [];
        if (enabled && !record.permissions.includes(permission)) record.permissions.push(permission);
        if (!enabled) record.permissions = record.permissions.filter(item => item !== permission);
        App.toast(`${userId} access updated`); render();
      };
      if (!enabled && (membership.permissions || []).includes(permission)) {
        askConfirmation({ title:'Remove permission?', text:`${userById(userId)?.name || userId} will lose permission to manage ${permission === 'manage_board' ? 'Board' : 'Roadmap'} in ${p.name}.`, action:'Remove permission', cancel:() => { if (input?.isConnected) input.checked = true; }, confirm:apply });
      } else apply();
    },
    removeMember(uid) {
      if (!isAdmin()) return;
      const assigned = tasks().filter((t) => t.state !== 'done' && (t.assignees || []).includes(uid));
      if (assigned.length) {
        state.modal = { type: 'confirm', title: 'Member has open work', text: `Reassign ${assigned.length} open task${assigned.length === 1 ? '' : 's'} before removing ${esc(uid)} from this project.`, blocked: true };
        render(); return;
      }
      const p = project();
      askConfirmation({ title:'Remove member?', text:`Remove ${userById(uid)?.name || uid} from ${p.name}?`, action:'Remove member', confirm:() => {
        if (!isAdmin() || project().id !== p.id || tasks().some(t => t.state !== 'done' && (t.assignees || []).includes(uid))) return;
        p.members = (p.members || []).filter(m => (typeof m === 'string' ? m : m.userId) !== uid);
        App.toast(`${uid} removed`); render();
      } });
    },

    openTask(id) { const target=taskById(id),track=trackById(epicById(target?.epicId)?.trackId);if(!target||!track)return;if(!canReadTask(target)){state.view='forbidden';state.peek=null;state.modal=null;render();return;}state.projectId=track.projectId;state.sideOpen = false; state.view = 'task'; state.taskId = id; state.menu = null; setLocalHash('#/task/' + id); render(); },
    updTask(id, f, v) {
      if(rendering)return false;
      if (!App.require('manage_board')) return;
      const t = taskById(id);
      if (!t) { App.toast('This task is no longer available','error');return false; }
      if(f==='start'||f==='created'){App.toast('The creation date is read only','info');return false;}
      if (f === 'deadline') {
        const value = parseDateInput(v);
        const error = dateError({ clearable: true }, value);
        if (error) {
          const wrap = document.querySelector('[data-date-key="tpDl"]');
          if (wrap) dateFieldError(wrap, error);
          return false;
        }
        v = value;
      }
      const before = f === 'desc' ? t.desc || '' : t[f] ?? null;
      if (f === 'title') { const nv = cleanStr(v, 140); if (!nv) return failField(document.querySelector('.task-page'), 'title', 'Enter a task title.'); if (nv !== t.title) { t.title = nv; logAct(t, 'renamed the task', {field:f,before,after:nv}); } }
      else if (f === 'desc') { const nv = cleanStr(v, 4000); if (nv !== (t.desc || '')) { t.desc = nv; logAct(t, 'updated the description', {field:f,before,after:nv}); } }
      else if (f === 'deadline') { if (v !== (t.deadline || '')) { t.deadline = v || null; logAct(t, v ? `set the deadline to ${human(d(v))}` : 'cleared the deadline', {field:f,before,after:v||null}); } }
      else if (f === 'state') { if(setTaskState(t, v)===false)return false; }
      else if (f === 'epicId') {
        if (v !== t.epicId) {
          const oldE = epicById(t.epicId), newE = taskDestinationEpics().find(epic => epic.id === v);
          if (!newE) {
            const control = document.querySelector('#select-tpEpic');
            if (control && oldE) { control.querySelector('.sel-label').textContent = oldE.title; control.title = oldE.title; }
            if (SELS.tpEpic) SELS.tpEpic.value = t.epicId;
            App.toast('Choose an open epic. Completed epics must be reopened first.', 'error'); return false;
          }
          if (oldE) { oldE.total = Math.max(oldE.total - 1, 0); if (t.state === 'done') oldE.done = Math.max(oldE.done - 1, 0); }
          if (newE) { newE.total += 1; if (t.state === 'done') newE.done += 1; }
          t.epicId = v;
          logAct(t, `moved it to “${newE ? newE.title : v}”`, {field:f,before,after:v});
        }
      }
      const after = f === 'desc' ? t.desc || '' : t[f] ?? null;
      if(before!==after)taskSaved(id);
      if(f==='title')updateDocumentTitle();
      if (f === 'deadline' || f === 'desc' || f === 'title') {
        const timeline = document.querySelector('.task-page .timeline');
        if (timeline) setHTML(timeline,taskFeedHtml(t, canBoard()));
        document.querySelector('.task-overdue')?.toggleAttribute('hidden', !overdue(t));
        document.querySelector('[data-date-key="tpDl"]')?.closest('.prop-row').classList.toggle('late', !!overdue(t));
        return true;
      }
      render();
    },
    popMulti(ev, key) {
      ev.preventDefault();
      if (POP.id === 'ms:' + key) { closePop(); return; }
      const def = MULTI[key];
      const btn = ev.currentTarget;
      const el = openPop(btn, Math.max(btn.getBoundingClientRect().width, 220));
      POP.id = 'ms:' + key;
      el.id='multi-'+key;POP.trigger=btn;btn.setAttribute('aria-expanded','true');btn.setAttribute('aria-controls',el.id);
      POP.onClose = def.onClose || null;
      let q = '';
      const row = (o) => `<button type="button" class="pop-opt multi${def.values().includes(o.v) ? ' on' : ''}" aria-pressed="${def.values().includes(o.v)}" data-v="${esc(o.v)}">
          <span class="chk">${def.values().includes(o.v) ? I.tick : ''}</span>
          <span style="display:flex;flex-direction:column;min-width:0"><span class="l">${esc(o.l)}</span>${o.sub ? `<span class="s">${esc(o.sub)}</span>` : ''}</span></button>`;
      const paint = () => {
        const opts = q ? def.options.filter((o) => o.l.toLowerCase().includes(q) || (o.sub || '').toLowerCase().includes(q)) : def.options;
        const pinned = opts.filter((o) => o.pinned), rest = opts.filter((o) => !o.pinned);
        const list = el.querySelector('.pop-list');
        setHTML(list,(pinned.length ? pinned.map(row).join('') + '<div class="pop-sep"></div>' : '') + rest.map(row).join('') || '<div class="pop-empty">No matches</div>');
        const foot = el.querySelector('.pop-foot');
        if (foot) foot.style.display = def.values().length && def.clear ? '' : 'none';
        [...list.querySelectorAll('.pop-opt')].forEach((oel) => oel.addEventListener('click', () => {
          const focused=document.activeElement===oel,value=oel.dataset.v;def.toggle(value);
          btn.querySelector('.sel-label').textContent = def.summary(); btn.title = def.summary();
          btn.classList.toggle('empty', !def.values().length);
          paint();if(focused)[...list.querySelectorAll('.pop-opt')].find(option=>option.dataset.v===value)?.focus({preventScroll:true});
        }));
        placePop(btn);
      };
      setHTML(el,`${def.search ? '<div class="pop-search-wrap"><input class="pop-search" type="text" placeholder="Search options" spellcheck="false"></div>' : ''}<div class="pop-list"></div>${def.clear ? '<div class="pop-foot"><button type="button" class="btn quiet">Clear</button></div>' : ''}`);
      paint();
      requestAnimationFrame(() => { if (POP.el === el) placePop(btn); });
      const input = el.querySelector('.pop-search');
      if (input) { input.focus(); input.addEventListener('input', () => { q = input.value.trim().toLowerCase(); paint(); }); }
      const foot = el.querySelector('.pop-foot button');
      if (foot) foot.addEventListener('click', () => { def.clear(); btn.querySelector('.sel-label').textContent = def.summary(); btn.title = def.summary(); btn.classList.add('empty'); paint(); });
      POP.onKey = (e) => {
        if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closePop();btn.focus({preventScroll:true});}
        else if(e.key==='Tab')closePop();
        else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const rows=[...el.querySelectorAll('.pop-opt')],index=rows.indexOf(document.activeElement),next=index<0?(e.key==='ArrowDown'?0:rows.length-1):Math.max(0,Math.min(rows.length-1,index+(e.key==='ArrowDown'?1:-1)));rows[next]?.focus();}
        else if((e.key==='Enter'||e.key===' ')&&document.activeElement?.matches('.pop-opt.multi')&&el.contains(document.activeElement)){e.preventDefault();document.activeElement.click();}
      };
      document.addEventListener('keydown', POP.onKey, true);
    },
    attachFiles(id, input) {
      if (!App.require('manage_board')) return;
      const t = taskById(id);
      t.attachments = t.attachments || [];
      [...input.files].forEach((f) => { t.attachments.push({ name: f.name, size: f.size }); logAct(t, `attached ${f.name}`); });
      render();
    },
    delAttachment(id, i) {
      if (!App.require('manage_board')) return;
      const task = taskById(id), attachment = task?.attachments?.[i]; if (!attachment) return;
      askConfirmation({ title:'Remove attachment?', text:attachment.name, action:'Remove attachment', confirm:() => {
        if (!canBoard() || taskById(id) !== task) return;
        const index = task.attachments.indexOf(attachment); if (index < 0) return;
        logAct(task, `removed ${attachment.name}`); task.attachments.splice(index,1); render();
      } });
    },
    delComment(id, i) {
      if (!App.require('manage_board')) return;
      const task = taskById(id), comment = task?.comments?.[i];
      if (!comment || (comment.who !== me().id && !isAdmin())) return;
      askConfirmation({ title:'Delete comment?', text:'This comment will be permanently removed.', action:'Delete comment', confirm:() => {
        if (!canBoard() || taskById(id) !== task || (comment.who !== me().id && !isAdmin())) return;
        const index = task.comments.indexOf(comment); if (index < 0) return;
        task.comments.splice(index,1); render();
      } });
    },
    addComment(id) {
      if (!App.require('manage_board')) return;
      const text = cleanStr(document.getElementById('cmtIn').value, 2000);
      if (!text) return;
      const t = taskById(id);
      (t.comments = t.comments || []).push({ who: me().id, ts: Date.now(), text });
      render();
    },
    saveBlock(ev,id,mode) {
      ev.preventDefault();const task=taskById(id);
      if(!task){App.toast('This task is no longer available','error');return false;}
      if(!App.require('manage_board') || window.Recovery&&!Recovery.ensureOnline())return false;
      let message='';
      const reason=cleanStr(new FormData(ev.target).get('reason'),500);
      if(mode==='block'){
        if(task.state==='done'){App.toast('Completed tasks cannot be blocked','error');return false;}
        if(!reason)return failField(ev.target,'reason','Explain what is preventing progress.');
        const prepared=collaboration?.prepareBlock(task,new FormData(ev.target).get('reason'),reason);if(!prepared)return false;
        const created=!task.block;
        const changed=created||task.block.reason!==reason||JSON.stringify(task.block.mentions||[])!==JSON.stringify(prepared.mentions);
        if(changed)message=created?'Task blocked':'Block reason updated';
        if(task.block){const before={reason:task.block.reason,mentions:task.block.mentions||[]};task.block.reason=reason;task.block.mentions=prepared.mentions;logAct(task,'updated the block reason: '+reason,{field:'block-reason:'+task.block.id,before,after:{reason,mentions:prepared.mentions}},{blockId:task.block.id});}
        else {task.block={id:'block-'+(crypto.randomUUID?.()||Date.now()+'-'+uid('block')),reason,mentions:prepared.mentions,by:me().id,at:Date.now()};logAct(task,'blocked the task: '+reason,null,{blockId:task.block.id});}
        Collab.blockSaved(task,created,prepared);
      }else if(['unblock','completeBlocked'].includes(mode)){
        if(!task.block){App.toast('This block has already been resolved','info');return false;}
        const blockId=task.block.id;
        (task.blockHistory ||= []).push({...task.block,resolvedAt:Date.now(),resolvedBy:me().id,resolution:reason});task.block=null;
        logAct(task,'unblocked the task'+(reason?': '+reason:''),null,{blockId});collaboration?.taskEvent(task,'unblocked');
        if(mode==='completeBlocked')setTaskState(task,'done');
        message=mode==='completeBlocked'?'Task unblocked and completed':'Task unblocked';
      }else return false;
      state.modal=null;render();if(message)App.toast(message);return false;
    },
    setBlockedFilter(button){state.boardBlocked=!state.boardBlocked;button?.setAttribute('aria-pressed',String(state.boardBlocked));applyBoardFilters();},
    goToday() {
      const sc = document.getElementById('rmScroll');
      const { start } = rmRange();
      state.rmScrollLeft = Math.max(RAIL + (today - start) / DAY * state.pxPerDay - (sc ? sc.clientWidth : 900) * 0.42, 0);
      render();
    },
    epicHover(ev, id, keyboard = false, kind = 'epic') {
      if (!keyboard && !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      hideEpicTip();
      const anchor = ev.currentTarget;
      const show = kind === 'milestone' ? showMilestoneTip : showEpicTip;
      if (keyboard) show(anchor, id);
      else EPIC_TIP.showTimer = setTimeout(() => show(anchor, id), 220);
    },
    milestoneHover(ev, id, keyboard = false) { App.epicHover(ev, id, keyboard, 'milestone'); },
    milestoneClick(ev, id) {
      if (canRoadmap()) App.openModal('milestone', id);
      else showMilestoneTip(ev.currentTarget, id);
    },
    roadmapTipKey(ev) {
      const tip = EPIC_TIP.el;
      if (!tip || EPIC_TIP.anchor !== ev.currentTarget) return;
      const distance = { ArrowDown:40, ArrowUp:-40, PageDown:tip.clientHeight*.8, PageUp:-tip.clientHeight*.8 }[ev.key];
      if (distance !== undefined) { ev.preventDefault(); tip.scrollTop += distance; }
    },
    epicLeave() {
      clearTimeout(EPIC_TIP.showTimer); clearTimeout(EPIC_TIP.hideTimer);
      EPIC_TIP.hideTimer = setTimeout(hideEpicTip, 140);
    },
    epicKey(ev, id) {
      App.roadmapTipKey(ev);
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); App.openPeek(id); }
    },
    openPeek(id) { if(!canReadProject(trackById(epicById(id)?.trackId)?.projectId)){App.toast('This project is unavailable','error');return;}state.peek = id; renderOverlays(); },
    closeOverlays() { if (state.menu&&!state.modal&&!state.peek){dismissMenu();return;}if (state.modal?.poolId) { App.returnToPool(); return; } state.peek = state.peek && state.modal ? state.peek : null; state.modal = null; state.menu = null; renderOverlays(); },
    openModal(type, id, epicId) {
      if(type==='pool'&&!canReadProject(state.projectId))return;
      const targetProject=id&&(type==='epic'?trackById(epicById(id)?.trackId)?.projectId:type==='track'?trackById(id)?.projectId:type==='milestone'?D.milestones.find(m=>m.id===id)?.projectId:['block','unblock','completeBlocked'].includes(type)?trackById(epicById(taskById(id)?.epicId)?.trackId)?.projectId:null);
      if(targetProject&&!canReadProject(targetProject))return;
      if (['epic', 'milestone', 'track'].includes(type) && !App.require('manage_roadmap')) return;
      if (type === 'task' && !App.require('manage_board')) return;
      if (['project', 'user', 'knowledge'].includes(type) && !isAdmin()) return;
      state.sideOpen = false;
      state.modal = { type, id, epicId, trackId: null }; state.menu = null; if (type === 'pool') { App._poolScroll = {}; App._focusPool = true; } renderOverlays();
      if(type==='pool'&&bootWindow.OneloopRuntime)bootWindow.OneloopRuntime.invoke('pool.open',{}).catch(bootWindow.OneloopRuntime.report);
    },
    toast: pushToast,
    announce,
    dismissToast,


    // menus
    projectMenu(ev) {
      const r = ev.currentTarget.getBoundingClientRect();
      const items = visibleProjects().map((p) => ({ label: esc(p.name), projectId:p.id, projectName:p.name, fn: () => { if(bootWindow.OneloopRuntime){bootWindow.OneloopRuntime.invoke('workspace.select',{projectId:p.id}).catch(bootWindow.OneloopRuntime.report);return;}App.selectProject(p.id); } }));
      if (isAdmin()) items.push({ sep: true }, { label: 'New project', icon:I.plus, fn: () => { state.modal = { type: 'project' }; renderOverlays(); } });
      App._openMenu(items, r.left, r.bottom + 6, { projectMenu: true, trigger:ev.currentTarget });
    },
    trackMenu(ev, id) {
      ev.stopPropagation();
      if (!App.require('manage_roadmap')) return;
      const list = tracks(), index = list.findIndex(track=>track.id===id);
      const moves = [];
      if (index > 0) moves.push({label:'Move up',fn:()=>App.moveTrack(id,index-1)}, {label:'Move to top',fn:()=>App.moveTrack(id,0)});
      if (index < list.length-1) moves.push({label:'Move down',fn:()=>App.moveTrack(id,index+1)}, {label:'Move to bottom',fn:()=>App.moveTrack(id,list.length-1)});
      App._openMenu([
        ...moves, ...(moves.length ? [{sep:true}] : []),
        { label: 'Rename track', fn: () => { state.modal = { type: 'track', id }; renderOverlays(); } },
        { sep: true },
        { label: 'Delete track', danger: true, fn: () => App.deleteTrack(id) },
      ], ev.clientX - 140, ev.clientY + 8, {trigger:ev.currentTarget});
    },
    _openMenu(items, x, y, options = /** @type {{projectMenu?:boolean, [key:string]:any}} */ ({})) { items.forEach((it, i) => { it.i = i; });const trigger=options.trigger||document.activeElement;dismissMenu(false);state.menu = { items, x: Math.max(x, 8), y, trigger, ...options };const template=document.createElement('template');setHTML(template,renderMenu());document.getElementById('overlay-root').append(template.content);trigger?.setAttribute('aria-expanded','true');trigger?.setAttribute('aria-controls',options.projectMenu?'project-switcher-menu':'action-menu');placeMenu();document.querySelector('#overlay-root > .menu button')?.focus({preventScroll:true}); },
    menuAction(i) { const it = state.menu?.items[i];dismissMenu(false);it?.fn(); },

    // CRUD — epics
    saveEpic(ev, id) {
      ev.preventDefault();
      if (!App.require('manage_roadmap')) return false;
      const f = new FormData(ev.target);
      const title = cleanStr(f.get('title'), 120);
      if (!title) return failField(ev.target, 'title', 'Give the epic a title.');
      if (!tracks().some((track) => track.id === f.get('trackId'))) return failField(ev.target, 'trackId', 'Choose a track.');
      if (!validateFormDates(ev.target)) return false;
      const dates = new FormData(ev.target);
      const start = parseDateInput(dates.get('start')), end = parseDateInput(dates.get('end')) || null;
      if (!start || (end && end < start)) return failField(ev.target, 'end', 'End date cannot be before the start date.');
      const desc = cleanStr(f.get('desc'), 2000);
      if (id) {
        const e0 = epicById(id);
        const values = { title, trackId: f.get('trackId'), start, end, desc };
        const labels = {title:'title',trackId:'track',start:'start date',end:'end date',desc:'description'};
        for (const [field,after] of Object.entries(values)) logAct(e0, 'updated the epic '+labels[field], {field,before:field==='desc'?e0[field]||'':e0[field]??null,after});
        Object.assign(e0, values);
        App.toast('Epic updated');
      } else {
        const ne = { id: uid('e'), trackId: f.get('trackId'), title, start, end, state: 'planning', done: 0, total: 0, desc, activity: [] };
        logAct(ne, 'created the epic');
        D.epics.push(ne);
        App.toast('Epic created');
      }
      state.modal = null; render(); return false;
    },
    closeEpic(id) {
      if (!App.require('manage_roadmap')) return;
      const e = epicById(id);
      const open = tasks().filter((t) => t.epicId === id && t.state !== 'done').length;
      const mark = () => { const before=e.state;e.state = 'done'; logAct(e, 'marked the epic as done', {field:'state',before,after:e.state}); App.toast('Epic marked as done'); };
      if (open) {
        state.modal = { type: 'confirm', title: 'Open tasks remain', text: `${open} open task${open > 1 ? 's' : ''} stay${open > 1 ? '' : 's'} where ${open > 1 ? 'they are' : 'it is'}.`, action: 'Mark as done', fn: mark };
      } else mark();
      render();
    },
    reopenEpic(id) {
      if (!App.require('manage_roadmap')) return;
      const e = epicById(id);
      const before = e.state;
      e.state = tasks().some((t) => t.epicId === id && t.state !== 'planning' && t.state !== 'done') ? 'active' : 'planning';
      logAct(e, 'reopened the epic', {field:'state',before,after:e.state});
      App.toast('Epic reopened');
      render();
    },
    deleteEpic(id) {
      if (!App.require('manage_roadmap')) return;
      const n = tasks().filter((t) => t.epicId === id).length;
      state.modal = n
        ? { type: 'confirm', title: 'This epic has tasks', text: `Move ${n} task${n > 1 ? 's' : ''} to another epic first.`, blocked: true }
        : { type: 'confirm', title: 'Delete epic?', text: `“${esc(epicById(id).title)}” will be removed.`, action: 'Delete epic', fn: () => { D.epics = D.epics.filter((e) => e.id !== id); state.peek = null; App.toast('Epic deleted'); } };
      render();
    },

    // CRUD — milestones
    saveMilestone(ev, id) {
      ev.preventDefault();
      if (!App.require('manage_roadmap')) return false;
      const f = new FormData(ev.target);
      const name = cleanStr(f.get('name'), 60);
      if (!name) return failField(ev.target, 'name', 'Give the milestone a name.');
      if (!validateFormDates(ev.target)) return false;
      const date = parseDateInput(new FormData(ev.target).get('date'));
      if (!date) return failField(ev.target, 'date', 'Enter a valid date.');
      const data = { name, date, desc: cleanStr(f.get('desc'), 500), projectId: state.projectId };
      if (id) { Object.assign(D.milestones.find((m) => m.id === id), data); App.toast('Milestone updated'); }
      else { D.milestones.push({ id: uid('m'), ...data }); App.toast('Milestone created'); }
      state.modal = null; render(); return false;
    },
    deleteMilestone(id) {
      if (!App.require('manage_roadmap')) return;
      state.modal = { type: 'confirm', title: 'Delete milestone?', text: `“${esc(D.milestones.find((m) => m.id === id).name)}” will be removed.`, action: 'Delete', fn: () => { D.milestones = D.milestones.filter((m) => m.id !== id); App.toast('Milestone deleted'); } };
      render();
    },

    // CRUD — tracks
    saveTrack(ev, id) {
      ev.preventDefault();
      if (!App.require('manage_roadmap')) return false;
      const name = cleanStr(new FormData(ev.target).get('name'), 60);
      if (!name) return failField(ev.target, 'name', 'Give the track a name.');
      if (id) { trackById(id).name = name; App.toast('Track renamed'); }
      else { D.tracks.push({ id: uid('t'), projectId: state.projectId, name, order: tracks().length + 1 }); App.toast('Track created'); }
      state.modal = null; render(); return false;
    },
    deleteTrack(id) {
      if (!App.require('manage_roadmap')) return;
      const n = epics().filter((e) => e.trackId === id).length;
      state.modal = n
        ? { type: 'confirm', title: 'This track has epics', text: `Move ${n} epic${n > 1 ? 's' : ''} to another track first.`, blocked: true }
        : { type: 'confirm', title: 'Delete track?', text: `“${esc(trackById(id).name)}” will be removed.`, action: 'Delete track', fn: () => { D.tracks = D.tracks.filter((t) => t.id !== id); App.toast('Track deleted'); } };
      render();
    },

    // CRUD — tasks
    saveTask(ev) {
      ev.preventDefault();
      if (!App.require('manage_board')) return false;
      const f = new FormData(ev.target);
      const title = cleanStr(f.get('title'), 140);
      if (!title) return failField(ev.target, 'title', 'Give the task a title.');
      const destination = epics().find(epic => epic.id === f.get('epicId'));
      if (!destination) return failField(ev.target, 'epicId', 'Choose an epic.');
      if (destination.state === 'done') return failField(ev.target, 'epicId', 'This epic is completed. Reopen it before adding tasks.');
      if(!validateFormDates(ev.target))return false;
      const deadline=parseDateInput(new FormData(ev.target).get('deadline'))||null,assignees=[...new Set(f.getAll('assignees'))],eligible=new Set(projectMembers().map(u=>u.id));
      if(assignees.some(id=>!eligible.has(id)))return failField(ev.target,'assignees','Choose active project members. A selected person is no longer available.');
      const p = project();
      let n = (D.taskCounters[p.id] || 0) + 1; while(D.tasks.some(task=>task.id===`${p.key}-${String(n).padStart(3,'0')}`))n++; D.taskCounters[p.id]=n;
      const nt = { internalId: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : uid('task'), id: `${p.key}-${String(n).padStart(3, '0')}`, created: Date.now(), deadline, assignees, epicId: f.get('epicId'), title, state: 'planning', desc: cleanStr(f.get('desc'), 4000), activity: [] };
      logAct(nt, 'created the task');
      D.tasks.push(nt);
      if(assignees.length)collaboration?.taskEvent(nt,'assigned',assignees);
      const e = epicById(f.get('epicId'));
      if (e) e.total += 1;
      const fromPool = !!state.modal.poolId;
      if (fromPool) D.pool = D.pool.filter((x) => x.id !== state.modal.poolId);
      if (fromPool) {
        App.returnToPool();
        if (state.view === 'board') {
          const oldBoard = document.querySelector('.board');
          const left = oldBoard?.scrollLeft || 0;
          const scrolls = [...document.querySelectorAll('.col-cards')].map((el) => [el.closest('.col').dataset.col, el.scrollTop]);
          setHTML(document.querySelector('.content'),renderBoard());
          document.querySelector('.board').scrollLeft = left;
          scrolls.forEach(([key, top]) => { document.querySelector(`[data-col="${UIEscape(key)}"] .col-cards`).scrollTop = top; });
        }
        const count = counts();
        const navCount = document.querySelector('.nav-item[title="Board"] .end');
        if (navCount) navCount.textContent = count.open;
        App.toast(`${nt.id} planning`);
        document.getElementById('poolAdd')?.focus();
      } else {
        state.modal = null; render();
        App.toast(`${nt.id} planning`);
      }
      return false;
    },

    // CRUD — project
    updateProjectField(input) {
      if (!isAdmin() || !['name','key'].includes(input.name)) return false;
      const value = input.name === 'name' ? cleanStr(input.value, 60) : input.value.toUpperCase();
      const error = input.name === 'name' ? (!value && 'The project needs a name.') : (!/^[A-Z0-9]{2,4}$/.test(value) && '2–4 letters or digits.');
      if (error) return failField(input.closest('.project-fields'), input.name, error);
      if(input.name==='key' && D.prefixRegistry[value] && D.prefixRegistry[value]!==project().id) return failField(input.closest('.project-fields'),'key','This prefix is reserved by another project.');
      const changed = project()[input.name] !== value;
      if(input.name==='key')D.prefixRegistry[value]=project().id;
      project()[input.name] = value; input.value = value; clearFieldError(input);
      if (input.name === 'name') {
        updateDocumentTitle();
        const trigger = document.querySelector('.switcher-btn');
        if (trigger) {
          trigger.title = value;
          trigger.querySelector('.project-name').textContent = value;
          trigger.querySelector('.avatar').textContent = value[0].toUpperCase();
        }
      }
      if (changed) App.toast(input.name === 'name' ? 'Project name updated' : 'Task prefix updated');
      return true;
    },
    saveProjectNew(ev) {
      ev.preventDefault();
      if (!isAdmin()) return false;
      const f = new FormData(ev.target);
      const name = cleanStr(f.get('name'), 60);
      if (!name) return failField(ev.target, 'name', 'The project needs a name.');
      const key = (f.get('key') || '').toUpperCase();
      if (!/^[A-Z0-9]{2,4}$/.test(key)) return failField(ev.target, 'key', '2–4 letters or digits.');
      if(D.prefixRegistry[key])return failField(ev.target,'key','This prefix is already reserved.');
      const id = uid('p'); D.prefixRegistry[key]=id; D.taskCounters[id]=0;
      D.projects.push({ id, key, name, members: [{ userId: me().id, permissions: [] }] });
      state.projectId = id; state.modal = null; state.rmScrollLeft = null; state.view = 'roadmap';
      App.toast('Project created'); render(); return false;
    },
    deleteProject() {
      if (!isAdmin()) return;
      if (D.projects.length === 1) { App.toast('The last project cannot be deleted', 'error'); return; }
      const target = project(), name = target.name;
      askConfirmation({ title:'Delete project?', text:'This permanently removes the project, tracks, epics, tasks, milestones, and Pool items. This cannot be undone.', action:'Delete project', match:name, confirm:() => {
        if (!isAdmin()) return;
        if (D.projects.length <= 1) { App.toast('The last project cannot be deleted', 'error'); return; }
        if (!D.projects.includes(target) || target.name !== name) { App.toast('The project changed. Review it before deleting.', 'error'); return; }
        const trackIds = new Set(D.tracks.filter(t => t.projectId === target.id).map(t => t.id));
        const epicIds = new Set(D.epics.filter(e => trackIds.has(e.trackId)).map(e => e.id));
        D.tasks = D.tasks.filter(t => !epicIds.has(t.epicId));
        D.epics = D.epics.filter(e => !epicIds.has(e.id)); D.tracks = D.tracks.filter(t => !trackIds.has(t.id));
        D.milestones = D.milestones.filter(m => m.projectId !== target.id); D.pool = D.pool.filter(item => item.projectId !== target.id);
        (D.appGrants || []).forEach(grant => { if (!(grant.access || []).some(access => access.projectId === target.id)) return; grant.access = grant.access.filter(access => access.projectId !== target.id); if (!grant.access.length && grant.revokedAt == null) grant.revokedAt = Date.now(); });
        D.projects = D.projects.filter(p => p.id !== target.id);
        if (state.projectId === target.id) { state.projectId = D.projects[0].id; state.rmScrollLeft = null; state.peek = null; state.modal = null; state.boardTracks = []; state.boardEpics = []; state.boardAssignees = []; state.boardQ = ''; state.boardBlocked = false; if (state.view === 'task') { state.view = 'roadmap'; state.taskId = null; setLocalHash('#/roadmap'); } }
        App.toast('Project deleted'); render();
      } });
    },
    confirmYes() { if(window.Recovery && !Recovery.ensureOnline())return false; if (state.modal?.type !== 'confirm' || state.modal.blocked || typeof state.modal.fn !== 'function') return false; const fn = state.modal.fn; state.modal = null; fn(); render(); return true; },

    // Drag destinations and mutations retain their existing behavior.
    _ind() { return document.getElementById('dropInd'); },
    _mkInd(absolute) {
      let el = App._ind();
      if (!el) { el = document.createElement('div'); el.id = 'dropInd'; el.className = 'drop-ind'; }
      el.style.cssText = absolute ? 'position:absolute;left:0;right:0;margin:0;z-index:8' : '';
      el.classList.toggle('track-ind', absolute);
      return el;
    },
    dragEnd(animate = true) {
      const before = animate ? motionRects('.card[data-task]') : null;
      App._dropBefore = null; App._dropColumn = null; App._laneBefore = null;
      App._drag = null;
      App._dragPreview?.remove(); App._dragPreview = null;
      const ind = App._ind(); if (ind) ind.remove();
      document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
      document.querySelectorAll('.col.drop').forEach((el) => el.classList.remove('drop'));
      document.body.classList.remove('is-dragging');
      if (before) animateLayout(before, '.card[data-task]');
    },
    _dragImage(ev, source, compact = false) {
      const image = source.cloneNode(true);
      image.removeAttribute('data-task'); image.removeAttribute('data-track');
      image.removeAttribute('data-reorderable'); image.setAttribute('aria-hidden', 'true'); image.inert = true;
      image.classList.add('drag-preview');
      const r = source.getBoundingClientRect();
      image.style.cssText = `position:fixed;left:-10000px;top:0;width:${compact ? 240 : r.width}px;height:auto;`;
      if (compact) image.querySelectorAll('.head-ctl').forEach((el) => el.remove());
      document.body.appendChild(image);
      App._dragPreview = image;
      ev.dataTransfer.setDragImage(image, compact ? 24 : ev.clientX - r.left, compact ? 20 : ev.clientY - r.top);
    },
    taskDragStart(ev, id) {
      clearFilterMotion();
      if (!App.require('manage_board')) { ev.preventDefault(); return; }
      if (App._boardMovePending) { ev.preventDefault(); return; }
      App.dragEnd(false);
      ev.dataTransfer.setData('text/task', id);
      ev.dataTransfer.effectAllowed = 'move';
      const card = ev.currentTarget;
      const r = card.getBoundingClientRect();
      App._drag = { kind: 'task', id, offsetX: ev.clientX - r.left, offsetY: ev.clientY - r.top };
      App._dragImage(ev, card);
      document.body.classList.add('is-dragging');
      requestAnimationFrame(() => { if (App._drag?.id === id) card.classList.add('dragging'); });
    },
    colOver(ev) {
      if (!canBoard() || App._drag?.kind !== 'task') return;
      if (!ev.dataTransfer.types.includes('text/task')) return;
      ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
      const colEl = ev.currentTarget;
      const list = colEl.querySelector('.col-cards');
      const ind = App._ind();
      // Don't oscillate when the pointer is inside the insertion gap itself.
      if (ind?.parentNode === list) {
        const r = ind.getBoundingClientRect();
        if (ev.clientY >= r.top - 4 && ev.clientY <= r.bottom + 4) return;
      }
      const cards = [...colEl.querySelectorAll('.card:not(.dragging)')];
      const next = cards.find((c) => {
        // Hit-test the final layout, not a sibling's in-flight transform.
        const y = list.getBoundingClientRect().top + c.offsetTop - list.scrollTop;
        return ev.clientY < y + c.offsetHeight / 2;
      });
      const beforeId = next ? next.dataset.task : null;
      if (App._dropColumn === colEl.dataset.col && App._dropBefore === beforeId && ind?.parentNode === list) return;
      const before = motionRects('.card[data-task]');
      document.querySelectorAll('.col.drop').forEach((el) => { if (el !== colEl) el.classList.remove('drop'); });
      colEl.classList.add('drop');
      App._dropColumn = colEl.dataset.col;
      App._dropBefore = beforeId;
      const marker = App._mkInd(false);
      if (next) list.insertBefore(marker, next); else list.appendChild(marker);
      animateLayout(before, '.card[data-task]', App._drag.id);
    },
    colLeave(ev) {
      if (ev.currentTarget.contains(ev.relatedTarget)) return;
      ev.currentTarget.classList.remove('drop');
      if (App._ind()?.parentNode === ev.currentTarget.querySelector('.col-cards')) {
        const before = motionRects('.card[data-task]');
        App._ind().remove(); App._dropColumn = null; App._dropBefore = null;
        animateLayout(before, '.card[data-task]', App._drag?.id);
      }
    },
    dropTask(ev, col) {
      if(window.Recovery?.blockDrag()){ev.preventDefault();App.dragEnd();return;}
      if (!App.require('manage_board')) return;
      if (App._boardMovePending) { ev.preventDefault(); App.dragEnd(); return; }
      if (!ev.dataTransfer.types.includes('text/task') || App._drag?.kind !== 'task') return;
      ev.preventDefault();
      const id = ev.dataTransfer.getData('text/task');
      const beforeId = App._dropBefore;
      const t = taskById(id);
      if (!t || id === beforeId) { App.dragEnd(); return; }
      if(t.block && col==='done'){App.dragEnd();App.openModal('completeBlocked',id);return;}
      if(bootWindow.OneloopRuntime){
        const before=motionRects('.card[data-task]'),from={left:ev.clientX-App._drag.offsetX,top:ev.clientY-App._drag.offsetY};
        const scrolls=[...document.querySelectorAll('.col-cards')].map((el)=>[el.closest('.col').dataset.col,el.scrollTop]);
        const boardLeft=document.querySelector('.board').scrollLeft,change=applyTaskMove(t,col,beforeId);
        App.dragEnd(false);if(!change)return;
        App.refreshBoard({animate:false});document.querySelector('.board').scrollLeft=boardLeft;
        scrolls.forEach(([key,top])=>{const list=document.querySelector(`[data-col="${UIEscape(key)}"] .col-cards`);if(list)list.scrollTop=top;});
        animateLayout(before,'.card[data-task]',id);settleCard(document.querySelector(`[data-task="${UIEscape(id)}"]`),from);
        submitTaskMove(change,()=>{const rollbackBefore=motionRects('.card[data-task]');App.refreshBoard({animate:false});animateLayout(rollbackBefore,'.card[data-task]');});
        return;
      }
      const before = motionRects('.card[data-task]');
      const from = { left: ev.clientX - App._drag.offsetX, top: ev.clientY - App._drag.offsetY };
      const scrolls = [...document.querySelectorAll('.col-cards')].map((el) => [el.closest('.col').dataset.col, el.scrollTop]);
      const boardLeft = document.querySelector('.board').scrollLeft;
      App.dragEnd(false);
      D.tasks.splice(D.tasks.indexOf(t), 1);
      const at = beforeId ? D.tasks.indexOf(taskById(beforeId)) : -1;
      if (at === -1) D.tasks.push(t); else D.tasks.splice(at, 0, t);
      setTaskState(t, col);
      render();
      document.querySelector('.board').scrollLeft = boardLeft;
      scrolls.forEach(([key, top]) => { document.querySelector(`[data-col="${UIEscape(key)}"] .col-cards`).scrollTop = top; });
      animateLayout(before, '.card[data-task]', id);
      settleCard(document.querySelector(`[data-task="${UIEscape(id)}"]`), from);
    },

    trackDragStart(ev, id) {
      if (!App.require('manage_roadmap')) { ev.preventDefault(); return; }
      if (App._roadmapMovePending) { ev.preventDefault(); return; }
      App.dragEnd(false);
      ev.dataTransfer.setData('text/track', id);
      ev.dataTransfer.effectAllowed = 'move';
      const lane = ev.target.closest('.lane');
      App._drag = { kind: 'track', id };
      App._dragImage(ev, lane.querySelector('.lane-head'), true);
      document.body.classList.add('is-dragging');
      requestAnimationFrame(() => { if (App._drag?.id === id) lane.classList.add('dragging'); });
    },
    laneOver(ev) {
      if (!canRoadmap() || App._drag?.kind !== 'track') return;
      if (!ev.dataTransfer.types.includes('text/track')) return;
      ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
      const lane = ev.currentTarget;
      const r = lane.getBoundingClientRect();
      App._laneBefore = ev.clientY < r.top + r.height / 2;
      const ind = App._mkInd(true);
      ind.style.top = (lane.offsetTop + (App._laneBefore ? -2 : lane.offsetHeight - 1)) + 'px';
      lane.parentNode.appendChild(ind);
    },
    trackDrop(ev, targetId) {
      if (!App.require('manage_roadmap')) return;
      if (App._roadmapMovePending) { ev.preventDefault(); App.dragEnd(); return; }
      if (!ev.dataTransfer.types.includes('text/track') || App._drag?.kind !== 'track') return;
      ev.preventDefault();
      const id = ev.dataTransfer.getData('text/track');
      const beforeTarget = App._laneBefore;
      App.dragEnd(false);
      if (!id || id === targetId) return;
      const list = tracks().filter(track=>track.id!==id);
      const index = list.findIndex(track=>track.id===targetId);
      if (index < 0) return;
      App.moveTrack(id, index + (beforeTarget ? 0 : 1));
    },
    trackReorderKey(event, id) {
      const delta = {ArrowUp:-1,ArrowDown:1}[event.key];
      if (!delta || event.isComposing) return;
      event.preventDefault(); App.moveTrack(id, tracks().findIndex(track=>track.id===id) + delta);
    },
    moveTrack(id, position) {
      if (!App.require('manage_roadmap') || App._roadmapMovePending) return;
      const list = tracks(), index = list.findIndex(track=>track.id===id);
      if (index < 0) return;
      const to = Math.max(0, Math.min(list.length-1, position));
      if (to === index) return;
      const before = motionRects('.lane');
      const original=[...list],originalOrders=new Map(original.map((item)=>[item,item.order]));
      const moved = list.splice(index, 1)[0];
      list.splice(to, 0, moved);
      list.forEach((t, i) => { t.order = i; });
      render();
      focusMovedTrack(id);
      animateLayout(before, '.lane');
      if(bootWindow.OneloopRuntime){
        const pending={};App._roadmapMovePending=pending;const revision=moved.revision,projectId=moved.projectId,sessionKey=`${D.session?.id||''}:${D.session?.userId||''}`,optimisticOrders=new Map(original.map((item)=>[item,item.order]));
        bootWindow.OneloopRuntime.invoke('track.reorder',{trackId:id,position:to,optimistic:true}).catch((error)=>{
          const sameSession=sessionKey===`${D.session?.id||''}:${D.session?.userId||''}`;
          if(!error?.uncertain&&sameSession&&D.tracks.includes(moved)&&moved.revision===revision){for(const [item,order] of originalOrders)if(D.tracks.includes(item)&&item.order===optimisticOrders.get(item))item.order=order;if(state.view==='roadmap'&&state.projectId===projectId){const rollbackBefore=motionRects('.lane');render();animateLayout(rollbackBefore,'.lane');}}
          bootWindow.OneloopRuntime.report(error);
        }).finally(()=>{if(App._roadmapMovePending===pending)App._roadmapMovePending=false;});
      }
    },

    taskActions(ev,id) {
      if(!canBoard()||!taskById(id))return;
      const r=ev.currentTarget.getBoundingClientRect();
      App._openMenu([{label:'Delete task',danger:true,fn:()=>App.deleteTask(id)}],r.right,r.bottom+4,{taskActions:true,trigger:ev.currentTarget});
    },
    deleteTask(id) {
      if (!App.require('manage_board')) return;
      const t = taskById(id);
      if(!t){App.toast('This task is no longer available','error');return;}
      state.modal = { type: 'confirm', title: 'Delete task?', text: `${esc(t.id)} will be removed.`, action: 'Delete task', fn: () => {
        if(!D.tasks.includes(t)){App.toast('This task is no longer available','error');return;}
        if(!hasPermission('manage_board',trackById(epicById(t.epicId)?.trackId)?.projectId)){App.toast('You no longer have permission to delete this task','error');return;}
        const e = epicById(t.epicId);
        if (e) { e.total = Math.max(e.total - 1, 0); if (t.state === 'done') e.done = Math.max(e.done - 1, 0); }
        D.tasks = D.tasks.filter((x) => x.id !== id);
        if (state.view === 'task') { state.view = 'board'; setLocalHash('#/board'); }
        App.toast(`${t.id} deleted`);
      } };
      render();
    },

    // Pool owns its mounted view; local actions never rebuild the dialog shell.
    poolKey(ev) {
      if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode===229 || ev.repeat || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      if (state.poolTab === 'project' && !App.require('manage_board')) return;
      const title = cleanStr(ev.target.value, 140),desc=cleanStr(document.getElementById('poolNewDesc')?.value,2000);
      if (!title){ev.target.focus();return;}
      D.pool.push(state.poolTab === 'mine'
        ? { id: uid('pl'), projectId: state.projectId, scope: 'mine', ownerId: me().id, title, desc }
        : { id: uid('pl'), projectId: state.projectId, scope: 'project', title, desc });
      ev.target.value = '';resetPoolCapture();
      updatePool();ev.target.focus({preventScroll:true});
    },
    togglePoolDescription(){const capture=document.querySelector('.pool-capture');if(!capture||capture.hidden)return;const open=!capture.classList.contains('is-expanded');if(!open){resetPoolCapture();document.getElementById('poolAdd').focus();return;}capture.classList.add('is-expanded');const content=capture.querySelector('.pool-capture-notes');content.inert=false;content.setAttribute('aria-hidden','false');const toggle=capture.querySelector('.pool-capture-toggle');toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-label','Remove description');toggle.title='Remove description';setHTML(toggle,I.close);document.getElementById('poolNewDesc').focus();},
    addPoolItem(){const input=document.getElementById('poolAdd');if(input&&!input.hidden)App.poolKey({key:'Enter',target:input,preventDefault(){}});},
    poolDescriptionKey(ev,id){
      if(ev.defaultPrevented||ev.isComposing||ev.keyCode===229)return;
      if(ev.key==='Enter'&&ev.repeat){ev.preventDefault();return;}
      if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();if(id)App.cancelPoolDescription(id);else {resetPoolCapture();document.getElementById('poolAdd').focus();}return;}
      if(ev.key==='Enter'&&!ev.shiftKey&&!ev.altKey){ev.preventDefault();if(id){const form=ev.currentTarget.closest('form');if(form)App.savePoolDescription({target:form,preventDefault(){}},id);}else App.addPoolItem();}
    },
    editPoolDescription(ev,id){ev.stopPropagation();const item=poolItems(state.poolTab).find(p=>p.id===id),row=ev.currentTarget.closest('[data-pool-item]');if(!item||!row)return;const existing=row.querySelector('.pool-description-editor');if(existing){App.cancelPoolDescription(id);return;}document.querySelectorAll('.pool-description-editor').forEach(el=>App.cancelPoolDescription(el.closest('[data-pool-item]').dataset.poolItem,false));const writable=item.scope==='mine'?item.ownerId===me()?.id:canBoard(),editor=document.createElement('div');editor.className='pool-description-editor';const before=row.getBoundingClientRect().height;setHTML(editor,writable?`<form novalidate onsubmit="return App.savePoolDescription(event,'${UIArg(id)}')"><label for="pool-desc-${UIEscape(id)}">Description ${optionalMark}</label><textarea class="ctl" id="pool-desc-${UIEscape(id)}" name="desc" maxlength="2000" onkeydown="App.poolDescriptionKey(event,'${UIArg(id)}')" placeholder="A little context for later…">${esc(item.desc||'')}</textarea><div class="pool-description-actions"><button type="button" class="btn quiet" onclick="App.cancelPoolDescription('${UIArg(id)}')">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`:`<div class="pool-note-read" tabindex="-1" role="group" aria-label="Description for ${esc(item.title)}">${esc(item.desc||'')}</div>`);row.append(editor);const reader=editor.querySelector('.pool-note-read');if(reader&&reader.scrollHeight>reader.clientHeight)reader.setAttribute('tabindex','0');ev.currentTarget.setAttribute('aria-expanded','true');UIMotion.height(row,before);editor.querySelector('textarea,.pool-note-read')?.focus({preventScroll:true});},
    cancelPoolDescription(id,focus=true){const row=document.querySelector(`[data-pool-item="${UIEscape(id)}"]`);if(!row)return;const before=row.getBoundingClientRect().height;row.querySelector('.pool-description-editor')?.remove();const toggle=row.querySelector('.pool-note-toggle');toggle?.setAttribute('aria-expanded','false');UIMotion.height(row,before);if(focus)toggle?.focus({preventScroll:true});},
    savePoolDescription(ev,id){ev.preventDefault();const item=poolItems(state.poolTab).find(p=>p.id===id);if(!item||!me()?.active||(item.scope==='mine'?item.ownerId!==me().id:!canBoard())){App.toast('You no longer have permission to edit this item','error');return false;}const desc=cleanStr(new FormData(ev.target).get('desc'),2000);if(desc!==item.desc){item.desc=desc;App.toast('Description saved');}const row=ev.target.closest('[data-pool-item]');row.outerHTML=poolRowHtml(item);document.querySelector(`[data-pool-item="${UIEscape(id)}"] .pool-note-toggle`)?.focus({preventScroll:true});return false;},
    promotePool(id) {
      if (!App.require('manage_board')) return;
      const item = poolItems(state.poolTab).find((x) => x.id === id);
      const view = document.querySelector('.pool-view');
      if (!item || !view) return;
      (App._poolScroll ||= {})[state.poolTab] = view.querySelector('.pool-list').scrollTop;
      document.querySelectorAll('.pool-description-editor').forEach(el=>App.cancelPoolDescription(el.closest('[data-pool-item]').dataset.poolItem,false));resetPoolCapture();document.getElementById('poolAdd').value='';
      state.modal = { type: 'task', poolId: id, title: item.title, desc:item.desc||'' };
      view.hidden = true;
      const editor = document.createElement('div');
      editor.className = 'pool-editor';
      setHTML(editor,taskModalHtml(state.modal));
      view.parentElement.appendChild(editor);
      mountDescription();
      fadeContent(editor);
      editor.querySelector('[name="title"]').focus();
    },
    returnToPool() {
      closePop(true);
      document.querySelector('.pool-editor')?.remove();
      const view = document.querySelector('.pool-view');
      if (!view) return;
      state.modal = { type: 'pool' };
      view.hidden = false;
      updatePool();
      view.querySelector('.pool-list').scrollTop = App._poolScroll?.[state.poolTab] || 0;
      fadeContent(view);
      view.querySelector('#poolAdd')?.focus();
    },
    delPool(ev, id) {
      ev.stopPropagation();
      const item = poolItems(state.poolTab).find((x) => x.id === id);
      if (!item || (item.scope === 'project' && !App.require('manage_board'))) return;
      if (item.scope === 'mine' && item.ownerId !== me().id) return;
      const row = ev.currentTarget.closest('[data-pool-item]');
      const nextId = (row?.nextElementSibling || row?.previousElementSibling)?.dataset.poolItem;
      askConfirmation({ title:'Delete Pool item?', text:item.title, action:'Delete item', confirm:() => {
        if (!D.session || !poolItems(state.poolTab).includes(item) || (item.scope === 'mine' ? item.ownerId !== me().id : !canBoard())) return;
        D.pool = D.pool.filter(x => x.id !== id); updatePool();
        const next = nextId && document.querySelector(`[data-pool-item="${UIEscape(nextId)}"] .pool-delete`);
        (next || document.getElementById('poolAdd'))?.focus();
      } });
    },
    setPoolTab(k) {
      if (!['mine', 'project'].includes(k) || k === state.poolTab) return;
      const list = document.querySelector('.pool-list');
      (App._poolScroll ||= {})[state.poolTab] = list.scrollTop;
      state.poolTab = k;
      updatePool();
      list.scrollTop = App._poolScroll[k] || 0;
      if(bootWindow.OneloopRuntime)bootWindow.OneloopRuntime.invoke('pool.select',{scope:k}).catch(bootWindow.OneloopRuntime.report);
    },
    loadMorePool(){if(bootWindow.OneloopRuntime)bootWindow.OneloopRuntime.invoke('pool.more',{scope:state.poolTab}).catch(bootWindow.OneloopRuntime.report);},

    // popover components
    popSelect(ev, key) {
      ev.preventDefault();
      if (POP.id === 'sel:' + key) { closePop(); return; }
      const def = SELS[key];
      const btn = ev.currentTarget;
      const hid = btn.parentNode.querySelector('input[type="hidden"]');
      const cur = hid ? hid.value : def.value;
      const searchable = def.search || def.options.length > 7;
      const el = openPop(btn);
      POP.id = 'sel:' + key;POP.trigger=btn;btn.setAttribute('aria-expanded','true');btn.setAttribute('aria-controls',`select-${key}-list`);
      setHTML(el,`${searchable ? '<div class="pop-search-wrap"><input class="pop-search" type="text" placeholder="Search options" spellcheck="false"></div>' : ''}<div class="pop-list"></div>`);
      const listEl = el.querySelector('.pop-list');
      const input = el.querySelector('.pop-search');
      listEl.id=`select-${key}-list`;listEl.setAttribute('role','listbox');listEl.setAttribute('aria-labelledby',btn.id);
      const focusOwner=input||listEl;focusOwner.tabIndex=0;
      if(input){input.setAttribute('role','combobox');input.setAttribute('aria-label',btn.textContent.trim());input.setAttribute('aria-expanded','true');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',listEl.id);}
      let q = '', filtered = def.options, idx = -1;

      const pick = (o) => {
        const returnFocus = rememberOpener(btn);
        closePop();
        if (hid) hid.value = o.v;
        def.value = o.v;
        btn.classList.toggle('empty', o.v === '' || o.v == null);
        btn.querySelector('.sel-label').textContent = o.l; btn.title = o.l;
        clearFieldError(btn);
        if (def.pick) def.pick(o.v);
        restoreOpener(returnFocus);
      };
      const setIdx = (i) => {
        idx = i;
        [...listEl.children].forEach((oel, j) => oel.classList && oel.classList.toggle('focus', j === i));
        const f = listEl.children[i];if(f)focusOwner.setAttribute('aria-activedescendant',f.id);else focusOwner.removeAttribute('aria-activedescendant'); if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest' });
      };
      const paintList = () => {
        filtered = q ? def.options.filter((o) => o.l.toLowerCase().includes(q)) : def.options;
        setHTML(listEl,filtered.length
          ? filtered.map((o,i) => `<button type="button" role="option" tabindex="-1" id="select-${UIEscape(key)}-option-${UIEscape(i)}" aria-selected="${o.v === cur}" class="pop-opt${o.v === cur ? ' on' : ''}"><span class="option-label">${o.icon || ''}<span>${esc(o.l)}</span></span>${o.v === cur ? I.tick : ''}</button>`).join('')
          : '<div class="pop-empty">No matches</div>');
        [...listEl.querySelectorAll('.pop-opt')].forEach((oel, i) => {
          oel.addEventListener('click', () => pick(filtered[i]));
          oel.addEventListener('mousemove', () => idx !== i && setIdx(i));
        });
        const curIdx = filtered.findIndex((o) => o.v === cur);
        setIdx(curIdx >= 0 ? curIdx : (filtered.length ? 0 : -1));
        placePop(btn);
      };
      paintList();
      if(!input)listEl.focus();
      requestAnimationFrame(() => { if (POP.el === el) placePop(btn); });
      if (input) {
        input.focus();
        input.addEventListener('input', () => { q = input.value.trim().toLowerCase(); paintList(); });
      }
      POP.onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); restoreOpener(rememberOpener(btn)); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); if (filtered.length) setIdx(Math.min(idx + 1, filtered.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (filtered.length) setIdx(Math.max(idx - 1, 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); if (idx >= 0 && filtered[idx]) pick(filtered[idx]); }
        else if (e.key === 'Tab') { closePop(); if (btn.isConnected) btn.focus({preventScroll:true}); }
      };
      document.addEventListener('keydown', POP.onKey, true);
    },
    dateTyping(key) {
      const wrap = document.querySelector(`[data-date-key="${UIEscape(key)}"]`);
      if (wrap) { normalizeInput(wrap.querySelector('.date-text')); dateFieldError(wrap, ''); }
    },
    dateBlur(ev, key) {
      if(rendering)return;
      if (POP.id === 'dp:' + key) return;
      commitDate(key, ev.target.value);
    },
    dateKey(ev, key) {
      if (ev.isComposing||ev.keyCode===229) return;
      if(ev.key==='Enter'&&ev.repeat){ev.preventDefault();return;}
      if (ev.key === 'Enter') { ev.preventDefault(); commitDate(key, ev.target.value, true); }
      else if (ev.key === 'Escape') {
        ev.preventDefault(); ev.stopPropagation(); closePop(true);
        ev.target.value = DPS[key].value || '';
        dateFieldError(ev.target.closest('.date-field'), '');
      } else if (ev.key === 'ArrowDown' && ev.altKey) {
        ev.preventDefault(); ev.target.closest('.date-field').querySelector('.date-trigger').click();
      }
    },
    popDate(ev, key) {
      ev.preventDefault();
      const def = DPS[key];
      if (!def || def.disabled) return;
      const btn = ev.currentTarget, wrap = btn.closest('.date-field'), input = wrap.querySelector('.date-text');
      if (POP.id === 'dp:' + key) { closePop(true); input.focus(); return; }
      const enteredDate = parseDateInput(input.value);
      let focusDate = enteredDate || def.value || iso(today);
      let view = focusDate.slice(0, 7);
      const el = openPop(wrap.querySelector('.date-control'), 262);
      POP.id = 'dp:' + key; POP.dateTrigger = btn;
      el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', input.getAttribute('aria-label') + ' calendar');
      btn.setAttribute('aria-expanded', 'true');
      POP.onClose = () => { if (input.isConnected) commitDate(key, input.value); };
      const pick = (ds) => {
        if (!commitDate(key, ds)) return;
        closePop(); input.focus();
      };
      const paint = (focus = false) => {
        const changedMonth=el.dataset.month&&el.dataset.month!==view;el.dataset.month=view;
        setHTML(el,calHtml(view, enteredDate === null ? def.value : enteredDate, focusDate, def));
        placePop(wrap.querySelector('.date-control'));if(changedMonth)fadeContent(el.querySelector('.cal-grid'));
        el.querySelectorAll('.cal-d').forEach((b) => b.addEventListener('click', () => pick(b.dataset.d)));
        el.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
          const target = d(view + '-01'); target.setUTCMonth(target.getUTCMonth() + Number(b.dataset.nav));
          if (target.getUTCFullYear() < 1 || target.getUTCFullYear() > 9999) return;
          view = iso(target).slice(0, 7); focusDate = iso(target); paint(true);
        }));
        el.querySelector('[data-today]').addEventListener('click', () => pick(iso(today)));
        const clear = el.querySelector('[data-clear]'); if (clear) clear.addEventListener('click', () => pick(''));
        if (focus) (el.querySelector(`.cal-d[data-d="${UIEscape(focusDate)}"]:not(:disabled)`) || el.querySelector('.cal-d:not(:disabled)') || el.querySelector('[data-nav]')).focus();
      };
      paint(true);
      POP.onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(true); input.focus(); return; }
        if (e.key === 'Tab') { closePop(); input.focus(); return; }
        if (!el.contains(e.target) || !e.target.matches('.cal-d')) return;
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
        if (step) {
          e.preventDefault(); const next = d(e.target.dataset.d); next.setUTCDate(next.getUTCDate() + step);
          const candidate = parseDateInput(iso(next));
          if (!candidate || dateError(def, candidate)) return;
          focusDate = candidate; view = focusDate.slice(0, 7); paint(true);
        }
      };
      document.addEventListener('keydown', POP.onKey, true);
    },

    refresh: render,
    refreshBackground,
    isRendering:()=>rendering,
    clearBoardFilters(){cancelBoardSearch();state.boardTracks=[];state.boardEpics=[];state.boardAssignees=[];state.boardQ='';state.boardBlocked=false;state.boardLimits={planning:50,progress:50,review:50,done:50};if(bootWindow.OneloopRuntime){bootWindow.OneloopRuntime.invoke('board.filter',App.context().board).catch(bootWindow.OneloopRuntime.report);return;}render();},
    retryPool(){bootWindow.OneloopRuntime?.invoke('pool.select',{scope:state.poolTab}).catch(bootWindow.OneloopRuntime.report);},
    loadMoreBoard(col){if(bootWindow.OneloopRuntime){bootWindow.OneloopRuntime.invoke('board.more',{status:col}).catch(bootWindow.OneloopRuntime.report);return;}state.boardLimits[col]=(state.boardLimits[col]||50)+50;applyBoardFilters(false);},
    loadMoreUsers(){const count=document.querySelectorAll('.user-row').length;state.usersLimit+=50;render();[...document.querySelectorAll('.user-row')].slice(count).forEach(el=>UIMotion.enter(el));},
    loadOlderActivity(id){state.activityLimits[id]=(state.activityLimits[id]||50)+50;const timeline=document.querySelector('.task-page .timeline'),task=taskById(id);if(timeline&&task){const scroll=document.querySelector('.task-page'),before=scroll.scrollHeight;setHTML(timeline,taskFeedHtml(task,canBoard()));scroll.scrollTop+=scroll.scrollHeight-before;fadeContent(timeline);}},
    taskMoveMenu(event,id){
      if(App._boardMovePending)return;
      if(!canBoard())return;const task=taskById(id),list=boardTasks().filter(t=>t.state===task.state),index=list.indexOf(task),r=event.currentTarget.getBoundingClientRect();
      const items=COLS.filter(c=>c.key!==task.state).map(c=>({label:'Move to '+c.name,fn:()=>{if(canBoard()){if(setTaskState(task,c.key)!==false){render();focusMovedTask(id);}}}}));
      if(index>0)items.push({label:'Move up',fn:()=>App.moveTaskOrder(id,list[index-1].id,true)});
      if(index<list.length-1)items.push({label:'Move down',fn:()=>App.moveTaskOrder(id,list[index+1].id,false)});
      App._openMenu(items,r.left,r.bottom+6,{trigger:event.currentTarget});
    },
    moveTaskOrder(id,anchor,before){if(!canBoard())return;const task=taskById(id),target=taskById(anchor);if(!task||!target||task.state!==target.state)return;const old=motionRects('.card[data-task]');D.tasks.splice(D.tasks.indexOf(task),1);D.tasks.splice(D.tasks.indexOf(target)+(before?0:1),0,task);render();focusMovedTask(id);animateLayout(old,'.card[data-task]');},

    // filters
    setBoardQ(v,event) {
      cancelBoardSearch();
      state.boardQ = v.trim();
      if (event?.isComposing) return;
      if (!event || !v) { applyBoardFilters(); return; }
      const projectId=state.projectId, sessionId=D.session?.id;
      boardSearchTimer=setTimeout(()=>{
        if(state.view==='board'&&state.projectId===projectId&&D.session?.id===sessionId)applyBoardFilters();
      },180);
    },
    boardSearchKey(event) {
      if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(boardSearchTimer)applyBoardFilters();}
    },
  };
  window.App = App;

  // Pointer gestures share the existing destination, optimistic-save and rollback
  // paths. Touch/pen start on grips so the rest of the Board remains scrollable.
  let pointerDrag = null, suppressDragClickUntil = 0;
  function pointerEvent(event, currentTarget) {
    const drag = pointerDrag;
    return {target:drag.source,currentTarget,clientX:drag.x,clientY:drag.y,
      dataTransfer:drag.transfer,preventDefault:()=>event?.preventDefault()};
  }
  function updatePointerTarget() {
    const drag = pointerDrag; if (!drag?.started || !App._drag) return;
    const hit = document.elementFromPoint(drag.x,drag.y);
    const target = hit?.closest(drag.kind === 'task' ? '.col[data-col]' : '.lane[data-track]');
    if (drag.target && drag.target !== target) {
      drag.target.classList.remove('drop'); App._ind()?.remove(); App._dropBefore=null; App._laneBefore=null;
    }
    drag.target = target;
    if (target) {
      if (drag.kind === 'task') App.colOver(pointerEvent(null,target));
      else App.laneOver(pointerEvent(null,target));
    }
    const preview=App._dragPreview;
    if (preview) { preview.style.left=(drag.x-drag.offsetX)+'px'; preview.style.top=(drag.y-drag.offsetY)+'px'; }
  }
  function pointerScroll() {
    const drag=pointerDrag;if(!drag?.started)return;
    if(!drag.source.isConnected || !App._drag){finishPointerDrag(false);return;}
    const speed=(value,min,max)=>value<min+40?-Math.min(18,(min+40-value)/3):value>max-40?Math.min(18,(value-max+40)/3):0;
    const viewport=document.querySelector(drag.kind==='task'?'.board':'.rm-scroll');
    if(viewport){const rect=viewport.getBoundingClientRect();viewport.scrollLeft+=speed(drag.x,rect.left,rect.right);if(drag.kind==='track')viewport.scrollTop+=speed(drag.y,rect.top,rect.bottom);}
    const list=drag.target?.querySelector('.col-cards');
    if(list){const rect=list.getBoundingClientRect();list.scrollTop+=speed(drag.y,rect.top,rect.bottom);}
    updatePointerTarget();drag.frame=requestAnimationFrame(pointerScroll);
  }
  function finishPointerDrag(commit,event) {
    const drag=pointerDrag;if(!drag)return;
    cancelAnimationFrame(drag.frame);
    if(drag.started){
      suppressDragClickUntil=Date.now()+400;
      if(commit && drag.source.isConnected){
        updatePointerTarget();
        if(drag.target && App._drag){
          if(drag.kind==='task')App.dropTask(pointerEvent(event,drag.target),drag.target.dataset.col);
          else App.trackDrop(pointerEvent(event,drag.target),drag.target.dataset.track);
        }
      }
      App.dragEnd(false);
    }
    pointerDrag=null;
    if(drag.source.hasPointerCapture?.(drag.pointerId))drag.source.releasePointerCapture(drag.pointerId);
  }
  document.addEventListener('pointerdown',event=>{
    suppressDragClickUntil=0;
    if(!event.isPrimary){if(pointerDrag)finishPointerDrag(false);return;}
    if(event.button!==0 || pointerDrag || state.modal || state.peek || state.menu) return;
    const grip=event.target.closest('.grip'),card=event.target.closest('.card[data-task]');
    const kind=grip?'track':card?'task':null;
    if(!kind || (kind==='track'?!canRoadmap():!canBoard()))return;
    if(!grip && event.target.closest('button,a,input,textarea') && !event.target.closest('.card-move,.card-title-button'))return;
    if(!grip && ['touch','pen'].includes(event.pointerType) && !event.target.closest('.card-move'))return;
    const source=grip||card,rect=(grip?grip.closest('.lane').querySelector('.lane-head'):card).getBoundingClientRect();
    const values=new Map();
    pointerDrag={source,kind,id:grip?grip.closest('.lane').dataset.track:card.dataset.task,pointerId:event.pointerId,
      x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,offsetX:grip?24:event.clientX-rect.left,offsetY:grip?20:event.clientY-rect.top,
      transfer:{setData:(key,value)=>values.set(key,value),getData:key=>values.get(key),get types(){return [...values.keys()];},setDragImage(){}},started:false,target:null,frame:0};
  });
  document.addEventListener('pointermove',event=>{
    const drag=pointerDrag;if(!drag || drag.pointerId!==event.pointerId)return;
    if(!drag.source.isConnected){finishPointerDrag(false);return;}
    drag.x=event.clientX;drag.y=event.clientY;
    if(!drag.started){
      if(Math.hypot(drag.x-drag.startX,drag.y-drag.startY)<6)return;
      const synthetic=pointerEvent(event,drag.source);
      if(drag.kind==='task')App.taskDragStart(synthetic,drag.id);else App.trackDragStart(synthetic,drag.id);
      if(!App._drag){pointerDrag=null;return;}
      drag.started=true;drag.source.setPointerCapture?.(drag.pointerId);
      drag.frame=requestAnimationFrame(pointerScroll);
    }
    event.preventDefault();updatePointerTarget();
  },{passive:false});
  document.addEventListener('pointerup',event=>{if(pointerDrag?.pointerId===event.pointerId)finishPointerDrag(true,event);},true);
  document.addEventListener('pointercancel',event=>{if(pointerDrag?.pointerId===event.pointerId)finishPointerDrag(false);},true);
  document.addEventListener('lostpointercapture',event=>{if(pointerDrag?.pointerId===event.pointerId && event.target===pointerDrag.source && !pointerDrag.source.hasPointerCapture?.(event.pointerId))finishPointerDrag(false);},true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&pointerDrag){event.preventDefault();event.stopImmediatePropagation();finishPointerDrag(false);}},true);
  window.addEventListener('blur',()=>finishPointerDrag(false));
  document.addEventListener('click',event=>{if(event.detail>0 && Date.now()<suppressDragClickUntil){suppressDragClickUntil=0;event.preventDefault();event.stopImmediatePropagation();}},true);
  // Native HTML dragging would steal the pointer stream. Retain callable legacy
  // handlers only as a compatibility surface for the shared mutation model.
  document.addEventListener('dragstart',event=>{if(event.target.closest('.card,.grip')){event.preventDefault();event.stopImmediatePropagation();}},true);

  // ---------- global listeners ----------
  function resolveRoute() {
    const route=location.hash.replace(/^#\/?/,'') || 'roadmap';
    if(route.startsWith('task/')){
      let id;try{id=decodeURIComponent(route.slice(5));}catch{state.view='notfound';state.taskId=null;return;}
      state.taskId=id;
      const task=taskById(id);
      if(!task){state.view='notfound';state.taskId=id;return;}
      const epic=epicById(task.epicId),track=trackById(epic?.trackId);
      if(!track){state.view='notfound';return;}
      state.projectId=track.projectId;state.view=canReadTask(task)?'task':'forbidden';state.taskId=task.id;return;
    }
    state.taskId=null;
    if(route==='knowledge'||/^knowledge[/?]/.test(route)){
      const projectId=window.OneloopKnowledge?.route(route,state.projectId);
      if(projectId&&projectId!==state.projectId){
        if(!visibleProjects().some(project=>project.id===projectId)){state.view='notfound';return;}
        state.projectId=projectId;state.rmScrollLeft=null;state.boardTracks=[];state.boardEpics=[];state.boardAssignees=[];state.boardQ='';state.boardBlocked=false;
      }
      state.view='knowledge';return;
    }
    state.view=['roadmap','board','settings','profile','users','inbox','storage'].includes(route)?route:'notfound';
  }
  window.addEventListener('hashchange',(event)=>{
    window.Recovery?.clearPageError();
    // Local navigation already painted its destination. Consume only that
    // exact history event, so external hashes and Back/Forward still route.
    const index=locallyRenderedHashes.indexOf(event.newURL);
    if(index!==-1){locallyRenderedHashes.splice(index,1);return;}
    if(event.newURL && event.newURL!==location.href)return;
    state.peek=null;state.modal=null;state.menu=null;resolveRoute();render();
  });
  document.addEventListener('scroll', (e) => { if (!EPIC_TIP.el?.contains(e.target)) hideEpicTip(); }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && EPIC_TIP.el) { e.preventDefault(); e.stopImmediatePropagation(); hideEpicTip(); }
  }, true);
  document.addEventListener('focusin', (event) => {
    if (state.menu && !event.target.closest?.('#overlay-root > .menu')) dismissMenu(false);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || pendingConfirmation || document.querySelector('.confirmation-layer,.file-overlay') || POP.el?.contains(document.activeElement)) return;
    const panel = document.querySelector('#overlay-root > .modal-wrap .modal') || document.querySelector('#overlay-root > .peek');
    if (!panel && innerWidth <= 900 && state.sideOpen && !state.menu) {
      const controls = [...overlayControls(document.querySelector('.sidebar')), document.querySelector('.menu-btn')].filter(Boolean);
      const index = controls.indexOf(document.activeElement);
      event.preventDefault(); controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus(); return;
    }
    if (!panel) return;
    const controls = overlayControls(panel), first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); panel.focus(); return; }
    if (!panel.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.sideOpen && !state.menu && !state.modal && !state.peek && !POP.el) { e.preventDefault(); App.toggleSidebar(false); return; }
    if (e.key === 'Escape' && state.modal?.poolId) { App.returnToPool(); return; }
    if (e.key === 'Escape' && state.menu&&!state.modal&&!state.peek) {e.preventDefault();dismissMenu();return;}
    if (e.key === 'Escape' && (state.modal || state.menu || state.peek)) { e.preventDefault(); App.closeOverlays(); }
  });
  document.addEventListener('pointerdown', (e) => {
    clearTimeout(pressedControlTimer);
    pressedTaskControl=!!e.target.closest?.('.task-page,.peek,.modal');
    if (EPIC_TIP.el && !EPIC_TIP.el.contains(e.target) && !EPIC_TIP.anchor?.contains(e.target)) hideEpicTip();
  });
  const releasePressedControl=()=>{clearTimeout(pressedControlTimer);pressedControlTimer=setTimeout(()=>{pressedTaskControl=false;},0);};
  // Retain the guard through click dispatch and intervening promise callbacks.
  window.addEventListener('pointerup',releasePressedControl,true);
  window.addEventListener('pointercancel',releasePressedControl,true);
  window.addEventListener('click',releasePressedControl,true);
  window.addEventListener('blur',()=>{clearTimeout(pressedControlTimer);pressedTaskControl=false;});
  document.addEventListener('mousedown', (e) => {
    if (POP.el && !POP.el.contains(e.target) && !e.target.closest('.sel-btn')) closePop();
  });
  document.addEventListener('submit', (e) => {
    const form = e.target;
    for (const field of form.querySelectorAll('.field[data-required="true"]')) {
      const input = field.querySelector('input:not(:disabled), textarea:not(:disabled)');
      if (!input || ['checkbox','file'].includes(input.type)) continue;
      const value = input.type === 'password' ? input.value : input.value.trim();
      if (value) continue;
      e.preventDefault(); e.stopImmediatePropagation();
      const ctl = field.querySelector('.ctl');
      if (input.name) failField(form, input.name, 'This field is required.');
      else { ctl?.focus(); ctl?.classList.add('invalid'); }
      return;
    }
  }, true);
  document.addEventListener('beforeinput', (e) => {
    const input = e.target;
    if (!editableText(input) || input.disabled || input.readOnly || input.type === 'password' || e.isComposing) return;
    if (input.classList.contains('tp-title') && ['insertLineBreak', 'insertParagraph'].includes(e.inputType)) { e.preventDefault(); return; }
    if (inputKind(input) === 'date') {
      if (e.inputType.startsWith('delete')) {
        if (!e.cancelable) return;
        e.preventDefault(); editDateDigits(input, '', e.inputType); return;
      }
      if (e.inputType.startsWith('insert') && e.data !== null) {
        if (!e.cancelable) return;
        e.preventDefault();
        const digits = e.data.replace(/[^0-9]/g, '');
        if (digits) editDateDigits(input, digits);
        return;
      }
    } else if (e.data !== null && e.inputType.startsWith('insert')) {
      const from = input.selectionStart, to = input.selectionEnd;
      const proposed = input.value.slice(0, from) + e.data + input.value.slice(to);
      const clean = sanitizeInputValue(input, proposed);
      if (clean !== proposed && e.cancelable) {
        e.preventDefault(); insertCleanText(input, e.data);
      }
    }
  }, true);
  document.addEventListener('paste', (e) => {
    const input = e.target;
    if (!editableText(input) || input.disabled || input.readOnly || input.type === 'password') return;
    const text = e.clipboardData?.getData('text');
    if (text === undefined) return;
    if (inputKind(input) === 'date') { e.preventDefault(); if (/[0-9]/.test(text)) editDateDigits(input, text); }
    else if (sanitizeInputValue(input, text) !== text) { e.preventDefault(); insertCleanText(input, text); }
  }, true);
  document.addEventListener('input', (e) => { if(e.target.closest('.task-page'))clearTaskSaved();if (!e.isComposing) normalizeInput(e.target); }, true);
  document.addEventListener('compositionend', (e) => { normalizeInput(e.target);if(e.target.matches?.('[data-board-search]'))App.setBoardQ(e.target.value,e); }, true);
  document.addEventListener('input', (e) => {
    if (e.target.classList && (e.target.classList.contains('ctl') || e.target.classList.contains('tp-title'))) clearFieldError(e.target);
  });
  let rsz;
  window.addEventListener('resize', () => {
    hideEpicTip();
    clearTimeout(rsz);
    rsz = setTimeout(() => {
      syncSidebar();
      // Resize only the timeline; keep form input, focus, and open dialogs intact.
      const content = document.querySelector('.content');
      if (state.view === 'roadmap' && content && !window.Recovery?.pageError) {
        setHTML(content,renderRoadmap());
        mountRoadmap();
      }
      if (POP.el) {
        if (POP.anchor?.isConnected) placePop(POP.anchor);
        else closePop(true);
      }
      sizeDescription();
      sizeDescriptionEditors();
      placeMenu();
    }, 120);
  });

  collaboration?.bind(App,{task:taskById,canRead:canReadProject,projects:visibleProjects,view:()=>state.view,canBoard:task=>hasPermission('manage_board',trackById(epicById(task?.epicId)?.trackId)?.projectId),confirm:askConfirmation,refresh:render,refreshBackground,refreshActivity:refreshTaskActivity,exit:exitVisual,multi:multiHtml,log:logAct,clean:cleanStr,ago,instant:formatInstant,dateKey:instanceDateKey,previousDate,avatar:avatarHtml,
    revealBlockActivity:(id,blockId)=>{const task=taskById(id);if(!task)return;const items=[...Activity.visible(task.activity),...(task.comments||[]).filter(c=>!c.parentId)].sort((a,b)=>a.ts-b.ts),index=items.findIndex(item=>item.blockId===blockId);if(index>=0)state.activityLimits[id]=Math.max(state.activityLimits[id]||50,items.length-index);},
    refreshComments:(id,composer=false)=>{if(state.view!=='task'||state.taskId!==id)return;const task=taskById(id),timeline=document.querySelector('.task-page .timeline'),before=timeline?.getBoundingClientRect().height,rows=UIMotion.rows(timeline,'[data-comment]','data-comment'),focused=document.activeElement?.dataset.replyRoot;if(timeline){setHTML(timeline,taskFeedHtml(task,canBoard()));UIMotion.height(timeline,before);UIMotion.reflow(timeline,'[data-comment]','data-comment',rows);if(focused)[...timeline.querySelectorAll('[data-reply-root]')].find(el=>el.dataset.replyRoot===focused)?.focus({preventScroll:true});}if(composer){const home=document.querySelector('.comment-composer-home');if(home)setHTML(home,Collab.composerHtml(task));UIMotion.enter(document.querySelector('.collaboration-composer .reply-context'));}},
  });
  window.Recovery?.bind(App,{refresh:render,context:()=>({userId:me()?.id,projectId:state.projectId,taskId:state.taskId,view:state.view}),canWrite:(name,args)=>{if(!me()?.active)return false;if(['saveUser','saveProjectNew','updateProjectField'].includes(name))return isAdmin();if(['saveEpic','saveMilestone','saveTrack'].includes(name))return canRoadmap();if(['saveTask','poolKey'].includes(name))return name==='poolKey'&&state.poolTab==='mine'&&canReadProject(state.projectId)||canBoard();if(name==='saveBlock'){const task=taskById(args[1]);return !!task&&hasPermission('manage_board',trackById(epicById(task.epicId)?.trackId)?.projectId);}if(name==='addComment')return !!collaboration?.canComment(taskById(args[0]));if(['updTask'].includes(name)){const task=taskById(args[0]);return !!task&&hasPermission('manage_board',trackById(epicById(task.epicId)?.trackId)?.projectId);}return true;}});
  window.Uploads?.bind(App,{confirm:askConfirmation,task:taskById,canRead:id=>canReadTask(taskById(id)),can:id=>hasPermission('manage_board',trackById(epicById(taskById(id)?.epicId)?.trackId)?.projectId),log:logAct,refresh:render,me,instant:formatInstant,refreshActivity:refreshTaskActivity,refreshAttachments:id=>{if(state.view!=='task'||state.taskId!==id)return;const template=document.createElement('template');setHTML(template,renderTask());const oldAttachments=document.querySelector('.task-attachments'),before=oldAttachments?.getBoundingClientRect().height,rows=UIMotion.rows(oldAttachments,'[data-attachment-id]','data-attachment-id');oldAttachments?.replaceWith(template.content.querySelector('.task-attachments'));const nextAttachments=document.querySelector('.task-attachments');UIMotion.height(nextAttachments,before);UIMotion.reflow(nextAttachments,'[data-attachment-id]','data-attachment-id',rows);refreshTaskActivity(id);window.Uploads.mount(id);}});
  setInterval(()=>{
    const key=instanceDateKey(instanceNow());if(key===iso(today))return;today.setTime(+d(key));
    if(!D.session||me()?.mustChange)return;
    if ((state.view==='roadmap'||state.peek) && bootWindow.OneloopRuntime) bootWindow.OneloopRuntime.invoke('date.rollover',{}).catch(()=>{});
    if(state.view==='task'){
      const late=overdue(taskById(state.taskId)),row=document.querySelector('.task-property-date');
      row?.classList.toggle('late',late);const label=row?.querySelector('.task-overdue');if(label)label.hidden=!late;
    }else if(state.view==='board')App.refreshBoard();
    else if(state.view==='roadmap')App.refreshRoadmap();
    else if(state.view==='inbox')refreshBackground();
  },60000);
  ensureToastRegion();
  resolveRoute();
  if(!bootWindow.ONELOOP_DEFER_BOOT_RENDER)render();
})();
