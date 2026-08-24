/* ============================================================
   Circuit Legend — offline breaker panel documentation
   Vanilla JS. No build step. No network required.
   ============================================================ */
'use strict';

/* ---------- tiny helpers ---------- */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const uid = p => (p || 'x') + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const el = (tag, attrs, kids) => {
  const n = document.createElement(tag);
  for (const k in (attrs || {})) {
    if (k === 'class') n.className = attrs[k];
    else if (k === 'html') n.innerHTML = attrs[k];
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) n.setAttribute(k, attrs[k]);
  }
  (kids || []).forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return n;
};
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}

/* ---------- storage: IndexedDB with in-memory fallback ----------
   The fallback keeps the app usable in sandboxed previews where
   storage APIs are blocked. Deployed, it persists normally.      */
const Store = (() => {
  /* Storage name is deliberately unchanged across the rename from
     "Panel Book": it is the key existing projects live under, and renaming
     it would orphan anyone's saved data. It stays origin-unique either way. */
  const NAME = 'breakerpanel.db', VER = 1;
  let db = null, memory = false;
  const mem = { kv: new Map(), blobs: new Map() };

  function open() {
    return new Promise(res => {
      let req;
      try { req = indexedDB.open(NAME, VER); } catch (e) { memory = true; return res(); }
      if (!req) { memory = true; return res(); }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
      };
      req.onsuccess = () => { db = req.result; res(); };
      req.onerror = () => { memory = true; res(); };
      setTimeout(() => { if (!db && !memory) { memory = true; res(); } }, 2500);
    });
  }
  function tx(store, mode, fn) {
    return new Promise((res, rej) => {
      if (memory || !db) return res(fn(null, mem[store]));
      try {
        const t = db.transaction(store, mode), s = t.objectStore(store);
        const r = fn(s, null);
        t.oncomplete = () => res(r && r.result !== undefined ? r.result : r);
        t.onerror = () => rej(t.error);
      } catch (e) { memory = true; res(fn(null, mem[store])); }
    });
  }
  return {
    open, isMemory: () => memory,
    get: (store, k) => tx(store, 'readonly', (s, m) => m ? m.get(k) : s.get(k)),
    put: (store, k, v) => tx(store, 'readwrite', (s, m) => m ? (m.set(k, v), v) : s.put(v, k)),
    del: (store, k) => tx(store, 'readwrite', (s, m) => m ? m.delete(k) : s.delete(k)),
    keys: store => tx(store, 'readonly', (s, m) => m ? Array.from(m.keys()) : s.getAllKeys())
  };
})();

/* ---------- domain constants ---------- */
const BREAKER_TYPES = ['Standard', 'GFCI', 'AFCI', 'Dual Function', 'CAFCI', 'Main', 'Surge (SPD)', 'Spare', 'Blank'];
const AMP_CHOICES = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 125, 150, 175, 200];
/* Suggestions only. Space counts vary by manufacturer and series — 22, 26,
   34 and odd counts all exist — so the field accepts any number. */
const COMMON_SPACES = [4, 6, 8, 10, 12, 16, 18, 20, 22, 24, 26, 30, 32, 36, 40, 42, 48, 54, 60, 66, 84];
const WIRE_SIZES = ['14', '12', '10', '8', '6', '4', '3', '2', '1', '1/0', '2/0', '3/0', '4/0'];
/* 75 °C copper, the common residential reference. Advisory only. */
const AMPACITY = { '14': 15, '12': 20, '10': 30, '8': 50, '6': 65, '4': 85, '3': 100, '2': 115, '1': 130, '1/0': 150, '2/0': 175, '3/0': 200, '4/0': 230 };
/* NEC 240.4(D) small-conductor limits — what actually governs 14/12/10 */
const SMALL_COND = { '14': 15, '12': 20, '10': 30 };

const DEVICE_KINDS = [
  { k: 'outlet',    n: 'Outlet',       w: 0 },
  { k: 'light',     n: 'Light',        w: 60 },
  { k: 'switch',    n: 'Switch',       w: 0 },
  { k: 'fan',       n: 'Fan',          w: 75 },
  { k: 'appliance', n: 'Appliance',    w: 1200 },
  { k: 'hardwired', n: 'Hardwired',    w: 500 },
  { k: 'smoke',     n: 'Smoke/CO',     w: 10 },
  { k: 'junction',  n: 'Junction box', w: 0 },
  { k: 'panel',     n: 'Subpanel',     w: 0 },
  { k: 'other',     n: 'Other',        w: 0 }
];
/* Conventional circuit names, offered as autocomplete on the name field.
   Dedicated loads are named for the appliance; shared circuits are named
   "Area — what it feeds", because the question a directory answers is
   "if I switch this off, what goes dead?". */
const CIRCUIT_NAMES = [
  'Range', 'Cooktop', 'Wall oven', 'Dishwasher', 'Garbage disposal', 'Microwave', 'Refrigerator',
  'Clothes washer', 'Clothes dryer', 'Water heater', 'Furnace', 'Air handler', 'A/C condenser',
  'Heat pump', 'Well pump', 'Sump pump', 'Garage door opener', 'EV charger', 'Hot tub', 'Pool pump',
  'Kitchen — countertop receptacles', 'Kitchen — lights', 'Dining — receptacles',
  'Bathroom — receptacles', 'Bathroom — lights + fan', 'Bedrooms — receptacles', 'Bedrooms — lights',
  'Living — receptacles', 'Living — lights', 'Hall, stairs — lights', 'Laundry — receptacles',
  'Garage — receptacles', 'Basement — lights', 'Attic — lights', 'Outdoor — receptacles',
  'Outdoor — lights', 'Smoke alarms', 'Doorbell / low voltage'
];
const ROOM_TYPES = ['Kitchen', 'Bathroom', 'Bedroom', 'Living', 'Dining', 'Family', 'Office', 'Hallway', 'Closet',
  'Laundry', 'Garage', 'Basement', 'Attic', 'Crawlspace', 'Outdoor', 'Utility', 'Stairs', 'Other'];
/* Advisory expectations. Jurisdictions and code cycles vary. */
const GFCI_ROOMS = ['Kitchen', 'Bathroom', 'Garage', 'Outdoor', 'Basement', 'Laundry', 'Crawlspace', 'Utility'];
const AFCI_ROOMS = ['Bedroom', 'Living', 'Dining', 'Family', 'Office', 'Hallway', 'Closet', 'Kitchen', 'Laundry'];
const VERIFY = ['unverified', 'verified', 'suspect'];
const BREAKER_COLORS = ['', '#D2603A', '#4E8FA8', '#B39442', '#5FA86B', '#9B6BC4', '#D24F8E', '#7A8492'];

/* ---------- project ---------- */
function newProject(name) {
  const p = {
    app: 'circuit-legend', v: 1, id: uid('prj'), name: name || 'My House',
    created: Date.now(), updated: Date.now(),
    settings: { voltage: 120, voltage2: 240, defaultWire: '12', units: 'in', lockPins: false },
    panels: [], breakers: [], circuits: [], floors: [], rooms: [], devices: [], log: []
  };
  const pan = makePanel(p, { name: 'Main Panel', spaces: 40, mainAmps: 200, mainType: 'main' });
  p.mainPanelId = pan.id;
  return p;
}
function makePanel(p, o) {
  const pan = Object.assign({
    id: uid('pan'), name: 'Panel', brand: '', model: '', spaces: 40,
    mainType: 'main', mainAmps: 200, busAmps: 200, phase: 1,
    defaultWire: '12', tandemSlots: 'all', tandemList: '', location: '', notes: '', photoKey: null
  }, o || {});
  p.panels.push(pan);
  return pan;
}

/* ---------- slot geometry ----------
   Standard residential ladder: odd slots left, even right, numbering
   down the column. Slot s -> row floor((s-1)/2), col (s-1)%2.
   A 2-pole breaker at slot s occupies s and s+2 (same column).      */
const rowOf = s => Math.floor((s - 1) / 2);
const colOf = s => (s - 1) % 2;
const slotsFor = (slot, poles) => Array.from({ length: poles }, (_, i) => slot + i * 2);
function legOf(panel, slot) {
  const r = rowOf(slot);
  return panel.phase === 3 ? ['A', 'B', 'C'][r % 3] : ['A', 'B'][r % 2];
}
const LEG_COLOR = { A: 'var(--legA)', B: 'var(--legB)', C: 'var(--legC)' };

/* ---------- model queries ---------- */
const P = () => state.project;
const panelById   = id => P().panels.find(x => x.id === id);
const breakerById = id => P().breakers.find(x => x.id === id);
const circuitById = id => P().circuits.find(x => x.id === id);
const floorById   = id => P().floors.find(x => x.id === id);
const roomById    = id => P().rooms.find(x => x.id === id);
const deviceById  = id => P().devices.find(x => x.id === id);
const breakersOf  = pid => P().breakers.filter(b => b.panelId === pid).sort((a, b) => a.slot - b.slot);
const circuitsOf  = bid => P().circuits.filter(c => c.breakerId === bid);
const devicesOf   = cid => P().devices.filter(d => d.circuitId === cid);
const devicesOfBreaker = bid => circuitsOf(bid).flatMap(c => devicesOf(c.id));
const roomsOfFloor = fid => P().rooms.filter(r => r.floorId === fid);

/* ---------- control links ----------
   A switch is the one device that makes something else go dead without a
   breaker moving, so it carries `controls`: the ids of what it operates.
   The link is stored on the switch only; "what controls this light" is a
   filter, not a second field to keep in sync. It says nothing about how
   power gets there — that is still circuit -> breaker -> panel — so it
   stays out of traceToSource. */
const controlsOf    = d => (d.controls || []).map(deviceById).filter(Boolean);
const controllersOf = d => P().devices.filter(x => (x.controls || []).includes(d.id));
/* Offer the field on switches, and on anything that already has links so
   changing a device's kind cannot strand data out of sight. */
const takesControls = d => d.kind === 'switch' || (d.controls || []).length > 0;
const deviceName = d => d.label || (DEVICE_KINDS.find(k => k.k === d.kind) || {}).n || 'Device';
/* Two switches on one load is a 3-way; beyond that the names stop being
   worth arguing about, so say how many places instead. */
function multiwayNote(target, exclude) {
  const others = controllersOf(target).filter(x => x.id !== (exclude && exclude.id));
  if (!others.length) return '';
  return others.length === 1
    ? ` · 3-way with ${deviceName(others[0])}`
    : ` · switched from ${others.length + 1} places`;
}
/* The one cross-device edge in the model, and so the one thing a delete
   has to chase. Everything else hangs off a parent id and cleans up when
   the parent list is filtered. */
function dropControlLinks(ids) {
  const gone = ids instanceof Set ? ids : new Set(ids);
  P().devices.forEach(d => {
    if (d.controls && d.controls.some(id => gone.has(id)))
      d.controls = d.controls.filter(id => !gone.has(id));
  });
}
/* Projects that predate this field simply have none, and every reader
   tolerates that. What is worth cleaning on the way in is a hand-edited or
   partial JSON pointing at devices that are not in the file. */
function pruneControlLinks(p) {
  const live = new Set((p.devices || []).map(d => d.id));
  (p.devices || []).forEach(d => {
    if (!Array.isArray(d.controls)) { if (d.controls != null) delete d.controls; return; }
    d.controls = Array.from(new Set(d.controls.filter(id => id !== d.id && live.has(id))));
  });
}

function breakerAtSlot(panelId, slot) {
  return P().breakers.find(b => b.panelId === panelId && slotsFor(b.slot, b.poles).includes(slot));
}
/* Any breaker other than `exceptId` sitting on one of `slots`. Needed
   because a breaker being widened already claims its new slots, so a
   plain breakerAtSlot lookup would match itself and hide the clash. */
function occupant(panelId, slots, exceptId) {
  return P().breakers.find(b => b.panelId === panelId && b.id !== exceptId
    && slotsFor(b.slot, b.poles).some(s => slots.includes(s)));
}
function breakerLabel(b) {
  if (!b) return '—';
  const pan = panelById(b.panelId);
  const s = slotsFor(b.slot, b.poles).join('/');
  return `${pan ? pan.name : '?'} · ${s}${b.label ? ' — ' + b.label : ''}`;
}
function circuitLabel(c) {
  const b = breakerById(c.breakerId);
  return `${b ? b.slot : '?'}${c.sub || ''}${c.label ? ' — ' + c.label : (b && b.label ? ' — ' + b.label : '')}`;
}
function tiedWith(b) {
  if (!b.tieId) return [];
  return P().breakers.filter(x => x.tieId === b.tieId && x.id !== b.id);
}
/* Every breaker that would de-energize if this one is switched:
   itself, anything sharing its handle tie, and (recursively) all
   breakers in a subpanel it feeds. */
function affectedBreakers(b, seen) {
  seen = seen || new Set();
  if (seen.has(b.id)) return [];
  seen.add(b.id);
  let out = [b];
  tiedWith(b).forEach(t => { out = out.concat(affectedBreakers(t, seen)); });
  if (b.subpanelId) breakersOf(b.subpanelId).forEach(sb => { out = out.concat(affectedBreakers(sb, seen)); });
  return out;
}
function affectedDevices(b) {
  const set = new Map();
  affectedBreakers(b).forEach(x => devicesOfBreaker(x.id).forEach(d => set.set(d.id, d)));
  return Array.from(set.values());
}
/* device -> circuit -> breaker -> panel -> (feeding breaker) -> ... -> service */
function traceToSource(deviceOrCircuit) {
  const chain = [];
  let c = deviceOrCircuit.circuitId ? circuitById(deviceOrCircuit.circuitId) : deviceOrCircuit;
  if (deviceOrCircuit.circuitId) chain.push({ t: 'Device', n: deviceOrCircuit.label || 'device', id: deviceOrCircuit.id, kind: 'device' });
  let guard = 0;
  while (c && guard++ < 20) {
    const b = breakerById(c.breakerId); if (!b) break;
    const pan = panelById(b.panelId); if (!pan) break;
    chain.push({ t: 'Circuit', n: circuitLabel(c), id: c.id, kind: 'circuit' });
    chain.push({ t: 'Breaker', n: `Slot ${slotsFor(b.slot, b.poles).join('/')} · ${b.amps}A ${b.type}`, id: b.id, kind: 'breaker' });
    chain.push({ t: 'Panel', n: pan.name, id: pan.id, kind: 'panel' });
    const feeder = P().breakers.find(x => x.subpanelId === pan.id);
    if (!feeder) { chain.push({ t: 'Source', n: `${pan.mainType === 'main' ? pan.mainAmps + 'A main' : 'Main lugs'} · service`, kind: 'src' }); break; }
    c = circuitsOf(feeder.id)[0];
    if (!c) { chain.push({ t: 'Breaker', n: `Slot ${feeder.slot} (feeder)`, id: feeder.id, kind: 'breaker' }); break; }
  }
  return chain;
}

/* ---------- load math ---------- */
const breakerVolts = b => (b.poles >= 2 ? P().settings.voltage2 : P().settings.voltage);
const circuitVA = cid => devicesOf(cid).reduce((a, d) => a + (+d.watts || 0), 0);
/* A feeder breaker carries everything in the panel it feeds, so the
   balance and capacity numbers have to walk downstream. */
function breakerVA(bid, seen) {
  seen = seen || new Set();
  if (seen.has(bid)) return 0;
  seen.add(bid);
  const b = breakerById(bid); if (!b) return 0;
  let va = circuitsOf(bid).reduce((a, c) => a + circuitVA(c.id), 0);
  if (b.subpanelId) breakersOf(b.subpanelId).forEach(sb => { va += breakerVA(sb.id, seen); });
  return va;
}
function legLoads(panel) {
  const out = { A: 0, B: 0, C: 0 };
  breakersOf(panel.id).forEach(b => {
    const va = breakerVA(b.id); if (!va) return;
    const legs = slotsFor(b.slot, b.poles).map(s => legOf(panel, s));
    const share = va / legs.length;
    legs.forEach(l => out[l] += share);
  });
  return out;
}

/* ---------- state ---------- */
const state = {
  project: null,
  view: 'panel',
  panelId: null, floorId: null,
  sel: { breaker: null, circuit: null, device: null, room: null },
  plan: { k: 1, x: 0, y: 0 },
  onion: false, discovery: false, showAll: true, railHidden: false,
  devFilter: { q: '', floorId: '', roomId: '', kind: '', flag: '' },
  devSort: { key: 'label', dir: 1 },
  devSelected: new Set(),
  imgURL: {},           // floorId -> objectURL
  moving: null,         // breakerId being relocated on the ladder
  /* Which inspector sections are expanded. Kept here rather than on the
     DOM because render() rebuilds the rail on every keystroke. */
  disc: { config: false, move: false, naming: false, reland: false, notes: false, danger: false },
  busy: false,          // a backup is being built; block a second one
  undo: [], wake: null, sideOpen: false
};

/* ---------- persistence ---------- */
let saveTimer;
function snapshot() {
  try {
    state.undo.push(JSON.stringify(state.project));
    if (state.undo.length > 60) state.undo.shift();
  } catch (e) {}
}
function touch(skipSnapshot) {
  if (!skipSnapshot) { /* caller already snapshotted */ }
  P().updated = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 350);
}
async function save() {
  try { await Store.put('kv', 'project', JSON.parse(JSON.stringify(state.project))); } catch (e) {}
}
function undo() {
  const prev = state.undo.pop();
  if (!prev) return toast('Nothing to undo');
  state.project = JSON.parse(prev);
  save(); render(); toast('Change undone');
}
/* Wrap any mutation so undo and save are never forgotten. */
function edit(fn) { snapshot(); fn(); touch(); }

/* ============================================================
   PANEL VIEW — the signature element.
   Drawn as a real deadfront: two columns, odd left / even right,
   with a phase bus running down the centre so leg assignment and
   balance are readable at a glance.
   ============================================================ */
const ROWH = 34, COLW = 208, BUSW = 48, HEAD = 5;

function highlightSets() {
  const sel = new Set(), aff = new Set(), devs = new Set(), linked = new Set();
  const s = state.sel;
  if (s.breaker) {
    const b = breakerById(s.breaker);
    if (b) {
      sel.add(b.id);
      affectedBreakers(b).forEach(x => { if (x.id !== b.id) aff.add(x.id); });
      /* A tandem holds two independent breakers in one space, so choosing
         one half must not light up the other. Any other breaker expands to
         everything it feeds, including ties and subpanels. */
      if (s.circuit && circuitsOf(b.id).length > 1) devicesOf(s.circuit).forEach(d => devs.add(d.id));
      else affectedDevices(b).forEach(d => devs.add(d.id));
    }
  } else if (s.circuit) {
    const c = circuitById(s.circuit);
    if (c) { sel.add(c.breakerId); devicesOf(c.id).forEach(d => devs.add(d.id)); }
  }
  if (s.device) {
    const d = deviceById(s.device);
    if (d) {
      devs.add(d.id);
      const c = circuitById(d.circuitId);
      if (c) sel.add(c.breakerId);
      /* Control links are kept apart from `devs`: what a switch operates is
         not thereby on the selected circuit, and saying so in green would be
         a lie. They only earn the right not to be dimmed. Siblings on a
         3-way come along — selecting one half of a pair and having the other
         fade out would hide the half of the answer that matters. */
      controlsOf(d).forEach(x => { linked.add(x.id); controllersOf(x).forEach(sw => linked.add(sw.id)); });
      controllersOf(d).forEach(x => linked.add(x.id));
      linked.delete(d.id);
    }
  }
  if (s.room) {
    P().devices.filter(d => d.roomId === s.room).forEach(d => {
      devs.add(d.id);
      const c = circuitById(d.circuitId);
      if (c) aff.add(c.breakerId);
    });
  }
  return { sel, aff, devs, linked };
}

function svgEl(tag, attrs) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
  return n;
}

function renderPanelView() {
  const stage = $('#stage');
  stage.innerHTML = '';
  const pan = panelById(state.panelId) || P().panels[0];
  if (!pan) return;
  state.panelId = pan.id;

  /* A breaker being relocated: the ladder becomes a destination picker
     until a space is chosen or the move is cancelled. */
  if (state.moving && !breakerById(state.moving)) state.moving = null;
  let mv = state.moving ? breakerById(state.moving) : null;
  if (mv && mv.panelId !== pan.id) { state.moving = null; mv = null; }

  /* toolbar */
  const top = el('div', { class: 'stagetop' });
  const tools = el('div', { class: 'toolstrip' });
  tools.appendChild(el('span', { class: 'lbl' }, ['Panel']));
  const psel = el('select', { class: 'i', style: 'flex:0 0 auto;width:auto', onchange: e => { state.moving = null; state.panelId = e.target.value; state.sel = { breaker: null, circuit: null, device: null, room: null }; render(); } });
  P().panels.forEach(x => psel.appendChild(el('option', { value: x.id, selected: x.id === pan.id ? 'selected' : null }, [x.name])));
  tools.appendChild(psel);
  tools.appendChild(el('button', { class: 'iconbtn', onclick: addPanel }, ['+ Panel']));
  tools.appendChild(el('button', { class: 'iconbtn', onclick: () => openPanelSettings(pan) }, ['Panel setup']));
  tools.appendChild(el('span', { class: 'grow' }));
  tools.appendChild(el('button', { class: 'iconbtn' + (state.discovery ? ' on' : ''), onclick: toggleDiscovery }, ['Discovery mode']));
  tools.appendChild(el('button', { class: 'iconbtn', onclick: () => printDirectory(pan) }, ['Print directory']));
  top.appendChild(tools);
  if (mv) {
    const bar = el('div', { class: 'movebar' });
    bar.appendChild(el('span', {}, [`Moving slot ${slotsFor(mv.slot, mv.poles).join('/')}${mv.label ? ' — ' + trunc(mv.label, 24) : ''} — tap a destination`]));
    bar.appendChild(el('button', { onclick: cancelMove }, ['Cancel']));
    top.appendChild(bar);
  }
  stage.appendChild(top);

  const rows = Math.ceil(pan.spaces / 2);
  const W = COLW * 2 + BUSW, H = rows * ROWH + HEAD * 2;
  const { sel, aff } = highlightSets();

  const wrap = el('div', { id: 'panelWrap' });
  const dead = el('div', { class: 'deadfront', style: `max-width:${W + 30}px` });
  const loads = legLoads(pan);
  const plate = el('div', { class: 'plate' });
  plate.appendChild(el('div', {}, [pan.name]));
  plate.appendChild(el('div', { html: `<span>${pan.brand || 'brand —'} ${esc(pan.model || '')}</span>` }));
  plate.appendChild(el('div', { html: `<span>${pan.spaces} spaces · ${pan.mainType === 'main' ? pan.mainAmps + 'A main' : 'MLO'} · ${pan.phase === 3 ? '3Ø' : '1Ø'}</span>` }));
  dead.appendChild(plate);

  /* viewBox + fluid width: the ladder shrinks to fit a phone rather
     than forcing a horizontal scroll, and stays 1:1 on desktop. */
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': pan.name + ' breaker layout',
    width: W, height: H, style: `display:block;flex:0 0 auto`
  });

  /* bus stripe, coloured per phase leg */
  for (let r = 0; r < rows; r++) {
    const y = HEAD + r * ROWH, leg = legOf(pan, 2 * r + 1);
    svg.appendChild(svgEl('rect', { x: COLW, y, width: BUSW, height: ROWH, fill: LEG_COLOR[leg], opacity: .30 }));
    svg.appendChild(svgEl('line', { x1: COLW, y1: y + ROWH, x2: COLW + BUSW, y2: y + ROWH, stroke: '#0006', 'stroke-width': 1 }));
    /* slot numbers */
    [[2 * r + 1, COLW + 13], [2 * r + 2, COLW + BUSW - 13]].forEach(([num, x]) => {
      if (num > pan.spaces) return;
      const t = svgEl('text', { x, y: y + ROWH / 2 + 5, 'text-anchor': 'middle', fill: '#E8EDF3', 'font-size': 13, 'font-family': 'var(--mono)', 'font-weight': 700 });
      t.textContent = num; svg.appendChild(t);
    });
  }
  const legTxt = svgEl('text', { x: COLW + BUSW / 2, y: H - 1, 'text-anchor': 'middle', fill: '#8A94A3', 'font-size': 7, 'font-family': 'var(--mono)' });
  legTxt.textContent = 'BUS'; svg.appendChild(legTxt);

  /* empty spaces — clickable to add, or to receive a breaker being moved */
  for (let s = 1; s <= pan.spaces; s++) {
    if (breakerAtSlot(pan.id, s)) continue;
    const x = colOf(s) === 0 ? 0 : COLW + BUSW, y = HEAD + rowOf(s) * ROWH;
    const chk = mv ? moveCheck(mv, s) : null;
    const drop = !!(chk && chk.ok), no = !!(chk && !chk.ok);
    const g = svgEl('g', { class: 'slot', tabindex: no ? null : 0, role: 'button', style: no ? 'cursor:not-allowed' : 'cursor:pointer',
      'aria-label': mv ? (drop ? `Move to space ${s}` : `Space ${s} — will not fit`) : `Empty space ${s}. Add breaker.` });
    g.appendChild(svgEl('rect', { x: x + 3, y: y + 3, width: COLW - 6, height: ROWH - 6, rx: 2,
      fill: drop ? '#2A2415' : '#0d1014', stroke: drop ? 'var(--live)' : '#ffffff10',
      'stroke-width': drop ? 2 : 1, 'stroke-dasharray': '3 3', opacity: no ? .3 : 1 }));
    const t = svgEl('text', { x: x + COLW / 2, y: y + ROWH / 2 + 4, 'text-anchor': 'middle', fill: drop ? 'var(--live)' : '#4A525C', 'font-size': 11, 'font-family': 'var(--mono)', 'letter-spacing': '.1em', opacity: no ? .3 : 1 });
    t.textContent = drop ? 'MOVE HERE' : 'EMPTY'; g.appendChild(t);
    const act = drop ? () => moveBreaker(mv, s) : no ? () => toast(chk.why) : () => addBreaker(pan, s);
    g.addEventListener('click', act);
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
    svg.appendChild(g);
  }

  /* breakers */
  breakersOf(pan.id).forEach(b => {
    const x = colOf(b.slot) === 0 ? 0 : COLW + BUSW;
    const y = HEAD + rowOf(b.slot) * ROWH;
    const h = b.poles * ROWH;
    const cs = circuitsOf(b.id);
    const breakerSel = sel.has(b.id), isAff = aff.has(b.id);
    /* With no circuit picked, the whole breaker reads as selected; with one
       picked, only that half does. */
    const halfSel = c => state.sel.circuit ? state.sel.circuit === c.id : breakerSel;

    const g = svgEl('g', { style: 'cursor:pointer' });
    const body = b.color || (breakerSel ? '#3A424C' : '#242A32');
    g.appendChild(svgEl('rect', {
      x: x + 3, y: y + 3, width: COLW - 6, height: h - 6, rx: 3,
      fill: body, stroke: breakerSel ? 'var(--live)' : (isAff ? 'var(--live-dim)' : '#00000090'),
      'stroke-width': breakerSel ? 2 : (isAff ? 1.5 : 1)
    }));

    const nubX = colOf(b.slot) === 0 ? x + COLW - 16 : x + 6;
    const textX = colOf(b.slot) === 0 ? x + 11 : x + 22;
    const markX = colOf(b.slot) === 0 ? x + COLW - 26 : x + COLW - 12;

    const statusMarks = (target, cy, verify, locked) => {
      if (locked) {
        const l = svgEl('text', { x: markX - 11, y: cy + 4, fill: 'var(--live)', 'font-size': 12, 'text-anchor': 'middle' });
        l.textContent = '⚿'; target.appendChild(l);
      }
      if (verify === 'verified' || verify === 'suspect')
        target.appendChild(svgEl('circle', { cx: markX, cy, r: 3.5, fill: verify === 'verified' ? 'var(--ok)' : 'var(--bad)' }));
    };

    if (b.tandem && cs.length > 1) {
      /* Two half-height hit areas so A and B can be chosen separately. */
      cs.forEach((c, i) => {
        const hy = y + i * (ROWH / 2);
        const on = halfSel(c);
        const half = svgEl('g', {
          tabindex: 0, role: 'button', style: 'cursor:pointer',
          'aria-label': `Slot ${b.slot}${c.sub}, ${b.amps} amp ${b.type}${c.label ? ', ' + c.label : ''}`
        });
        half.appendChild(svgEl('rect', {
          x: x + 4, y: hy + (i ? 1 : 4), width: COLW - 8, height: ROWH / 2 - (i ? 5 : 5), rx: 2,
          fill: on ? 'var(--live)' : 'transparent', opacity: on ? .2 : 1,
          stroke: on ? 'var(--live)' : 'transparent', 'stroke-width': 1.5
        }));
        const tag = svgEl('text', { x: textX, y: hy + ROWH / 2 - 4, 'text-anchor': 'start',
          fill: on ? 'var(--live)' : '#7C8695', 'font-size': 10, 'font-family': 'var(--mono)', 'font-weight': 700 });
        tag.textContent = c.sub; half.appendChild(tag);
        const t = svgEl('text', { x: textX + 14, y: hy + ROWH / 2 - 4, 'text-anchor': 'start',
          fill: '#EDEFF2', 'font-size': 11.5, 'font-family': 'var(--mono)', 'font-weight': 700 });
        t.textContent = trunc(c.label || 'unlabeled', 20); half.appendChild(t);
        const act = () => selectCircuit(b.id, c.id);
        half.addEventListener('click', ev => { ev.stopPropagation(); act(); });
        half.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); act(); } });
        g.appendChild(half);
      });
      g.appendChild(svgEl('line', { x1: x + 6, y1: y + ROWH / 2, x2: x + COLW - 6, y2: y + ROWH / 2, stroke: '#ffffff26' }));
      g.appendChild(svgEl('rect', { x: nubX, y: y + h / 2 - 9, width: 10, height: 18, rx: 2, fill: breakerSel ? 'var(--live)' : '#9AA4B2' }));
      statusMarks(g, y + 11, b.verify, b.locked);
    } else {
      if (breakerSel || isAff) g.appendChild(svgEl('rect', { x: x + 3, y: y + 3, width: COLW - 6, height: h - 6, rx: 3, fill: 'var(--live)', opacity: breakerSel ? .18 : .09 }));
      g.appendChild(svgEl('rect', { x: nubX, y: y + h / 2 - 9, width: 10, height: 18, rx: 2, fill: breakerSel ? 'var(--live)' : '#9AA4B2' }));
      const t1 = svgEl('text', { x: textX, y: y + h / 2 - 1, 'text-anchor': 'start', fill: '#EDEFF2', 'font-size': 12.5, 'font-family': 'var(--mono)', 'font-weight': 700 });
      t1.textContent = trunc(b.label || 'unlabeled', 22);
      g.appendChild(t1);
      const t2 = svgEl('text', { x: textX, y: y + h / 2 + 13, 'text-anchor': 'start', fill: '#98A2B0', 'font-size': 10.5, 'font-family': 'var(--mono)' });
      const flags = [b.amps + 'A', b.poles > 1 ? b.poles + 'P' : null, b.type !== 'Standard' ? b.type : null,
        b.hacr ? 'HACR' : null, b.tieId ? 'TIE' : null, b.subpanelId ? 'SUB' : null, '#' + b.wire].filter(Boolean);
      t2.textContent = trunc(flags.join(' · '), 26);
      g.appendChild(t2);
      statusMarks(g, y + 12, b.verify, b.locked);
      g.setAttribute('tabindex', 0);
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', `Slot ${slotsFor(b.slot, b.poles).join(' and ')}, ${b.amps} amp ${b.type}${b.label ? ', ' + b.label : ''}${b.locked ? ', locked' : ''}`);
      const act = () => selectBreaker(b.id);
      g.addEventListener('click', act);
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
    }

    /* While a move is in flight the whole breaker becomes one target: an
       overlay on top of the normal artwork, so selection and the tandem
       half-buttons underneath stay untouched when the move ends. */
    if (mv) {
      const self = b.id === mv.id;
      const chk = self ? null : moveCheck(mv, b.slot);
      const ok = !self && chk.ok;
      const ov = svgEl('rect', {
        x: x + 3, y: y + 3, width: COLW - 6, height: h - 6, rx: 3,
        fill: self || ok ? 'var(--live)' : '#0F1216', opacity: self ? .12 : (ok ? .18 : .7),
        stroke: self || ok ? 'var(--live)' : 'none', 'stroke-width': 2,
        'stroke-dasharray': self ? '5 4' : null,
        style: ok || self ? 'cursor:pointer' : 'cursor:not-allowed'
      });
      ov.addEventListener('click', ev => {
        ev.stopPropagation();
        if (self) cancelMove();
        else if (ok) moveBreaker(mv, b.slot);
        else toast(chk.why);
      });
      g.appendChild(ov);
      if (ok) {
        /* A badge rather than bare text: it has to stay readable sitting
           on top of whatever label the breaker already carries. */
        g.appendChild(svgEl('rect', { x: x + COLW / 2 - 24, y: y + h / 2 - 9, width: 48, height: 18, rx: 2,
          fill: 'var(--live)', 'pointer-events': 'none' }));
        const sw = svgEl('text', { x: x + COLW / 2, y: y + h / 2 + 4, 'text-anchor': 'middle',
          fill: 'var(--ink)', 'font-size': 10, 'font-family': 'var(--mono)', 'font-weight': 700,
          'letter-spacing': '.1em', 'pointer-events': 'none' });
        sw.textContent = 'SWAP'; g.appendChild(sw);
      }
    }
    svg.appendChild(g);
  });

  /* handle-tie brackets: two independent breakers, one handle */
  const ties = {};
  breakersOf(pan.id).forEach(b => { if (b.tieId) (ties[b.tieId] = ties[b.tieId] || []).push(b); });
  Object.values(ties).forEach(grp => {
    if (grp.length < 2) return;
    grp.sort((a, b) => a.slot - b.slot);
    const sameCol = grp.every(b => colOf(b.slot) === colOf(grp[0].slot));
    const bx = colOf(grp[0].slot) === 0 ? COLW - 2 : COLW + BUSW + 2;
    const dir = colOf(grp[0].slot) === 0 ? 1 : -1;
    const ys = grp.map(b => HEAD + rowOf(b.slot) * ROWH + b.poles * ROWH / 2);
    const path = svgEl('path', {
      d: `M${bx} ${ys[0]} L${bx + 6 * dir} ${ys[0]} L${bx + 6 * dir} ${ys[ys.length - 1]} L${bx} ${ys[ys.length - 1]}`,
      fill: 'none', stroke: sameCol ? 'var(--live)' : 'var(--warn)', 'stroke-width': 2, opacity: .85
    });
    svg.appendChild(path);
  });

  /* On a phone the ladder is wider than the screen on purpose: legibility
     beats fitting. One column plus the bus is visible at a time. */
  const scroller = el('div', { class: 'ladderscroll' });
  scroller.appendChild(svg);
  const jump = el('div', { class: 'sidejump' });
  jump.appendChild(el('button', { onclick: () => scroller.scrollTo({ left: 0, behavior: 'smooth' }) }, ['◀ Odd 1–' + (pan.spaces - (pan.spaces % 2 ? 0 : 1))]));
  jump.appendChild(el('button', { onclick: () => scroller.scrollTo({ left: scroller.scrollWidth, behavior: 'smooth' }) }, ['Even 2–' + (pan.spaces - (pan.spaces % 2)) + ' ▶']));
  dead.appendChild(jump);
  dead.appendChild(scroller);
  wrap.appendChild(dead);
  wrap.addEventListener('click', e => {
    if (e.target.closest('g, button, input, select, textarea, label')) return;
    if (state.moving) return cancelMove();
    if (hasSelection()) clearSelection();
  });

  /* leg balance readout under the panel */
  const legs = pan.phase === 3 ? ['A', 'B', 'C'] : ['A', 'B'];
  const bal = el('div', { class: 'card', style: `margin-top:16px;width:100%;max-width:${W + 30}px` });
  bal.appendChild(el('h3', {}, ['Phase balance']));
  const maxL = Math.max(1, ...legs.map(l => loads[l]));
  legs.forEach(l => {
    const va = loads[l], amps = va / P().settings.voltage;
    const r = el('div', { style: 'margin-bottom:9px' });
    r.appendChild(el('div', { style: 'display:flex;justify-content:space-between;font:11px var(--mono);margin-bottom:3px', html: `<span style="color:${LEG_COLOR[l]}">LEG ${l}</span><span class="num">${Math.round(va)} VA · ${amps.toFixed(1)} A</span>` }));
    const bar = el('div', { class: 'bars' });
    bar.appendChild(el('i', { style: `width:${(va / maxL * 100).toFixed(1)}%;background:${LEG_COLOR[l]}` }));
    r.appendChild(bar);
    bal.appendChild(r);
  });
  const spread = legs.length === 2 && Math.max(loads.A, loads.B) > 0
    ? Math.abs(loads.A - loads.B) / Math.max(loads.A, loads.B) * 100 : 0;
  bal.appendChild(el('div', { class: 'hint', style: 'margin:6px 0 0' },
    [spread > 20 ? `Legs differ by ${spread.toFixed(0)}% — consider moving a large circuit to the lighter leg.`
      : 'Based on the connected VA you have entered. Add wattage to devices to sharpen this.']));
  wrap.appendChild(bal);
  stage.appendChild(wrap);
}
function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function selectCircuit(breakerId, circuitId) {
  if (state.discovery && state.discoveryBreaker !== undefined) state.discoveryBreaker = breakerId;
  state.sel = { breaker: breakerId, circuit: circuitId, device: null, room: null };
  state.sideOpen = true;
  render();
}
function selectBreaker(id) {
  if (state.discovery && state.discoveryBreaker !== undefined) { state.discoveryBreaker = id; }
  const cs = circuitsOf(id);
  state.sel = { breaker: id, circuit: cs.length > 1 ? cs[0].id : null, device: null, room: null };
  state.sideOpen = true;
  render();
}
function addBreaker(pan, slot) {
  edit(() => {
    const b = {
      id: uid('brk'), panelId: pan.id, slot, poles: 1, amps: 20, type: 'Standard',
      label: '', color: '', tandem: false, hacr: false, locked: false,
      wire: pan.defaultWire || P().settings.defaultWire, subpanelId: null, tieId: null,
      verify: 'unverified', notes: '', photoKey: null
    };
    P().breakers.push(b);
    P().circuits.push({ id: uid('cir'), breakerId: b.id, sub: null, label: '' });
    state.sel = { breaker: b.id, circuit: null, device: null, room: null };
  });
  state.sideOpen = true;
  render();
}
/* ---------- relocating a breaker ----------
   A rebuilt panel puts the same circuits on different spaces. Everything
   worth keeping — label, rating, wire, notes, photo, handle tie, and every
   circuit and device hanging off it — lives on the breaker record, so a
   move is a change of `slot` and nothing else. When the destination is
   taken the two breakers trade places, because that is what a rebuild
   usually amounts to.                                                    */
function moveCheck(b, slot) {
  const pan = panelById(b.panelId);
  if (!pan) return { ok: false, why: 'That breaker has no panel' };
  if (b.locked) return { ok: false, why: 'This breaker is locked — unlock it first' };
  if (slot === b.slot) return { ok: false, why: 'Already in slot ' + slot };
  const want = slotsFor(slot, b.poles);
  if (slot < 1 || want.some(s => s > pan.spaces))
    return { ok: false, why: `A ${b.poles}-pole breaker at slot ${slot} would run past slot ${pan.spaces}` };
  const inTheWay = P().breakers.filter(x => x.panelId === pan.id && x.id !== b.id
    && slotsFor(x.slot, x.poles).some(s => want.includes(s)));
  if (!inTheWay.length) return { ok: true, want };
  if (inTheWay.length > 1)
    return { ok: false, why: `${inTheWay.length} breakers sit across slot ${slot} — move them one at a time` };
  /* One occupant: it takes the slots this breaker is vacating. */
  const o = inTheWay[0];
  if (o.locked) return { ok: false, why: `Slot ${o.slot} is locked — unlock it first` };
  const back = slotsFor(b.slot, o.poles);
  if (back.some(s => s > pan.spaces))
    return { ok: false, why: `Slot ${o.slot} is ${o.poles}-pole and will not fit back into slot ${b.slot}` };
  if (back.some(s => want.includes(s)))
    return { ok: false, why: `Slots ${b.slot} and ${slot} overlap — the two cannot trade places` };
  const blocked = P().breakers.find(x => x.panelId === pan.id && x.id !== b.id && x.id !== o.id
    && slotsFor(x.slot, x.poles).some(s => back.includes(s)));
  if (blocked) return { ok: false, why: `Slot ${blocked.slot} blocks the swap back into slot ${b.slot}` };
  return { ok: true, want, swap: o, back };
}
/* Only the "listed slots" rule is enforceable from the model, and it is
   the same rule the Report checks, so the two never disagree. */
function tandemListed(pan, b, slot) {
  if (!b.tandem || pan.tandemSlots !== 'list') return true;
  return String(pan.tandemList || '').split(/[,\s]+/).filter(Boolean).map(Number).includes(slot);
}
function moveTargets(b) {
  const pan = panelById(b.panelId);
  const out = [];
  if (!pan || b.locked) return out;
  for (let s = 1; s <= pan.spaces; s++) {
    const chk = moveCheck(b, s);
    if (!chk.ok) continue;
    const where = chk.swap ? 'swap with ' + trunc(chk.swap.label || chk.swap.amps + 'A ' + chk.swap.type, 20) : 'empty';
    out.push([s, `${s} — ${where} · leg ${legOf(pan, s)}`]);
  }
  return out;
}
function moveBreaker(b, slot) {
  const chk = moveCheck(b, slot);
  if (!chk.ok) { toast(chk.why); return false; }
  const pan = panelById(b.panelId), from = b.slot;
  edit(() => { b.slot = slot; if (chk.swap) chk.swap.slot = from; });
  state.moving = null;
  /* Keep the tandem half that was open, but only if it is really this
     breaker's — a move started from the ladder can have anything selected. */
  const keep = circuitsOf(b.id).find(c => c.id === state.sel.circuit);
  state.sel = { breaker: b.id, circuit: keep ? keep.id : null, device: null, room: null };
  render();
  const stray = [b, chk.swap].filter(Boolean).filter(x => !tandemListed(pan, x, x.slot));
  toast((chk.swap ? `Slot ${from} and slot ${slot} swapped` : `Moved to slot ${slot} · leg ${legOf(pan, slot)}`)
    + (stray.length ? ' — tandem now in an unlisted slot, see checks' : ''));
  return true;
}
function startMoving(id) {
  const b = breakerById(id); if (!b) return;
  if (b.locked) return toast('This breaker is locked — unlock it first');
  if (!moveTargets(b).length) return toast('Nowhere in this panel it can go');
  state.moving = id;
  state.view = 'panel';
  state.panelId = b.panelId;
  if (isMobile()) state.sideOpen = false;
  render();
  toast('Tap a space in the ladder to move this breaker there');
}
function cancelMove() { state.moving = null; render(); }

/* Re-landing loads is the other half of a rebuild: the breaker stays put
   but the wires under it changed. Locked devices are left behind, the
   same way bulk edits in the Devices list treat them. */
function moveCircuitLoads(c, toId) {
  const to = circuitById(toId);
  if (!to || to.id === c.id) return;
  const ds = devicesOf(c.id);
  let moved = 0, held = 0;
  edit(() => { ds.forEach(d => { if (d.locked) { held++; return; } d.circuitId = to.id; moved++; }); });
  state.sel = { breaker: to.breakerId, circuit: circuitsOf(to.breakerId).length > 1 ? to.id : null, device: null, room: null };
  render();
  toast(`${moved} device${moved === 1 ? '' : 's'} moved to ${circuitLabel(to)}`
    + (held ? ` · ${held} locked and left behind` : ''));
}

function addPanel() {
  const name = prompt('Name for the new panel', 'Subpanel ' + (P().panels.length));
  if (!name) return;
  edit(() => { const p = makePanel(P(), { name, spaces: 20, mainType: 'mlo', mainAmps: 100 }); state.panelId = p.id; });
  render(); toast('Panel added');
}

/* ============================================================
   FLOOR PLAN VIEW
   Imported image as the base layer, pins in image coordinates,
   onion-skin underlay of the floor below, cross-floor badges.
   ============================================================ */
const KIND_GLYPH = {
  outlet: 'M-4,-5 h8 v10 h-8 z M-2,-2.5 v2 M2,-2.5 v2 M0,1.5 v2',
  light: 'M0,-6 a5,5 0 1,1 -0.1,0 M-2.5,5 h5 M-2,7 h4',
  switch: 'M-3.5,-6 h7 v12 h-7 z M-1,-2 h2 v5 h-2 z',
  fan: 'M0,0 m-6,0 a6,6 0 1,0 12,0 a6,6 0 1,0 -12,0 M0,0 L0,-6 M0,0 L5,3 M0,0 L-5,3',
  appliance: 'M-6,-6 h12 v12 h-12 z M-6,-2 h12 M-4,-4.5 h3',
  hardwired: 'M-6,0 h4 M2,0 h4 M-2,-4 v8 M2,-4 v8',
  smoke: 'M0,0 m-6,0 a6,6 0 1,0 12,0 a6,6 0 1,0 -12,0 M0,-2.5 a2.5,2.5 0 1,0 0.1,0',
  junction: 'M-5,-5 h10 v10 h-10 z M-5,-5 L5,5 M5,-5 L-5,5',
  panel: 'M-5,-7 h10 v14 h-10 z M-2,-4 h4 M-2,0 h4 M-2,4 h4',
  other: 'M0,0 m-5,0 a5,5 0 1,0 10,0 a5,5 0 1,0 -10,0'
};

function currentFloor() {
  if (!P().floors.length) return null;
  let f = floorById(state.floorId);
  if (!f) { f = P().floors.slice().sort((a, b) => a.level - b.level)[0]; state.floorId = f.id; }
  return f;
}

function renderPlanView() {
  const stage = $('#stage');
  stage.innerHTML = '';
  const host = el('div', { id: 'planHost', class: (state.placing || state.discovery) ? 'place' : '' });
  stage.appendChild(host);

  if (!P().floors.length) {
    host.appendChild(el('div', { class: 'planempty', html:
      `<h2>No floors yet</h2><p>Add a floor and import a plan image — a photo of a printed plan, a screenshot, or an export from any drawing tool. Then drop pins on it.</p>` }));
    host.querySelector('.planempty').appendChild(el('button', { class: 'iconbtn on', onclick: addFloor }, ['Add a floor']));
    return;
  }

  const f = currentFloor();
  const below = P().floors.filter(x => x.level < f.level).sort((a, b) => b.level - a.level)[0];
  const { sel, devs, linked } = highlightSets();
  const anyHighlight = devs.size > 0;

  const W = host.clientWidth || 900, H = host.clientHeight || 600;
  const svg = svgEl('svg', { width: '100%', height: '100%', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  const g = svgEl('g');
  state.planG = g; state.planPins = [];
  const t = state.plan;
  g.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`);

  /* onion-skin underlay */
  if (state.onion && below && state.imgURL[below.id]) {
    g.appendChild(svgEl('image', { href: state.imgURL[below.id], x: 0, y: 0, width: below.w, height: below.h, opacity: .15 }));
  }
  if (state.imgURL[f.id]) {
    g.appendChild(svgEl('image', { href: state.imgURL[f.id], x: 0, y: 0, width: f.w, height: f.h }));
  } else {
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: f.w || 900, height: f.h || 650, fill: '#1B1F25', stroke: '#3D4550', 'stroke-dasharray': '8 6' }));
    const tt = svgEl('text', { x: (f.w || 900) / 2, y: (f.h || 650) / 2, 'text-anchor': 'middle', fill: '#5A6472', 'font-size': 20, 'font-family': 'var(--mono)' });
    tt.textContent = 'No plan image — use “Import image”'; g.appendChild(tt);
  }

  /* ghost pins from the floor below, when onion is on */
  if (state.onion && below) {
    P().devices.filter(d => d.floorId === below.id).forEach(d => {
      const gg = svgEl('g', { transform: `translate(${d.x},${d.y}) scale(${1 / t.k})`, opacity: .3 });
      gg.appendChild(svgEl('circle', { r: 7, fill: 'none', stroke: '#8A94A3', 'stroke-dasharray': '2 2' }));
      state.planPins.push({ node: gg, x: () => d.x, y: () => d.y });
      g.appendChild(gg);
    });
  }

  /* Control links for whatever is selected, under the pins so the glyphs
     stay readable. Drawn only on selection: every switch in a house wired
     in at once would be a cobweb, not a drawing. Widths divide by the zoom
     because the line lives in image coordinates while pins are counter-
     scaled — without it the hairline fattens as you zoom in. */
  if (state.sel.device) {
    const d0 = deviceById(state.sel.device);
    if (d0) {
      const pairs = controlsOf(d0).map(t => [d0, t])
        .concat(controllersOf(d0).map(sw => [sw, d0]));
      pairs.forEach(([a, b2]) => {
        if (a.floorId !== f.id || b2.floorId !== f.id) return;   /* cross-floor pairs are named in the inspector instead */
        g.appendChild(svgEl('line', {
          x1: a.x, y1: a.y, x2: b2.x, y2: b2.y,
          stroke: 'var(--live)', 'stroke-width': 1.6 / t.k, opacity: .7,
          'stroke-dasharray': `${5 / t.k} ${4 / t.k}`, 'stroke-linecap': 'round'
        }));
      });
    }
  }

  /* pins */
  P().devices.filter(d => d.floorId === f.id).forEach(d => {
    const on = devs.has(d.id);
    const tied = linked.has(d.id);
    const dim = anyHighlight && !on && !tied;
    const pin = svgEl('g', {
      transform: `translate(${d.x},${d.y}) scale(${1 / t.k})`,
      style: 'cursor:pointer', tabindex: 0, role: 'button',
      opacity: dim ? .22 : 1,
      'aria-label': `${d.label || d.kind} in ${roomById(d.roomId) ? roomById(d.roomId).name : 'no room'}`
    });
    if (on) pin.appendChild(svgEl('circle', { r: 17, fill: 'var(--live)', opacity: .22 }));
    /* The other end of a control link: ringed, not filled — it is related
       to the selection, not energized by it. */
    if (tied && !on) pin.appendChild(svgEl('circle', { r: 15, fill: 'none', stroke: 'var(--live)', 'stroke-width': 1.2, 'stroke-dasharray': '2 3', opacity: .85 }));
    pin.appendChild(svgEl('circle', { r: 11, fill: on ? 'var(--live)' : '#11151A', stroke: on ? 'var(--live)' : (d.critical ? 'var(--bad)' : '#9AA4B2'), 'stroke-width': 2 }));
    pin.appendChild(svgEl('path', { d: KIND_GLYPH[d.kind] || KIND_GLYPH.other, fill: 'none', stroke: on ? '#1A1D21' : '#D5D1C5', 'stroke-width': 1.4, 'stroke-linecap': 'round' }));
    if (d.critical) pin.appendChild(svgEl('circle', { cx: 8, cy: -8, r: 3.5, fill: 'var(--bad)' }));
    if (pinLocked(d)) {
      const lk = svgEl('text', { x: 8, y: 12, 'text-anchor': 'middle', 'font-size': 9,
        fill: on ? '#1A1D21' : 'var(--steel-400)' });
      lk.textContent = '⚿'; pin.appendChild(lk);
    }
    if (d.verify === 'verified') pin.appendChild(svgEl('circle', { cx: -8, cy: -8, r: 3.5, fill: 'var(--ok)' }));
    if (state.showAll || on || tied) {
      const lab = svgEl('text', { y: 24, 'text-anchor': 'middle', fill: on ? 'var(--live)' : '#98A2B0', 'font-size': 10, 'font-family': 'var(--mono)', 'paint-order': 'stroke', stroke: '#0F1216', 'stroke-width': 3 });
      const c = circuitById(d.circuitId), b = c && breakerById(c.breakerId);
      lab.textContent = trunc(d.label || (b ? '#' + b.slot + (c.sub || '') : 'unassigned'), 18);
      pin.appendChild(lab);
    }
    pin.addEventListener('click', ev => {
      ev.stopPropagation();
      /* The pointer moved, so this was a drag or a pan, not a tap. */
      if (state.suppressPinClick) { state.suppressPinClick = false; return; }
      if (state.discovery && state.discoveryBreaker) { assignDeviceToDiscovery(d); return; }
      state.sel = { breaker: null, circuit: null, device: d.id, room: null };
      state.sideOpen = true; render();
    });
    pin.addEventListener('keydown', e => { if (e.key === 'Enter') { state.sel = { breaker: null, circuit: null, device: d.id, room: null }; render(); } });
    makeDraggable(pin, d);
    state.planPins.push({ node: pin, x: () => d.x, y: () => d.y });
    g.appendChild(pin);
  });

  svg.appendChild(g);
  host.appendChild(svg);

  /* floor stack — bottom floor at the bottom of the control, like a building */
  const stack = el('div', { class: 'floorstack' });
  P().floors.slice().sort((a, b) => a.level - b.level).forEach(fl => {
    const count = P().devices.filter(d => d.floorId === fl.id && devs.has(d.id)).length;
    stack.appendChild(el('button', {
      'aria-current': fl.id === f.id ? 'true' : 'false',
      onclick: () => { state.floorId = fl.id; fitPlan(); render(); }
    }, [fl.name + (count ? '  ●' + count : '')]));
  });
  stack.appendChild(el('button', { onclick: addFloor, style: 'color:var(--live)' }, ['+ Floor']));
  host.appendChild(stack);

  /* View controls live on the canvas, next to zoom — they belong to the
     plan itself and must not disappear behind whatever is selected. */
  const tools2 = el('div', { class: 'plantools' });
  const imp = el('input', { type: 'file', accept: 'image/*', style: 'display:none',
    onchange: e => importFloorImage(f, e.target.files[0]) });
  tools2.appendChild(imp);
  tools2.appendChild(el('button', { title: 'Import or replace the plan image for this floor',
    onclick: () => imp.click() }, [f.imgKey ? 'Replace image' : 'Import image']));
  if (below) tools2.appendChild(el('button', { class: state.onion ? 'on' : '',
    title: 'Show the floor below as a faint underlay',
    onclick: () => { state.onion = !state.onion; render(); } }, ['Onion skin']));
  tools2.appendChild(el('button', { class: state.showAll ? 'on' : '',
    title: 'Show a label under every pin',
    onclick: () => { state.showAll = !state.showAll; render(); } }, ['Labels']));
  tools2.appendChild(el('button', { class: state.discovery ? 'on' : '',
    title: 'Switch a breaker off and tap whatever went dead',
    onclick: toggleDiscovery }, ['Discovery']));
  tools2.appendChild(el('button', { class: P().settings.lockPins ? 'on' : '',
    title: 'Stop every pin on every floor from being dragged',
    onclick: () => { edit(() => { P().settings.lockPins = !P().settings.lockPins; });
      toast(P().settings.lockPins ? 'Pins locked' : 'Pins unlocked'); render(); } },
    [P().settings.lockPins ? 'Pins locked' : 'Lock pins']));
  tools2.appendChild(el('button', { title: 'Rename this floor, set its level, manage its rooms',
    onclick: () => { state.railHidden = false; clearSelection(); state.sideOpen = true; syncSheet(); } }, ['Floor setup']));
  host.appendChild(tools2);

  /* zoom controls */
  const z = el('div', { class: 'zoomctl' });
  z.appendChild(el('button', { title: 'Zoom out', onclick: () => zoomBy(1 / 1.25) }, ['−']));
  z.appendChild(el('button', { title: 'Zoom in', onclick: () => zoomBy(1.25) }, ['+']));
  z.appendChild(el('button', { title: 'Fit to window', onclick: () => { fitPlan(); applyPlanTransform(); }, style: 'font-size:11px' }, ['FIT']));
  host.appendChild(z);

  /* banners share one stack so they never sit on top of each other */
  const bstack = el('div', { class: 'bannerstack' });
  if (state.placing) {
    const c = circuitById(state.placing.circuitId);
    const pb = el('div', { class: 'banner' });
    pb.appendChild(el('span', {}, [c ? `Tap the plan to add to ${circuitLabel(c)}` : 'Tap the plan to add a device']));
    pb.appendChild(el('button', { onclick: () => { state.placing = null; render(); } }, ['Done']));
    bstack.appendChild(pb);
  }
  if (state.discovery) {
    const b = breakerById(state.discoveryBreaker);
    const bn = el('div', { class: 'banner' });
    bn.appendChild(el('span', {}, [b ? `Mapping slot ${b.slot} — tap dead devices` : 'Pick a breaker in the Panel view']));
    bn.appendChild(el('button', { onclick: toggleDiscovery }, ['Done']));
    bstack.appendChild(bn);
  }
  const others = P().floors.filter(fl => fl.id !== f.id)
    .map(fl => ({ fl, n: P().devices.filter(d => d.floorId === fl.id && devs.has(d.id)).length })).filter(o => o.n);
  if (others.length) {
    const b = el('div', { class: 'banner alt' });
    b.appendChild(el('span', {}, ['Also on ']));
    others.forEach(o => b.appendChild(el('button', { onclick: () => { state.floorId = o.fl.id; render(); } }, [`${o.fl.name} · ${o.n}`])));
    bstack.appendChild(b);
  }
  if (bstack.children.length) host.appendChild(bstack);

  wirePlanGestures(host, svg);
  if (!state.planFitted) { state.planFitted = true; fitPlan(); requestAnimationFrame(render); }
}

/* Pan and zoom only move the transform. Rebuilding the whole view on
   every wheel tick was both slow and unnecessary — pins just need their
   counter-scale refreshed so they stay a constant size on screen. */
function applyPlanTransform() {
  const t = state.plan;
  if (state.planG) state.planG.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
  (state.planPins || []).forEach(p => p.node.setAttribute('transform', `translate(${p.x()},${p.y()}) scale(${1 / t.k})`));
}
function zoomBy(m, cx, cy) {
  const host = $('#planHost'); if (!host) return;
  const W = host.clientWidth, H = host.clientHeight;
  cx = cx === undefined ? W / 2 : cx; cy = cy === undefined ? H / 2 : cy;
  const t = state.plan, nk = clamp(t.k * m, 0.05, 12);
  const r = nk / t.k;
  t.x = cx - (cx - t.x) * r; t.y = cy - (cy - t.y) * r; t.k = nk;
  applyPlanTransform();
}
function fitPlan() {
  const host = $('#planHost'), f = currentFloor();
  if (!host || !f) return;
  const W = host.clientWidth || 900, H = host.clientHeight || 600;
  const fw = f.w || 900, fh = f.h || 650;
  const k = Math.min(W / fw, H / fh) * 0.92;
  state.plan = { k, x: (W - fw * k) / 2, y: (H - fh * k) / 2 };
}
function wirePlanGestures(host, svg) {
  /* No setPointerCapture here. Capturing the pointer on the host makes the
     browser dispatch the following `click` to the host instead of whatever
     was actually under the cursor, which silently swallowed both the zoom
     buttons and plan clicks. Window-level move/up listeners give us the
     same drag behaviour with the click target left intact. */
  if (state.planCleanup) state.planCleanup();
  const pts = new Map();
  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  const isControl = e => !!(e.target.closest && e.target.closest('button'));

  const onDown = e => {
    if (isControl(e) || state.dragPin) return;
    state.suppressPinClick = false;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size > 1) { dragging = false; return; }
    dragging = true; moved = false;
    sx = e.clientX; sy = e.clientY; ox = state.plan.x; oy = state.plan.y;
    host.classList.add('drag');
  };
  const onMove = e => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = Array.from(pts.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (state.pinchD) {
        const r = host.getBoundingClientRect();
        zoomBy(d / state.pinchD, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      }
      state.pinchD = d; dragging = false; return;
    }
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; state.suppressPinClick = true; }
    if (!moved) return;
    state.plan.x = ox + dx; state.plan.y = oy + dy;
    applyPlanTransform();
  };
  const onUp = e => {
    pts.delete(e.pointerId);
    if (pts.size < 2) state.pinchD = 0;
    dragging = false; host.classList.remove('drag');
  };

  host.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  host.addEventListener('wheel', e => {
    e.preventDefault();
    const r = host.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  /* A click that did not drag, on empty plan, while placing or in
     discovery, drops a new device. */
  host.addEventListener('click', e => {
    if (moved || state.dragPin || isControl(e)) return;
    if (state.placing || state.discovery) {
      const r = host.getBoundingClientRect();
      createDeviceAt((e.clientX - r.left - state.plan.x) / state.plan.k,
                     (e.clientY - r.top - state.plan.y) / state.plan.k);
      return;
    }
    /* Empty space clears the selection — the gesture people expect from a
       map, and the reason a Deselect button felt like it must do more. */
    if (hasSelection()) clearSelection();
  });

  state.planCleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
}
function makeDraggable(pin, d) {
  let moved = false, start = null;
  pin.addEventListener('pointerdown', e => {
    /* Locked: do not stop propagation, so the drag pans the plan as if the
       pin were part of the background. A click without movement still
       selects it. */
    if (pinLocked(d)) return;
    e.stopPropagation();
    state.suppressPinClick = false;
    start = { x: e.clientX, y: e.clientY, dx: d.x, dy: d.y };
    state.dragPin = true;
    pin.setPointerCapture(e.pointerId);
  });
  pin.addEventListener('pointermove', e => {
    if (!start) return;
    const mx = (e.clientX - start.x) / state.plan.k, my = (e.clientY - start.y) / state.plan.k;
    if (Math.abs(mx) + Math.abs(my) > 2) { moved = true; state.suppressPinClick = true; }
    if (!moved) return;
    d.x = start.dx + mx; d.y = start.dy + my;
    pin.setAttribute('transform', `translate(${d.x},${d.y}) scale(${1 / state.plan.k})`);
  });
  const end = () => {
    if (moved) { snapshot(); touch(); toast('Pin moved'); }
    start = null; moved = false; setTimeout(() => state.dragPin = false, 30);
  };
  pin.addEventListener('pointerup', end);
  pin.addEventListener('pointercancel', end);
}

function addFloor() {
  const name = prompt('Floor name', P().floors.length ? 'Floor ' + (P().floors.length + 1) : 'First Floor');
  if (!name) return;
  const lv = P().floors.length ? Math.max(...P().floors.map(f => f.level)) + 1 : 0;
  edit(() => {
    const f = { id: uid('flr'), name, level: lv, imgKey: null, w: 900, h: 650, notes: '' };
    P().floors.push(f); state.floorId = f.id;
  });
  state.planFitted = false;
  render(); toast('Floor added — import a plan image from the panel on the right');
}
function createDeviceAt(x, y) {
  const f = currentFloor(); if (!f) return;
  let circuitId = null;
  if (state.discovery && state.discoveryBreaker) {
    const cs = circuitsOf(state.discoveryBreaker);
    circuitId = cs.length ? cs[0].id : null;
  } else if (state.placing) circuitId = state.placing.circuitId;
  const kind = (state.placing && state.placing.kind) || 'outlet';
  const def = DEVICE_KINDS.find(k => k.k === kind);
  edit(() => {
    const d = {
      id: uid('dev'), circuitId, floorId: f.id, roomId: state.placing ? state.placing.roomId : null,
      x, y, kind, label: '', watts: def ? def.w : 0, critical: false, locked: false,
      verify: state.discovery ? 'verified' : 'unverified',
      controls: [], notes: '', photoKey: null
    };
    P().devices.push(d);
    state.sel = { breaker: state.discovery ? state.discoveryBreaker : null, circuit: null, device: state.discovery ? null : d.id, room: null };
  });
  render();
}
function assignDeviceToDiscovery(d) {
  const cs = circuitsOf(state.discoveryBreaker);
  if (!cs.length) return;
  edit(() => { d.circuitId = cs[0].id; d.verify = 'verified'; });
  render();
  /* Discovery reads "this went dead" as "this is on that breaker". A load
     with a switch has a second way of being dead, so say so before the
     assignment gets trusted. */
  const sw = controllersOf(d);
  toast(sw.length
    ? `Assigned to slot ${breakerById(state.discoveryBreaker).slot} — check ${sw.length === 1 ? deviceName(sw[0]) + ' was' : 'its switches were'} on`
    : 'Assigned to slot ' + breakerById(state.discoveryBreaker).slot);
}
async function toggleDiscovery() {
  state.discovery = !state.discovery;
  if (state.discovery) {
    state.discoveryBreaker = state.sel.breaker || null;
    try { state.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
    toast(state.discoveryBreaker ? 'Discovery on — tap devices that went dead' : 'Discovery on — select a breaker first');
  } else {
    try { state.wake && state.wake.release(); } catch (e) {}
    state.wake = null;
  }
  render();
}

/* ============================================================
   ROOMS VIEW — pick a room, see every breaker feeding it
   ============================================================ */
function renderRoomsView() {
  const stage = $('#stage'); stage.innerHTML = '';
  const tools = el('div', { class: 'toolstrip' });
  tools.appendChild(el('span', { class: 'lbl' }, ['Rooms']));
  tools.appendChild(el('button', { class: 'iconbtn', onclick: addRoom }, ['+ Room']));
  tools.appendChild(el('span', { class: 'grow' }));
  stage.appendChild(tools);

  const pad = el('div', { class: 'stagepad' });
  if (!P().rooms.length) {
    pad.appendChild(el('div', { class: 'empty' }, ['No rooms yet. Add rooms, then assign devices to them from the floor plan — selecting a room will light up every breaker that feeds it.']));
  }
  const byFloor = {};
  P().rooms.forEach(r => (byFloor[r.floorId] = byFloor[r.floorId] || []).push(r));
  P().floors.slice().sort((a, b) => a.level - b.level).forEach(f => {
    const rs = byFloor[f.id] || [];
    if (!rs.length) return;
    const card = el('div', { class: 'card' });
    card.appendChild(el('h3', {}, [f.name]));
    const tbl = el('table', { class: 'sched' });
    tbl.innerHTML = '<thead><tr><th>Room</th><th class="opt2">Type</th><th>Devices</th><th>Breakers</th><th class="opt">Connected VA</th></tr></thead>';
    const tb = el('tbody');
    rs.forEach(r => {
      const ds = P().devices.filter(d => d.roomId === r.id);
      const brks = Array.from(new Set(ds.map(d => { const c = circuitById(d.circuitId); return c ? c.breakerId : null; }).filter(Boolean)));
      const va = ds.reduce((a, d) => a + (+d.watts || 0), 0);
      const tr = el('tr', { style: 'cursor:pointer' , onclick: () => { state.sel = { breaker: null, circuit: null, device: null, room: r.id }; state.sideOpen = true; render(); } });
      if (state.sel.room === r.id) tr.style.background = 'var(--live-dim)';
      tr.appendChild(el('td', { html: `<strong>${esc(r.name)}</strong>` }));
      tr.appendChild(el('td', { class: 'opt2' }, [r.type || '—']));
      tr.appendChild(el('td', { class: 'num' }, [String(ds.length)]));
      tr.appendChild(el('td', {}, [brks.length ? brks.map(id => { const b = breakerById(id); return b ? slotsFor(b.slot, b.poles).join('/') : '?'; }).join(', ') : '—']));
      tr.appendChild(el('td', { class: 'num opt' }, [va ? va + ' VA' : '—']));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    card.appendChild(el('div', { class: 'tablescroll' }, [tbl]));
    pad.appendChild(card);
  });
  stage.appendChild(pad);
}
function addRoom() {
  if (!P().floors.length) return toast('Add a floor first');
  const name = prompt('Room name', 'Kitchen'); if (!name) return;
  const f = currentFloor();
  edit(() => P().rooms.push({ id: uid('rm'), floorId: f.id, name, type: guessRoomType(name), notes: '' }));
  render();
}
function guessRoomType(n) {
  const s = n.toLowerCase();
  return ROOM_TYPES.find(t => s.includes(t.toLowerCase())) || 'Other';
}

/* ============================================================
   CODE CHECKS — advisory only
   ============================================================ */
function codeChecks() {
  const out = [];
  const add = (sev, msg, ref) => out.push({ sev, msg, ref });
  P().panels.forEach(pan => {
    breakersOf(pan.id).forEach(b => {
      const tag = `${pan.name} slot ${slotsFor(b.slot, b.poles).join('/')}`;
      if (b.type === 'Blank' || b.type === 'Spare') return;
      /* wire vs breaker */
      const limit = SMALL_COND[b.wire] !== undefined ? SMALL_COND[b.wire] : AMPACITY[b.wire];
      if (limit !== undefined && b.amps > limit)
        add('bad', `${tag}: ${b.amps}A on #${b.wire} conductor. Common limit for #${b.wire} is ${limit}A.`, 'NEC 240.4(D) / 310.16');
      /* continuous load 80% */
      const va = breakerVA(b.id), cap = b.amps * breakerVolts(b);
      if (cap && va > cap) add('bad', `${tag}: connected ${Math.round(va)} VA exceeds the ${Math.round(cap)} VA breaker capacity.`, 'NEC 210.20');
      else if (cap && va > cap * 0.8) add('warn', `${tag}: connected ${Math.round(va)} VA is over 80% of ${Math.round(cap)} VA. Tight for a continuous load.`, 'NEC 210.20(A)');
      /* protection type vs rooms served */
      const rooms = Array.from(new Set(devicesOfBreaker(b.id).map(d => roomById(d.roomId)).filter(Boolean).map(r => r.type)));
      const needG = rooms.some(r => GFCI_ROOMS.includes(r));
      const needA = rooms.some(r => AFCI_ROOMS.includes(r));
      const hasG = /GFCI|Dual/.test(b.type), hasA = /AFCI|Dual|CAFCI/.test(b.type);
      if (needG && !hasG) add('warn', `${tag} serves ${rooms.filter(r => GFCI_ROOMS.includes(r)).join(', ')} but is not GFCI. Check for downstream GFCI receptacle protection.`, 'NEC 210.8');
      if (needA && !hasA) add('warn', `${tag} serves ${rooms.filter(r => AFCI_ROOMS.includes(r)).join(', ')} but is not AFCI.`, 'NEC 210.12');
      /* tandem legality */
      if (b.tandem && pan.tandemSlots === 'list') {
        const allowed = String(pan.tandemList || '').split(/[,\s]+/).filter(Boolean).map(Number);
        if (!allowed.includes(b.slot)) add('bad', `${tag}: tandem in a slot this panel does not list as CTL-approved.`, 'Panel labelling / NEC 110.3(B)');
      }
      /* housekeeping */
      if (!b.label && circuitsOf(b.id).some(c => !c.label)) add('warn', `${tag} has no label.`, 'NEC 408.4(A)');
      if (b.verify === 'suspect') add('warn', `${tag} is marked suspect — assignment needs re-checking.`, '');
      if (b.verify === 'unverified' && devicesOfBreaker(b.id).length) add('info', `${tag} has devices but has never been verified.`, '');
      if (b.tieId && tiedWith(b).length === 0) add('warn', `${tag} has a handle tie group with no partner.`, '');
    });
    /* breaker count vs spaces */
    const used = breakersOf(pan.id).reduce((a, b) => a + slotsFor(b.slot, b.poles).length, 0);
    if (used > pan.spaces) add('bad', `${pan.name}: breakers occupy ${used} spaces but the panel has ${pan.spaces}.`, '');
  });
  P().devices.forEach(d => {
    if (!d.circuitId) add('warn', `Device “${d.label || d.kind}” is not assigned to any circuit.`, '');
    if (!d.roomId) add('info', `Device “${d.label || d.kind}” has no room assignment.`, '');
    /* A control link crossing circuits means both circuits' conductors share
       an enclosure. One breaker off is not safe there — this is the finding
       the link exists to make possible. */
    const foreign = controlsOf(d).filter(t => d.circuitId && t.circuitId && t.circuitId !== d.circuitId);
    if (foreign.length) add('warn', `“${deviceName(d)}” is on ${circuitLabel(circuitById(d.circuitId))} but controls ${foreign.map(t => `“${deviceName(t)}” on ${circuitLabel(circuitById(t.circuitId))}`).join(', ')}. Two circuits in one box — turn both off before opening it.`, '');
  });
  const order = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}

/* ============================================================
   REPORTS VIEW
   ============================================================ */
function renderReportView() {
  const stage = $('#stage'); stage.innerHTML = '';
  const pan = panelById(state.panelId) || P().panels[0];
  const tools = el('div', { class: 'toolstrip' });
  tools.appendChild(el('span', { class: 'lbl' }, ['Reports']));
  tools.appendChild(el('button', { class: 'iconbtn on', onclick: () => printDirectory(pan) }, ['Print panel directory']));
  tools.appendChild(el('button', { class: 'iconbtn', onclick: () => printFullReport() }, ['Print full report']));
  tools.appendChild(el('button', { class: 'iconbtn', onclick: exportBackup, title: 'Project data and every image, in one re-importable file' }, ['Export backup']));
  tools.appendChild(el('button', { class: 'iconbtn', onclick: exportJSON, title: 'Project data only, without images' }, ['Export JSON']));
  tools.appendChild(el('button', { class: 'iconbtn', onclick: exportCSV }, ['Export CSV']));
  tools.appendChild(el('button', { class: 'iconbtn', onclick: importProject }, ['Import']));
  stage.appendChild(tools);

  const pad = el('div', { class: 'stagepad' });

  /* code checks */
  const issues = codeChecks();
  const cc = el('div', { class: 'card' });
  cc.appendChild(el('h3', {}, ['Checks · advisory only']));
  if (!issues.length) cc.appendChild(el('div', { class: 'empty' }, ['Nothing flagged.']));
  issues.slice(0, 60).forEach(i => {
    const row = el('div', { style: 'display:flex;gap:9px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--steel-800)' });
    row.appendChild(el('span', { class: 'pill ' + (i.sev === 'bad' ? 'bad' : i.sev === 'warn' ? 'warn' : '') }, [i.sev === 'bad' ? 'Fix' : i.sev === 'warn' ? 'Check' : 'Note']));
    row.appendChild(el('div', { style: 'flex:1;font-size:12.5px' , html: esc(i.msg) + (i.ref ? ` <span style="color:var(--steel-500)">· ${esc(i.ref)}</span>` : '') }));
    cc.appendChild(row);
  });
  cc.appendChild(el('div', { class: 'hint', style: 'margin-top:10px' }, ['These are rules of thumb from common residential practice. Code adoption differs by jurisdiction and cycle, and this is not a substitute for a licensed electrician or an inspection.']));
  pad.appendChild(cc);

  /* per-panel summary */
  P().panels.forEach(p2 => {
    const card = el('div', { class: 'card' });
    card.appendChild(el('h3', {}, [p2.name + ' — circuit schedule']));
    const tbl = el('table', { class: 'sched' });
    tbl.innerHTML = '<thead><tr><th>Slot</th><th>Amps</th><th class="opt2">Type</th><th class="opt">Wire</th>'
      + '<th class="opt2">Leg</th><th>Label</th><th class="opt2">Rooms</th><th class="opt">Devices</th>'
      + '<th class="opt">VA</th><th>Load</th></tr></thead>';
    const tb = el('tbody');
    breakersOf(p2.id).forEach(b => {
      circuitsOf(b.id).forEach((c, i) => {
        const ds = devicesOf(c.id);
        const va = circuitVA(c.id), cap = b.amps * breakerVolts(b);
        const pct = cap ? va / cap * 100 : 0;
        const rooms = Array.from(new Set(ds.map(d => roomById(d.roomId)).filter(Boolean).map(r => r.name)));
        const tr = el('tr', { style: 'cursor:pointer', onclick: () => { state.view = 'panel'; state.panelId = p2.id; state.sel = { breaker: b.id, circuit: c.id, device: null, room: null }; state.sideOpen = true; render(); } });
        tr.appendChild(el('td', { class: 'num' }, [slotsFor(b.slot, b.poles).join('/') + (c.sub || '')]));
        tr.appendChild(el('td', { class: 'num' }, [i === 0 ? b.amps + 'A' : '']));
        tr.appendChild(el('td', { class: 'opt2' }, [i === 0 ? b.type + (b.hacr ? ' HACR' : '') : '']));
        tr.appendChild(el('td', { class: 'opt' }, [i === 0 ? '#' + b.wire : '']));
        tr.appendChild(el('td', { class: 'opt2', html: `<span style="color:${LEG_COLOR[legOf(p2, b.slot)]}">${legOf(p2, b.slot)}</span>` }));
        tr.appendChild(el('td', {}, [c.label || b.label || '—']));
        tr.appendChild(el('td', { class: 'opt2' }, [rooms.join(', ') || '—']));
        tr.appendChild(el('td', { class: 'num opt' }, [String(ds.length)]));
        tr.appendChild(el('td', { class: 'num opt' }, [va ? String(va) : '—']));
        const ld = el('td');
        const bar = el('div', { class: 'bars', style: 'width:56px' });
        bar.appendChild(el('i', { style: `width:${clamp(pct, 0, 100)}%;background:${pct > 100 ? 'var(--bad)' : pct > 80 ? 'var(--warn)' : 'var(--ok)'}` }));
        ld.appendChild(bar); tr.appendChild(ld);
        tb.appendChild(tr);
      });
    });
    tbl.appendChild(tb);
    card.appendChild(el('div', { class: 'tablescroll' }, [tbl]));
    pad.appendChild(card);
  });
  stage.appendChild(pad);
}


/* ============================================================
   DEVICES VIEW — the master list of everything in the project.
   Filter, sort, jump to a device, or fix many at once.
   ============================================================ */
function deviceRows() {
  const f = state.devFilter, q = (f.q || '').toLowerCase();
  let list = P().devices.slice();
  if (q) list = list.filter(d => {
    const r = roomById(d.roomId), c = circuitById(d.circuitId), b = c && breakerById(c.breakerId);
    return [d.label, d.kind, d.notes, r && r.name, b && b.label, b && ('slot ' + b.slot)]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  });
  if (f.floorId) list = list.filter(d => d.floorId === f.floorId);
  if (f.roomId)  list = list.filter(d => d.roomId === f.roomId);
  if (f.kind)    list = list.filter(d => d.kind === f.kind);
  if (f.flag === 'unassigned') list = list.filter(d => !d.circuitId);
  if (f.flag === 'noroom')     list = list.filter(d => !d.roomId);
  if (f.flag === 'critical')   list = list.filter(d => d.critical);
  if (f.flag === 'unverified') list = list.filter(d => d.verify !== 'verified');

  const key = state.devSort.key, dir = state.devSort.dir;
  const val = d => {
    const c = circuitById(d.circuitId), b = c && breakerById(c.breakerId), r = roomById(d.roomId), fl = floorById(d.floorId);
    if (key === 'label')   return (d.label || DEVICE_KINDS.find(k => k.k === d.kind).n).toLowerCase();
    if (key === 'kind')    return d.kind;
    if (key === 'room')    return (r ? r.name : '~').toLowerCase();
    if (key === 'floor')   return fl ? fl.level : 999;
    if (key === 'breaker') return b ? b.slot : 9999;
    if (key === 'va')      return +d.watts || 0;
    return 0;
  };
  return list.sort((a, b) => {
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

function renderDevicesView() {
  const stage = $('#stage'); stage.innerHTML = '';
  const f = state.devFilter;

  /* filters */
  const tools = el('div', { class: 'toolstrip' });
  tools.appendChild(el('span', { class: 'lbl' }, ['Devices']));
  tools.appendChild(el('input', {
    class: 'i', type: 'search', placeholder: 'Filter…', value: f.q || '',
    'data-fid': 'devfilter:q', style: 'width:150px;flex:0 0 auto',
    oninput: e => { f.q = e.target.value; clearTimeout(liveTimer); liveTimer = setTimeout(render, 220); }
  }));
  const flSel = el('select', { class: 'i', style: 'width:auto;flex:0 0 auto', 'data-fid': 'devfilter:floor',
    onchange: e => { f.floorId = e.target.value; f.roomId = ''; render(); } });
  flSel.appendChild(el('option', { value: '' }, ['All floors']));
  P().floors.forEach(x => flSel.appendChild(el('option', { value: x.id, selected: f.floorId === x.id ? 'selected' : null }, [x.name])));
  tools.appendChild(flSel);
  const rmSel = el('select', { class: 'i', style: 'width:auto;flex:0 0 auto', 'data-fid': 'devfilter:room',
    onchange: e => { f.roomId = e.target.value; render(); } });
  rmSel.appendChild(el('option', { value: '' }, ['All rooms']));
  (f.floorId ? roomsOfFloor(f.floorId) : P().rooms).forEach(x =>
    rmSel.appendChild(el('option', { value: x.id, selected: f.roomId === x.id ? 'selected' : null }, [x.name])));
  tools.appendChild(rmSel);
  tools.appendChild(el('button', { class: 'iconbtn', onclick: () => { state.placing = { circuitId: null, kind: 'outlet', roomId: f.roomId || null }; state.view = 'plan'; state.planFitted = false; render(); toast('Tap the plan to add a device'); } }, ['+ Add on plan']));
  stage.appendChild(tools);

  const pad = el('div', { class: 'stagepad' });

  /* quick counts — these double as filters */
  const all = P().devices;
  const chips = [
    ['', 'All', all.length],
    ['unassigned', 'No circuit', all.filter(d => !d.circuitId).length],
    ['noroom', 'No room', all.filter(d => !d.roomId).length],
    ['unverified', 'Unverified', all.filter(d => d.verify !== 'verified').length],
    ['critical', 'Critical', all.filter(d => d.critical).length]
  ];
  const chipbar = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px' });
  chips.forEach(([flag, label, n]) => chipbar.appendChild(el('button', {
    class: 'iconbtn' + (f.flag === flag ? ' on' : ''),
    onclick: () => { f.flag = flag; state.devSelected.clear(); render(); }
  }, [`${label} · ${n}`])));
  pad.appendChild(chipbar);

  const rows = deviceRows();

  /* bulk actions appear only when rows are ticked */
  if (state.devSelected.size) {
    const bulk = el('div', { class: 'card', style: 'border-color:var(--live);position:sticky;top:0;z-index:5' });
    bulk.appendChild(el('h3', {}, [`${state.devSelected.size} selected`]));
    const r = el('div', { class: 'row' });
    const circOpts = [];
    P().panels.forEach(p2 => breakersOf(p2.id).forEach(b => circuitsOf(b.id).forEach(cc =>
      circOpts.push([cc.id, `${p2.name} ${slotsFor(b.slot, b.poles).join('/')}${cc.sub || ''} — ${cc.label || b.label || b.amps + 'A'}`]))));
    const cSel = el('select', { class: 'i', onchange: e => {
      if (!e.target.value) return;
      let n = 0, skipped = 0;
      edit(() => state.devSelected.forEach(id => { const d = deviceById(id); if (!d) return;
        if (d.locked) { skipped++; return; } d.circuitId = e.target.value; n++; }));
      toast(`Assigned ${n}${skipped ? ` · ${skipped} locked, skipped` : ''}`); state.devSelected.clear(); render();
    } });
    cSel.appendChild(el('option', { value: '' }, ['Assign to circuit…']));
    circOpts.forEach(([v, n]) => cSel.appendChild(el('option', { value: v }, [n])));
    r.appendChild(cSel);
    const rSel = el('select', { class: 'i', onchange: e => {
      if (!e.target.value) return;
      let n = 0, skipped = 0;
      edit(() => state.devSelected.forEach(id => { const d = deviceById(id); if (!d) return;
        if (d.locked) { skipped++; return; }
        const rm = roomById(e.target.value); d.roomId = rm.id; d.floorId = rm.floorId; n++; }));
      toast(`Moved ${n}${skipped ? ` · ${skipped} locked, skipped` : ''}`); state.devSelected.clear(); render();
    } });
    rSel.appendChild(el('option', { value: '' }, ['Assign to room…']));
    P().rooms.forEach(x => rSel.appendChild(el('option', { value: x.id }, [x.name + ' · ' + (floorById(x.floorId) || {}).name])));
    r.appendChild(rSel);
    bulk.appendChild(r);
    const r2 = el('div', { class: 'row' });
    r2.appendChild(el('button', { class: 'iconbtn', onclick: () => { edit(() => state.devSelected.forEach(id => { const d = deviceById(id); if (d && !d.locked) d.verify = 'verified'; })); state.devSelected.clear(); render(); } }, ['Mark verified']));
    r2.appendChild(el('button', { class: 'iconbtn', onclick: () => { edit(() => state.devSelected.forEach(id => { const d = deviceById(id); if (d) d.locked = true; })); toast('Locked'); state.devSelected.clear(); render(); } }, ['Lock']));
    r2.appendChild(el('button', { class: 'iconbtn', onclick: () => { edit(() => state.devSelected.forEach(id => { const d = deviceById(id); if (d) d.locked = false; })); toast('Unlocked'); state.devSelected.clear(); render(); } }, ['Unlock']));
    r2.appendChild(el('button', { class: 'iconbtn', onclick: () => { state.devSelected.clear(); render(); } }, ['Clear selection']));
    r2.appendChild(el('button', { class: 'iconbtn', style: 'border-color:var(--bad);color:var(--bad)',
      onclick: () => {
        const kill = Array.from(state.devSelected).map(deviceById).filter(d => d && !d.locked);
        const held = state.devSelected.size - kill.length;
        if (!kill.length) return toast('All selected devices are locked');
        if (!confirm(`Delete ${kill.length} device${kill.length === 1 ? '' : 's'}?${held ? ` (${held} locked and kept)` : ''}`)) return;
        const ids = new Set(kill.map(d => d.id));
        edit(() => { P().devices = P().devices.filter(d => !ids.has(d.id)); dropControlLinks(ids); });
        state.devSelected.clear(); render(); } }, ['Delete']));
    bulk.appendChild(r2);
    pad.appendChild(bulk);
  }

  const card = el('div', { class: 'card' });
  card.appendChild(el('h3', {}, [`${rows.length} device${rows.length === 1 ? '' : 's'}`]));
  if (!rows.length) {
    card.appendChild(el('div', { class: 'empty' }, [
      all.length ? 'No devices match these filters.'
                 : 'Nothing added yet. Place devices on the floor plan, or use Discovery mode to map a breaker by walking the building.']));
    pad.appendChild(card); stage.appendChild(pad); return;
  }

  const tbl = el('table', { class: 'sched' });
  const thead = el('thead'); const htr = el('tr');
  const allTicked = rows.every(d => state.devSelected.has(d.id));
  const th0 = el('th', { style: 'width:26px' });
  th0.appendChild(el('input', { type: 'checkbox', checked: allTicked ? 'checked' : null, 'aria-label': 'Select all shown',
    onchange: e => { rows.forEach(d => e.target.checked ? state.devSelected.add(d.id) : state.devSelected.delete(d.id)); render(); } }));
  htr.appendChild(th0);
  [['label', 'Device', ''], ['kind', 'Kind', 'opt'], ['room', 'Room', ''], ['floor', 'Floor', 'opt2'],
   ['breaker', 'Breaker', ''], ['va', 'VA', 'opt'], [null, 'Status', 'opt']].forEach(([k, name, cls]) => {
    const th = el('th', { class: cls || null, style: k ? 'cursor:pointer' : null,
      onclick: k ? () => { state.devSort = { key: k, dir: state.devSort.key === k ? -state.devSort.dir : 1 }; render(); } : null },
      [name + (state.devSort.key === k ? (state.devSort.dir > 0 ? ' ▲' : ' ▼') : '')]);
    htr.appendChild(th);
  });
  thead.appendChild(htr); tbl.appendChild(thead);

  const tb = el('tbody');
  rows.forEach(d => {
    const c = circuitById(d.circuitId), b = c && breakerById(c.breakerId);
    const rm = roomById(d.roomId), fl = floorById(d.floorId);
    const tr = el('tr', { style: 'cursor:pointer' });
    if (state.sel.device === d.id) tr.style.background = 'var(--live-dim)';
    const td0 = el('td', { onclick: e => e.stopPropagation() });
    td0.appendChild(el('input', { type: 'checkbox', checked: state.devSelected.has(d.id) ? 'checked' : null,
      'aria-label': 'Select ' + (d.label || d.kind),
      onchange: e => { e.target.checked ? state.devSelected.add(d.id) : state.devSelected.delete(d.id); render(); } }));
    tr.appendChild(td0);
    const open = () => { state.sel = { breaker: null, circuit: null, device: d.id, room: null }; state.sideOpen = true; render(); };
    const cell = (html, cls) => { const t = el('td', { class: cls || null, html: html, onclick: open }); return t; };
    tr.appendChild(cell(`<strong>${esc(d.label || DEVICE_KINDS.find(k => k.k === d.kind).n)}</strong>${d.critical ? ' <span class="pill bad">critical</span>' : ''}`));
    tr.appendChild(cell(esc(DEVICE_KINDS.find(k => k.k === d.kind).n), 'opt'));
    tr.appendChild(cell(rm ? esc(rm.name) : '<span style="color:var(--steel-500)">— none —</span>'));
    tr.appendChild(cell(fl ? esc(fl.name) : '—', 'opt2'));
    tr.appendChild(cell(b ? `${esc(panelById(b.panelId).name)} ${slotsFor(b.slot, b.poles).join('/')}${c.sub || ''}`
                          : '<span style="color:var(--warn)">unassigned</span>'));
    tr.appendChild(cell(d.watts ? String(d.watts) : '—', 'num opt'));
    tr.appendChild(cell(`<span class="pill ${d.verify === 'verified' ? 'ok' : d.verify === 'suspect' ? 'bad' : ''}">${d.verify}</span>`
      + (d.locked ? ' <span class="pill live">locked</span>' : ''), 'opt'));
    tb.appendChild(tr);
  });
  tbl.appendChild(tb);
  card.appendChild(el('div', { class: 'tablescroll' }, [tbl]));
  pad.appendChild(card);
  stage.appendChild(pad);
}

/* ============================================================
   INSPECTOR — context panel on the right
   ============================================================ */
function field(label, control, hint) {
  const w = el('div');
  w.appendChild(el('label', { class: 'f' }, [label]));
  w.appendChild(control);
  if (hint) w.appendChild(el('div', { class: 'hint', style: 'margin-top:4px' }, [hint]));
  return w;
}
/* A section that stays folded until it is wanted. The inspector was one
   flat stack of equally loud cards; most of what is in it — configuration,
   moves, notes, deletion — is touched once and then never again. */
function disclose(key, title, build, opts) {
  opts = opts || {};
  const d = el('details', { class: 'disc' + (opts.danger ? ' danger' : ''), open: state.disc[key] ? 'open' : null });
  const s = el('summary', {}, [title]);
  if (opts.pill) s.appendChild(el('span', { class: 'pill ' + (opts.pillCls || '') }, [opts.pill]));
  d.appendChild(s);
  d.addEventListener('toggle', () => { state.disc[key] = d.open; });
  const body = el('div', { class: 'discbody' });
  build(body);
  d.appendChild(body);
  return d;
}
/* One datalist shared by every circuit-name field. */
function circuitNameList() {
  let dl = $('#circuitnames');
  if (!dl) {
    dl = el('datalist', { id: 'circuitnames' });
    CIRCUIT_NAMES.forEach(n => dl.appendChild(el('option', { value: n })));
    document.body.appendChild(dl);
  }
  return 'circuitnames';
}
const fidOf = (obj, key) => (obj && obj.id ? obj.id : 'g') + ':' + key;
function inputFor(obj, key, opts) {
  opts = opts || {};
  const num = opts.type === 'number';
  /* Numeric fields are text inputs with a numeric keypad hint rather than
     type=number: Chrome throws on selectionStart for number inputs, so the
     caret could not be restored after a re-render and typed digits ended up
     reversed. Text inputs also avoid the spinner and scroll-wheel surprises. */
  const c = el('input', {
    class: 'i', type: 'text', value: obj[key] == null ? '' : obj[key],
    inputmode: num ? 'decimal' : null, autocomplete: 'off', list: opts.list || null,
    'data-fid': opts.fid || fidOf(obj, key),
    placeholder: opts.ph || '', disabled: opts.disabled ? 'disabled' : null,
    oninput: e => {
      obj[key] = num ? (parseFloat(e.target.value) || 0) : e.target.value;
      /* Never re-render numeric fields mid-edit — an empty box would be
         rewritten to "0" under the user's caret. Totals refresh on blur. */
      touchLive(num ? {} : opts);
    },
    /* Defer: blurring this field to click another one fires change first,
       and re-rendering synchronously would replace the field being clicked. */
    onchange: () => { snapshot(); touch(); if (opts.rerender || num) setTimeout(render, 0); }
  });
  return c;
}
function selectFor(obj, key, list, opts) {
  opts = opts || {};
  const s = el('select', {
    class: 'i', 'data-fid': opts.fid || fidOf(obj, key), disabled: opts.disabled ? 'disabled' : null,
    onchange: e => { snapshot(); obj[key] = opts.number ? +e.target.value : e.target.value; if (opts.after) opts.after(); touch(); render(); }
  });
  (opts.blank ? [['', opts.blank]] : []).concat(list.map(v => Array.isArray(v) ? v : [v, v]))
    .forEach(([v, n]) => s.appendChild(el('option', { value: v, selected: String(obj[key] == null ? '' : obj[key]) === String(v) ? 'selected' : null }, [String(n)])));
  return s;
}
function checkFor(obj, key, label, opts) {
  opts = opts || {};
  const w = el('label', { class: 'chk' });
  w.appendChild(el('input', {
    type: 'checkbox', checked: obj[key] ? 'checked' : null, disabled: opts.disabled ? 'disabled' : null,
    onchange: e => { snapshot(); obj[key] = e.target.checked; if (opts.after) opts.after(); touch(); render(); }
  }));
  w.appendChild(el('span', {}, [label]));
  return w;
}
let liveTimer;
function touchLive(opts) { clearTimeout(liveTimer); liveTimer = setTimeout(() => { touch(); if (opts && opts.live) render(); }, 400); }

function selectionLabel() {
  const s = state.sel;
  if (s.breaker) { const b = breakerById(s.breaker); return b ? `Breaker · slot ${slotsFor(b.slot, b.poles).join('/')}` : null; }
  if (s.device) { const d = deviceById(s.device); return d ? `Device · ${d.label || DEVICE_KINDS.find(k => k.k === d.kind).n}` : null; }
  if (s.room) { const r = roomById(s.room); return r ? `Room · ${r.name}` : null; }
  return null;
}
/* A pin is immovable if it carries its own lock or the whole plan is
   locked. The plan-wide toggle exists because locking a few hundred pins
   individually after a survey is not realistic. */
const pinLocked = d => !!d.locked || !!P().settings.lockPins;
const hasSelection = () => { const s = state.sel; return !!(s.breaker || s.device || s.room); };
function clearSelection() {
  state.sel = { breaker: null, circuit: null, device: null, room: null };
  render();
}
function renderSide() {
  const side = $('#side'); side.innerHTML = '';
  if (isMobile()) side.appendChild(makeSheetHead());
  syncSheet();
  const s = state.sel;
  const has = !!(s.breaker || s.device || s.room);

  /* Desktop has no sheet header, so the rail carries its own controls:
     what is being shown, how to deselect, and how to hide the rail. */
  if (!isMobile()) {
    const bar = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:12px' });
    bar.appendChild(el('div', { class: 'f', style: 'margin:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
      [selectionLabel() || (state.view === 'plan' ? 'Floor settings' : 'Project')]));
    if (has) bar.appendChild(el('button', { class: 'iconbtn ghost', onclick: clearSelection }, ['Deselect']));
    bar.appendChild(el('button', { class: 'iconbtn ghost', title: 'Hide this panel',
      onclick: () => { state.railHidden = true; syncSheet(); } }, ['Hide']));
    side.appendChild(bar);
  }

  /* One subject at a time. Appending the floor editor under a selected
     device put two different meanings of "Floor" in one scroll, with a
     Name field that looked like it renamed the device. Floor settings are
     reached from the "Floor setup" button on the plan instead. */
  if (s.breaker) sideBreaker(side, breakerById(s.breaker));
  else if (s.device) sideDevice(side, deviceById(s.device));
  else if (s.room) sideRoom(side, roomById(s.room));
  else if (state.view === 'plan') sideFloor(side, false);
  else sideOverview(side);
}

function sideOverview(side) {
  const c = el('div', { class: 'card' });
  c.appendChild(el('h3', {}, ['Project']));
  c.appendChild(field('Name', inputFor(P(), 'name', { live: true, rerender: true })));
  c.appendChild(el('div', { class: 'row' }, []));
  const r = el('div', { class: 'row' });
  r.appendChild(field('Nominal V (1-pole)', inputFor(P().settings, 'voltage', { type: 'number' })));
  r.appendChild(field('Nominal V (2-pole)', inputFor(P().settings, 'voltage2', { type: 'number' })));
  c.appendChild(r);
  c.appendChild(field('Default wire size', selectFor(P().settings, 'defaultWire', WIRE_SIZES)));
  side.appendChild(c);

  const st = el('div', { class: 'card' });
  st.appendChild(el('h3', {}, ['At a glance']));
  const counts = [['Panels', P().panels.length], ['Breakers', P().breakers.length], ['Circuits', P().circuits.length],
    ['Devices', P().devices.length], ['Rooms', P().rooms.length], ['Floors', P().floors.length]];
  const g = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' });
  counts.forEach(([k, v]) => g.appendChild(el('div', { html: `<div style="font:700 20px var(--mono)">${v}</div><div class="f">${k}</div>` })));
  st.appendChild(g);
  const iss = codeChecks();
  st.appendChild(el('div', { style: 'margin-top:12px', html:
    `<span class="pill bad">${iss.filter(i => i.sev === 'bad').length} fix</span>
     <span class="pill warn">${iss.filter(i => i.sev === 'warn').length} check</span>
     <span class="pill">${iss.filter(i => i.sev === 'info').length} note</span>` }));
  side.appendChild(st);

  if (Store.isMemory()) side.appendChild(el('div', { class: 'card', style: 'border-color:var(--warn)' , html:
    `<h3 style="color:var(--warn)">Preview mode</h3><div class="hint" style="margin:0">Browser storage is unavailable here, so changes stay in memory only. Deploy the folder to a web server and it will save normally. Export JSON to keep this work.</div>` }));
}

function sideBreaker(side, b) {
  if (!b) return sideOverview(side);
  const pan = panelById(b.panelId);
  const locked = !!b.locked;
  const cs = circuitsOf(b.id);
  const active = cs.find(c => c.id === state.sel.circuit) || cs[0];
  const isTandem = cs.length > 1;
  const slots = slotsFor(b.slot, b.poles).join('/');

  /* ---------- tier 1: the breaker — the hardware in the panel ----------
     Ratings only. Everything about what it feeds lives one tier down, and
     everything you set once and forget is folded away below.            */
  const head = el('div', { class: 'card tier-brk' });
  head.appendChild(el('h3', {}, [`Breaker · slot ${slots}`,
    el('span', { class: 'pill ' + (b.verify === 'verified' ? 'ok' : b.verify === 'suspect' ? 'bad' : '') }, [b.verify])]));
  /* One line to read the rating off, instead of piecing it together from
     four selects. It also surfaces the folded-away settings that matter. */
  head.appendChild(el('div', { class: 'specline', html: [
    `<b>${b.amps}A</b>`, b.poles > 1 ? `<b>${b.poles}-pole</b>` : '1-pole', esc(b.type),
    '#' + esc(b.wire), 'leg ' + legOf(pan, b.slot),
    b.hacr ? 'HACR' : null, b.tandem ? 'tandem' : null,
    b.tieId ? 'handle tie' : null,
    b.subpanelId ? '&rarr; ' + esc(panelById(b.subpanelId).name) : null,
    locked ? '<b>&#9887; locked</b>' : null
  ].filter(Boolean).join(' &middot; ') }));
  const r1 = el('div', { class: 'row' });
  r1.appendChild(field('Amps', selectFor(b, 'amps', AMP_CHOICES, { number: true, disabled: locked })));
  r1.appendChild(field('Poles', selectFor(b, 'poles', [[1, '1 — single'], [2, '2 — linked (next slot)'], [3, '3 — linked ×3']], {
    number: true, disabled: locked,
    after: () => {
      const want = slotsFor(b.slot, b.poles);
      const over = want.filter(sl => sl > pan.spaces);
      const clash = occupant(b.panelId, want, b.id);
      if (over.length) {
        toast(`A ${b.poles}-pole breaker here would run past slot ${pan.spaces}`);
        b.poles = 1;
      } else if (clash) {
        toast(`Slot ${clash.slot} is already taken — clear it first`);
        b.poles = 1;
      } else if (b.poles > 1) { b.tandem = false; }
      syncCircuits(b);
    }
  })));
  head.appendChild(r1);
  const r2 = el('div', { class: 'row' });
  r2.appendChild(field('Type', selectFor(b, 'type', BREAKER_TYPES, { disabled: locked })));
  r2.appendChild(field('Wire size', selectFor(b, 'wire', WIRE_SIZES, { disabled: locked })));
  head.appendChild(r2);
  head.appendChild(field('Verification', selectFor(b, 'verify', VERIFY)));
  side.appendChild(head);

  /* configuration — set once per breaker, so it stays folded */
  side.appendChild(disclose('config', 'Configuration', body => {
    body.appendChild(checkFor(b, 'tandem', 'Tandem — split into A and B', {
      disabled: locked || b.poles > 1, after: () => syncCircuits(b)
    }));
    body.appendChild(checkFor(b, 'hacr', 'HACR rated', { disabled: locked }));
    body.appendChild(checkFor(b, 'locked', 'Locked — block accidental edits'));
    body.appendChild(el('div', { class: 'hint', style: 'margin-top:6px' }, [b.poles > 1
      ? `Common trip: slots ${slotsFor(b.slot, b.poles).join(', ')} are one circuit at ${P().settings.voltage2} V.`
      : 'Single pole. A handle tie joins non-consecutive breakers instead.']));
    const tieOpts = breakersOf(pan.id).filter(x => x.id !== b.id).map(x => [x.id, `Slot ${slotsFor(x.slot, x.poles).join('/')} — ${x.label || x.amps + 'A'}`]);
    const tieSel = el('select', { class: 'i', disabled: locked ? 'disabled' : null, onchange: e => {
      snapshot();
      if (!e.target.value) { b.tieId = null; }
      else { const other = breakerById(e.target.value); const gid = b.tieId || other.tieId || uid('tie'); b.tieId = gid; other.tieId = gid; }
      touch(); render();
    } });
    tieSel.appendChild(el('option', { value: '' }, [b.tieId ? '— remove from tie —' : '— none —']));
    tieOpts.forEach(([v, n]) => tieSel.appendChild(el('option', { value: v }, [n])));
    body.appendChild(field('Bridged handle tie', tieSel,
      b.tieId ? 'Tied with ' + (tiedWith(b).map(x => 'slot ' + x.slot).join(', ') || 'nothing yet') + '. Independent circuits, one handle.'
              : 'Joins two breakers mechanically. They switch together but stay separate circuits.'));
    const subOpts = P().panels.filter(x => x.id !== pan.id).map(x => [x.id, x.name]);
    body.appendChild(field('Feeds subpanel', selectFor(b, 'subpanelId', subOpts, { blank: '— none —', disabled: locked }),
      b.subpanelId ? 'Turning this off de-energizes everything in ' + panelById(b.subpanelId).name + '.' : ''));
    const sw = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
    BREAKER_COLORS.forEach(col => {
      sw.appendChild(el('button', {
        title: col || 'default', disabled: locked ? 'disabled' : null,
        style: `width:28px;height:24px;border-radius:2px;border:2px solid ${b.color === col ? 'var(--live)' : 'transparent'};background:${col || 'var(--steel-700)'}`,
        onclick: () => { snapshot(); b.color = col; touch(); render(); }
      }));
    });
    body.appendChild(field('Breaker colour', sw));
  }));

  /* ---------- tier 2: the circuit(s) this breaker feeds ----------
     Indented under the breaker, with the devices nested one step further,
     so breaker > circuit > device is visible rather than implied.  */
  const branch = el('div', { class: 'branch' });
  (isTandem ? [active] : cs).forEach(c => {
    const cc = el('div', { class: 'card tier-cir' });
    cc.appendChild(el('h3', {}, [`Circuit ${b.slot}${c.sub || ''}`,
      el('span', { class: 'pill' }, [circuitVA(c.id) + ' VA'])]));
    if (isTandem) {
      const seg = el('div', { class: 'seg' });
      cs.forEach(x => seg.appendChild(el('button', {
        class: x.id === c.id ? 'on' : '',
        onclick: () => { state.sel.circuit = x.id; render(); }
      }, [`${b.slot}${x.sub}${x.label ? ' · ' + trunc(x.label, 14) : ''}`])));
      cc.appendChild(seg);
    }
    /* Exactly one name per circuit, in one place. On a single-circuit
       breaker that name is stored on the breaker — which is what the ladder
       and the printed directory read — so the field edits it directly
       rather than adding a second box that means almost the same thing. */
    cc.appendChild(field('Circuit name',
      inputFor(isTandem ? c : b, 'label', {
        ph: isTandem ? 'Hall — lights' : 'Kitchen — countertop receptacles',
        list: circuitNameList(), live: true, disabled: locked, rerender: true
      }),
      'Area — what it feeds. About 24 characters stays readable on the ladder and in the printed directory.'));

    /* ---------- tier 3: the devices on this circuit ---------- */
    const ds = devicesOf(c.id);
    const sub = el('div', { class: 'subtier' });
    sub.appendChild(el('h4', {}, [ds.length ? `${ds.length} device${ds.length === 1 ? '' : 's'}` : 'Devices']));
    const ul = el('ul', { class: 'list' });
    ds.forEach(d => {
      const rm = roomById(d.roomId), fl = floorById(d.floorId);
      const li = el('li', { onclick: () => { state.sel = { breaker: null, circuit: null, device: d.id, room: null }; if (fl) state.floorId = fl.id; render(); } });
      li.appendChild(el('span', { class: 'dot', style: `background:${d.critical ? 'var(--bad)' : 'var(--steel-500)'}` }));
      li.appendChild(el('div', { style: 'flex:1', html: `${esc(d.label || DEVICE_KINDS.find(k => k.k === d.kind).n)}<div class="sub">${esc(rm ? rm.name : 'no room')} · ${esc(fl ? fl.name : 'no floor')}${d.watts ? ' · ' + d.watts + ' VA' : ''}</div>` }));
      ul.appendChild(li);
    });
    if (!ds.length) sub.appendChild(el('div', { class: 'empty' }, ['Nothing on this circuit yet.']));
    sub.appendChild(ul);
    sub.appendChild(el('button', { class: 'iconbtn', style: 'width:100%;margin-top:8px', onclick: () => startPlacing(c.id) }, ['+ Add device on plan']));
    cc.appendChild(sub);
    branch.appendChild(cc);

    /* naming guidance, in the tool rather than in the manual */
    branch.appendChild(disclose('naming', 'How to name a circuit', body => {
      body.appendChild(el('div', { class: 'hint' }, ['A directory entry answers one question: switch this off, and what goes dead? Name it for the answer.']));
      const rule = (t, d) => body.appendChild(el('div', { class: 'rule', html: `<b>${t}</b>${esc(d)}` }));
      rule('Dedicated load', 'Name the appliance, nothing else — Dishwasher, Range, Furnace, Well pump.');
      rule('One area, one kind', 'Area then load — “Kitchen — countertop receptacles”, “Bath — lights + fan”.');
      rule('Spans rooms', 'Lead with the biggest area, list the strays — “Bed 2, Bed 3 — receptacles”.');
      rule('Mixed kinds', 'Say so plainly — “Living — lights + receptacles”.');
      rule('Genuinely scattered', 'Name the dominant load and let the device list carry the rest. A circuit you cannot name in a phrase is worth a note.');
      body.appendChild(el('div', { class: 'hint' }, ['Rooms belong on the devices, not in the name — the impact panel and the Devices tab group by room for you. Avoid anything that goes stale: not a person’s name, not “new outlet”.']));
    }));

    /* re-landing loads: rare, so folded, and it sits with the circuit it acts on */
    branch.appendChild(disclose('reland', 'Move these loads elsewhere', body => {
      const dests = [];
      P().panels.forEach(pp => breakersOf(pp.id).forEach(x => circuitsOf(x.id).forEach(xc => {
        if (xc.id === c.id) return;
        dests.push([xc.id, `${pp.name} · ${x.slot}${xc.sub || ''}${x.label ? ' — ' + trunc(x.label, 18) : ''}`]);
      })));
      const can = !locked && ds.length && dests.length;
      const dsel = el('select', { class: 'i', disabled: can ? null : 'disabled',
        onchange: e => { if (e.target.value) moveCircuitLoads(c, e.target.value); } });
      dsel.appendChild(el('option', { value: '' }, [ds.length ? (locked ? '— locked —' : '— move loads to —') : '— nothing on this circuit —']));
      dests.forEach(([v, n]) => dsel.appendChild(el('option', { value: v }, [n])));
      body.appendChild(field('Re-land on', dsel,
        'Reassigns every device here. For when the wiring changed but the breaker stayed put — to move the breaker itself, use Move or swap at the bottom.'));
    }, ds.length ? { pill: ds.length + ' dev' } : null));
  });
  side.appendChild(branch);

  /* impact — scoped to the chosen half when this is a tandem */
  const affB = affectedBreakers(b);
  const affD = isTandem ? devicesOf(active.id) : affectedDevices(b);
  const im = el('div', { class: 'card tier-imp' });
  im.appendChild(el('h3', {}, [isTandem ? `If you switch off ${b.slot}${active.sub}` : 'If you switch this off']));
  const crit = affD.filter(d => d.critical);
  if (crit.length) im.appendChild(el('div', { style: 'background:#3a1c17;border:1px solid var(--bad);border-radius:2px;padding:8px;margin-bottom:9px;font-size:12px',
    html: `<strong style="color:var(--bad)">Critical loads affected:</strong><br>${crit.map(d => esc(d.label || d.kind)).join(', ')}` }));
  const byRoom = {};
  affD.forEach(d => { const rm = roomById(d.roomId); (byRoom[rm ? rm.name : 'Unassigned'] = byRoom[rm ? rm.name : 'Unassigned'] || []).push(d); });
  const keys = Object.keys(byRoom).sort();
  if (!keys.length) im.appendChild(el('div', { class: 'empty' }, ['Nothing mapped to this breaker yet. Discovery mode is the fastest way to find out what it feeds.']));
  keys.forEach(k => im.appendChild(el('div', { style: 'font-size:12.5px;padding:4px 0;border-bottom:1px solid var(--steel-800)',
    html: `<strong>${esc(k)}</strong> <span style="color:var(--steel-400)">— ${byRoom[k].map(d => esc(d.label || DEVICE_KINDS.find(x => x.k === d.kind).n)).join(', ')}</span>` })));
  if (isTandem) im.appendChild(el('div', { class: 'hint', style: 'margin-top:8px' },
    [`Tandem: ${b.slot}${cs.find(c => c.id !== active.id).sub} has its own handle and stays live.`]));
  else if (affB.length > 1) im.appendChild(el('div', { class: 'hint', style: 'margin-top:8px' }, [`Also drops ${affB.length - 1} other breaker${affB.length > 2 ? 's' : ''} (handle tie or subpanel).`]));
  side.appendChild(im);

  side.appendChild(disclose('notes', 'Notes & photo', body => {
    body.appendChild(inputFor(b, 'notes', { ph: 'Anything worth remembering', live: true }));
    body.appendChild(photoControl(b));
  }, b.notes || b.photoKey ? { pill: 'set', pillCls: 'live' } : null));

  /* Moving happens once, when a panel is rebuilt, so it sits down here with
     the other things you reach for rarely rather than beside the ratings. */
  side.appendChild(disclose('move', 'Move or swap', body => {
    const targets = moveTargets(b);
    const msel = el('select', { class: 'i', disabled: targets.length ? null : 'disabled',
      onchange: e => { if (e.target.value) moveBreaker(b, +e.target.value); } });
    msel.appendChild(el('option', { value: '' },
      [locked ? '— locked —' : targets.length ? '— move to slot —' : '— nowhere to move —']));
    targets.forEach(([v, n]) => msel.appendChild(el('option', { value: v }, [n])));
    body.appendChild(field('Move to slot', msel));
    body.appendChild(el('button', { class: 'iconbtn', style: 'width:100%', disabled: targets.length ? null : 'disabled',
      onclick: () => startMoving(b.id) }, ['Pick a space on the ladder']));
    body.appendChild(el('div', { class: 'hint', style: 'margin-top:8px' }, [locked
      ? 'Unlock this breaker to move it.'
      : 'The rating, wire, notes and every device on this breaker travel with it. Landing on an occupied space swaps the two.']));
  }, { pill: 'slot ' + b.slot }));

  side.appendChild(disclose('danger', 'Remove this breaker', body => {
    body.appendChild(el('div', { class: 'hint' }, ['The breaker and its circuits go; the devices survive and become unassigned.']));
    body.appendChild(el('button', { class: 'iconbtn', style: 'width:100%;border-color:var(--bad);color:var(--bad)', disabled: locked ? 'disabled' : null,
      onclick: () => { if (!confirm('Remove this breaker and its circuits? Devices become unassigned.')) return;
        edit(() => {
          circuitsOf(b.id).forEach(c => P().devices.forEach(d => { if (d.circuitId === c.id) d.circuitId = null; }));
          P().circuits = P().circuits.filter(c => c.breakerId !== b.id);
          P().breakers = P().breakers.filter(x => x.id !== b.id);
          state.sel = { breaker: null, circuit: null, device: null, room: null };
        }); render(); } }, ['Remove breaker']));
  }, { danger: true }));
}

/* The circuit name lives on the breaker while there is one circuit and on
   the circuits once it splits — that is what the ladder and the printed
   directory read in each case. Carry it across the toggle so a name never
   disappears just because a breaker became (or stopped being) a tandem. */
function syncCircuits(b) {
  const cs = circuitsOf(b.id);
  if (b.tandem) {
    if (cs.length === 1) {
      if (!cs[0].label && b.label) cs[0].label = b.label;
      cs[0].sub = 'A';
      P().circuits.push({ id: uid('cir'), breakerId: b.id, sub: 'B', label: '' });
    }
  } else {
    if (cs.length > 1) {
      const keep = cs[0]; keep.sub = null;
      cs.slice(1).forEach(c => { P().devices.forEach(d => { if (d.circuitId === c.id) d.circuitId = keep.id; }); });
      P().circuits = P().circuits.filter(c => c.breakerId !== b.id || c.id === keep.id);
      if (keep.label) { b.label = keep.label; keep.label = ''; }
    }
  }
}
function startPlacing(circuitId) {
  state.placing = { circuitId, kind: 'outlet', roomId: null };
  state.view = 'plan'; state.sideOpen = false;
  if (!P().floors.length) { state.placing = null; render(); return toast('Add a floor first'); }
  render(); toast('Tap the plan to place a device — keep tapping to add more');
}

/* What a switch operates, and what operates a load. Deliberately its own
   card rather than a step in the trace: a switch is not where a light gets
   its power from, and folding the two together would make the trace lie. */
function sideControls(side, d, locked) {
  const mine = controlsOf(d), by = controllersOf(d);
  if (!takesControls(d) && !by.length) return;

  const jump = t => () => {
    if (t.floorId) state.floorId = t.floorId;
    state.sel = { breaker: null, circuit: null, device: t.id, room: null };
    render();
  };
  const row = (t, note, onDrop) => {
    const li = el('li', { onclick: jump(t) });
    li.appendChild(el('span', { class: 'dot', style: `background:${t.critical ? 'var(--bad)' : 'var(--steel-500)'}` }));
    const cc = circuitById(t.circuitId), rm = roomById(t.roomId), fl = floorById(t.floorId);
    const where = [rm ? rm.name : 'no room', cc ? circuitLabel(cc) : 'unassigned']
      .concat(fl && fl.id !== d.floorId ? [fl.name] : []).join(' · ');
    li.appendChild(el('div', { style: 'flex:1', html: `${esc(deviceName(t))}<div class="sub">${esc(where + note)}</div>` }));
    if (onDrop) li.appendChild(el('button', {
      class: 'iconbtn ghost', title: 'Remove this link', style: 'padding:2px 7px;line-height:1.2',
      disabled: locked ? 'disabled' : null,
      onclick: e => { e.stopPropagation(); onDrop(); }
    }, ['×']));
    return li;
  };
  /* A switch and what it operates normally share a circuit. When they do
     not, the conductors of two circuits meet in one box, and killing one
     breaker leaves the other live in there. Worth saying out loud. */
  const crossed = list => list.filter(t => d.circuitId && t.circuitId && t.circuitId !== d.circuitId);

  if (takesControls(d)) {
    const c = el('div', { class: 'card' });
    c.appendChild(el('h3', {}, ['Controls']));
    if (mine.length) {
      const ul = el('ul', { class: 'list' });
      mine.forEach(t => ul.appendChild(row(t, multiwayNote(t, d), () => {
        edit(() => { d.controls = (d.controls || []).filter(id => id !== t.id); });
        render();
      })));
      c.appendChild(ul);
    } else {
      c.appendChild(el('div', { class: 'empty' }, ['Nothing recorded yet. Say what this switch operates and the plan will draw the link.']));
    }

    /* Candidates, current floor first: a switch almost always operates
       something in the room it stands in. */
    const cand = P().devices
      .filter(x => x.id !== d.id && !(d.controls || []).includes(x.id))
      .sort((a, b) => (a.floorId === d.floorId ? 0 : 1) - (b.floorId === d.floorId ? 0 : 1)
        || String(roomById(a.roomId) && roomById(a.roomId).name).localeCompare(String(roomById(b.roomId) && roomById(b.roomId).name))
        || deviceName(a).localeCompare(deviceName(b)));
    const pick = el('select', { class: 'i', disabled: locked ? 'disabled' : null,
      onchange: e => {
        const id = e.target.value; if (!id) return;
        edit(() => { d.controls = (d.controls || []).concat(id); });
        render();
      } });
    pick.appendChild(el('option', { value: '' }, [cand.length ? '+ Add what this controls…' : 'No other devices yet']));
    let group = null, gnode = null;
    cand.forEach(x => {
      const fl = floorById(x.floorId), gname = fl ? fl.name : 'No floor';
      if (gname !== group) { group = gname; gnode = el('optgroup', { label: gname }); pick.appendChild(gnode); }
      const rm = roomById(x.roomId);
      gnode.appendChild(el('option', { value: x.id }, [`${deviceName(x)} — ${rm ? rm.name : 'no room'}`]));
    });
    c.appendChild(pick);

    const bad = crossed(mine);
    if (bad.length) c.appendChild(el('div', { class: 'hint', style: 'margin-top:8px;color:var(--warn)' },
      [`On a different circuit: ${bad.map(deviceName).join(', ')}. Two circuits meet in this box — killing one breaker leaves the other live inside it.`]));
    else c.appendChild(el('div', { class: 'hint', style: 'margin-top:8px' },
      ['What this switch operates, not how it is wired. Power still traces circuit → breaker → panel; the link only records what goes dark when the switch does.']));
    side.appendChild(c);
  }

  if (by.length) {
    const c = el('div', { class: 'card' });
    c.appendChild(el('h3', {}, ['Controlled by']));
    const ul = el('ul', { class: 'list' });
    by.forEach(sw => ul.appendChild(row(sw, '', null)));
    c.appendChild(ul);
    if (by.length > 1) c.appendChild(el('div', { class: 'hint', style: 'margin-top:8px' },
      [by.length === 2 ? '3-way — either switch works it.' : `Switched from ${by.length} places.`]));
    const bad = crossed(by);
    if (bad.length) c.appendChild(el('div', { class: 'hint', style: 'margin-top:8px;color:var(--warn)' },
      [`${bad.map(deviceName).join(', ')} ${bad.length === 1 ? 'is' : 'are'} on a different circuit — both breakers must be off before opening either box.`]));
    side.appendChild(c);
  }
}

function sideDevice(side, d) {
  if (!d) return sideOverview(side);
  const locked = !!d.locked;
  const dis = { disabled: locked };
  const c = el('div', { class: 'card' });
  c.appendChild(el('h3', {}, ['Device', locked ? el('span', { class: 'pill live' }, ['locked']) : '']));
  c.appendChild(field('Label', inputFor(d, 'label', { ph: 'Dishwasher', live: true, rerender: true, disabled: locked })));
  const r = el('div', { class: 'row' });
  r.appendChild(field('Kind', selectFor(d, 'kind', DEVICE_KINDS.map(k => [k.k, k.n]), dis)));
  r.appendChild(field('Connected VA', inputFor(d, 'watts', { type: 'number', live: true, disabled: locked })));
  c.appendChild(r);
  const r2 = el('div', { class: 'row' });
  r2.appendChild(field('Floor', selectFor(d, 'floorId', P().floors.map(f => [f.id, f.name]), dis)));
  r2.appendChild(field('Room', selectFor(d, 'roomId', roomsOfFloor(d.floorId).map(x => [x.id, x.name]), { blank: '— none —', disabled: locked })));
  c.appendChild(r2);
  const circOpts = [];
  P().panels.forEach(p2 => breakersOf(p2.id).forEach(b => circuitsOf(b.id).forEach(cc =>
    circOpts.push([cc.id, `${p2.name} ${slotsFor(b.slot, b.poles).join('/')}${cc.sub || ''} — ${cc.label || b.label || b.amps + 'A'}`]))));
  c.appendChild(field('Circuit', selectFor(d, 'circuitId', circOpts, { blank: '— unassigned —', disabled: locked })));
  c.appendChild(field('Verification', selectFor(d, 'verify', VERIFY)));
  c.appendChild(checkFor(d, 'critical', 'Critical load — warn before switching off', dis));
  c.appendChild(checkFor(d, 'locked', 'Locked — keep this pin where it is'));
  c.appendChild(el('div', { class: 'hint', style: 'margin:2px 0 0' },
    [P().settings.lockPins
      ? 'Every pin is locked right now via “Pins locked” on the plan.'
      : locked ? 'This pin cannot be dragged, edited or deleted until you unlock it.'
               : 'Locking stops accidental drags on the plan.']));
  side.appendChild(c);

  sideControls(side, d, locked);

  /* trace */
  const tr = el('div', { class: 'card' });
  tr.appendChild(el('h3', {}, ['Trace to source']));
  const chain = traceToSource(d);
  chain.forEach((step, i) => {
    const row = el('div', { style: 'display:flex;gap:9px;align-items:center;padding:5px 0;cursor:' + (step.id ? 'pointer' : 'default'),
      onclick: () => { if (step.kind === 'breaker') { state.view = 'panel'; state.panelId = breakerById(step.id).panelId; state.sel = { breaker: step.id, circuit: null, device: null, room: null }; render(); } } });
    row.appendChild(el('span', { style: `width:9px;height:9px;border-radius:50%;background:${i === 0 ? 'var(--live)' : 'var(--steel-500)'};flex:0 0 auto` }));
    row.appendChild(el('div', { style: 'flex:1', html: `<div class="f" style="margin:0">${step.t}</div><div style="font:12.5px var(--mono)">${esc(step.n)}</div>` }));
    tr.appendChild(row);
    if (i < chain.length - 1) tr.appendChild(el('div', { style: 'margin-left:4px;width:1px;height:8px;background:var(--steel-600)' }));
  });
  side.appendChild(tr);

  const nt = el('div', { class: 'card' });
  nt.appendChild(el('h3', {}, ['Notes & photo']));
  nt.appendChild(inputFor(d, 'notes', { live: true }));
  nt.appendChild(photoControl(d));
  nt.appendChild(el('button', { class: 'iconbtn', style: 'width:100%;margin-top:10px;border-color:var(--bad);color:var(--bad)',
    disabled: locked ? 'disabled' : null,
    onclick: () => { if (!confirm('Delete this device?')) return; edit(() => { P().devices = P().devices.filter(x => x.id !== d.id); dropControlLinks([d.id]); state.sel.device = null; }); render(); } }, ['Delete device']));
  side.appendChild(nt);
}

function sideRoom(side, r) {
  if (!r) return sideOverview(side);
  const c = el('div', { class: 'card' });
  c.appendChild(el('h3', {}, ['Room']));
  c.appendChild(field('Name', inputFor(r, 'name', { live: true, rerender: true })));
  c.appendChild(field('Type', selectFor(r, 'type', ROOM_TYPES), 'Used for the GFCI and AFCI checks.'));
  c.appendChild(field('Floor', selectFor(r, 'floorId', P().floors.map(f => [f.id, f.name]))));
  side.appendChild(c);

  const ds = P().devices.filter(d => d.roomId === r.id);
  const bset = new Map();
  ds.forEach(d => { const cc = circuitById(d.circuitId); if (cc) bset.set(cc.breakerId, (bset.get(cc.breakerId) || 0) + 1); });
  const bc = el('div', { class: 'card' });
  bc.appendChild(el('h3', {}, ['Breakers serving this room']));
  if (!bset.size) bc.appendChild(el('div', { class: 'empty' }, ['Nothing assigned yet.']));
  const ul = el('ul', { class: 'list' });
  bset.forEach((n, bid) => {
    const b = breakerById(bid);
    const li = el('li', { onclick: () => { state.view = 'panel'; state.panelId = b.panelId; state.sel = { breaker: bid, circuit: null, device: null, room: null }; render(); } });
    li.appendChild(el('span', { class: 'dot', style: `background:${b.color || 'var(--steel-500)'}` }));
    li.appendChild(el('div', { style: 'flex:1', html: `Slot ${slotsFor(b.slot, b.poles).join('/')} — ${esc(b.label || b.amps + 'A')}<div class="sub">${n} device${n > 1 ? 's' : ''} · ${esc(b.type)}</div>` }));
    ul.appendChild(li);
  });
  bc.appendChild(ul);
  bc.appendChild(el('button', { class: 'iconbtn', style: 'width:100%;margin-top:10px;border-color:var(--bad);color:var(--bad)',
    onclick: () => { if (!confirm('Delete this room? Devices stay but lose their room.')) return; edit(() => { P().devices.forEach(d => { if (d.roomId === r.id) d.roomId = null; }); P().rooms = P().rooms.filter(x => x.id !== r.id); state.sel.room = null; }); render(); } }, ['Delete room']));
  side.appendChild(bc);
}

function sideFloor(side, secondary) {
  const f = currentFloor();
  if (!f) { if (!secondary) sideOverview(side); return; }
  const c = el('div', { class: 'card' });
  c.appendChild(el('h3', {}, ['Floor']));
  c.appendChild(field('Name', inputFor(f, 'name', { live: true, rerender: true })));
  c.appendChild(field('Level', inputFor(f, 'level', { type: 'number' }), 'Lower numbers sit lower in the stack. Onion skin shows the floor below.'));
  const imp = el('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: e => importFloorImage(f, e.target.files[0]) });
  c.appendChild(imp);
  c.appendChild(el('button', { class: 'iconbtn', style: 'width:100%;margin-top:6px', onclick: () => imp.click() }, [f.imgKey ? 'Replace plan image' : 'Import plan image']));
  c.appendChild(el('div', { class: 'hint', style: 'margin-top:6px' }, ['PNG or JPEG. Photograph a printed plan, screenshot a PDF, or export an image from any drawing tool.']));
  side.appendChild(c);

  const v = el('div', { class: 'card' });
  v.appendChild(el('h3', {}, ['View']));
  v.appendChild(el('div', { class: 'hint', style: 'margin:0' }, ['Onion skin, pin labels, image import and Discovery mode are on the plan itself, next to the zoom controls, so they stay available while something is selected.']));
  side.appendChild(v);

  const rl = el('div', { class: 'card' });
  rl.appendChild(el('h3', {}, ['Rooms on this floor']));
  const ul = el('ul', { class: 'list' });
  roomsOfFloor(f.id).forEach(r => {
    const li = el('li', { class: state.sel.room === r.id ? 'sel' : '', onclick: () => { state.sel = { breaker: null, circuit: null, device: null, room: r.id }; render(); } });
    li.appendChild(el('div', { style: 'flex:1', html: `${esc(r.name)}<div class="sub">${esc(r.type)} · ${P().devices.filter(d => d.roomId === r.id).length} devices</div>` }));
    ul.appendChild(li);
  });
  rl.appendChild(ul);
  rl.appendChild(el('button', { class: 'iconbtn', style: 'width:100%;margin-top:8px', onclick: addRoom }, ['+ Room']));
  side.appendChild(rl);

  if (secondary) return;   /* keep the destructive action out of a side section */
  const dl = el('div', { class: 'card' });
  dl.appendChild(el('h3', {}, ['Delete floor']));
  dl.appendChild(el('button', { class: 'iconbtn', style: 'width:100%;border-color:var(--bad);color:var(--bad)',
    onclick: () => { if (!confirm('Delete ' + f.name + ' with its rooms and pins?')) return;
      edit(() => {
        const gone = new Set(P().devices.filter(d => d.floorId === f.id).map(d => d.id));
        P().devices = P().devices.filter(d => d.floorId !== f.id); dropControlLinks(gone);
        P().rooms = P().rooms.filter(r => r.floorId !== f.id); P().floors = P().floors.filter(x => x.id !== f.id); state.floorId = null; });
      state.planFitted = false; render(); } }, ['Delete this floor']));
  side.appendChild(dl);
}

function photoControl(obj) {
  const w = el('div', { style: 'margin-top:8px' });
  const inp = el('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: async e => {
    const file = e.target.files[0]; if (!file) return;
    const key = uid('img');
    await Store.put('blobs', key, file);
    edit(() => { obj.photoKey = key; });
    render();
  } });
  w.appendChild(inp);
  if (obj.photoKey) {
    const img = el('img', { style: 'width:100%;border-radius:2px;margin-bottom:6px;border:1px solid var(--steel-600)' });
    Store.get('blobs', obj.photoKey).then(b => { if (b) img.src = URL.createObjectURL(b); });
    w.appendChild(img);
  }
  w.appendChild(el('button', { class: 'iconbtn', style: 'width:100%', onclick: () => inp.click() }, [obj.photoKey ? 'Replace photo' : 'Add photo']));
  return w;
}
async function importFloorImage(f, file) {
  if (!file) return;
  const key = f.imgKey || uid('img');
  await Store.put('blobs', key, file);
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    edit(() => { f.imgKey = key; f.w = img.naturalWidth; f.h = img.naturalHeight; });
    state.imgURL[f.id] = url; state.planFitted = false;
    render(); toast('Plan image loaded');
  };
  img.src = url;
}

/* ============================================================
   PANEL SETTINGS
   ============================================================ */
const highestUsedSlot = panelId => breakersOf(panelId)
  .reduce((m, b) => Math.max(m, ...slotsFor(b.slot, b.poles)), 0);

function spacesField(pan) {
  const dl = el('datalist', { id: 'commonspaces' });
  COMMON_SPACES.forEach(n => dl.appendChild(el('option', { value: n })));
  const inp = el('input', {
    class: 'i', type: 'text', inputmode: 'numeric', list: 'commonspaces',
    'data-fid': pan.id + ':spaces', value: pan.spaces, autocomplete: 'off',
    onchange: e => {
      let v = parseInt(e.target.value, 10);
      if (!isFinite(v)) { e.target.value = pan.spaces; return toast('Enter a number of spaces'); }
      v = clamp(v, 2, 200);
      const used = highestUsedSlot(pan.id);
      if (v < used) {
        e.target.value = pan.spaces;
        return toast(`Slot ${used} is occupied — clear it before shrinking to ${v}`);
      }
      snapshot(); pan.spaces = v; touch();
      e.target.value = v;
      render();
    }
  });
  const wrap = el('div');
  wrap.appendChild(inp); wrap.appendChild(dl);
  return wrap;
}
function openPanelSettings(pan) {
  const m = el('div', { class: 'modal', onclick: e => { if (e.target === m) m.remove(); } });
  const sh = el('div', { class: 'sheet' });
  sh.appendChild(el('h2', {}, ['Panel setup']));
  sh.appendChild(field('Name', inputFor(pan, 'name', { live: true })));
  const r1 = el('div', { class: 'row' });
  r1.appendChild(field('Brand', inputFor(pan, 'brand', { ph: 'Square D' })));
  r1.appendChild(field('Model', inputFor(pan, 'model', { ph: 'QO140M200' })));
  sh.appendChild(r1);
  const r2 = el('div', { class: 'row' });
  r2.appendChild(field('Spaces', spacesField(pan), 'Any number. Odd counts are fine.'));
  r2.appendChild(field('Phase', selectFor(pan, 'phase', [[1, '1Ø (residential)'], [3, '3Ø']], { number: true })));
  sh.appendChild(r2);
  const r3 = el('div', { class: 'row' });
  r3.appendChild(field('Main', selectFor(pan, 'mainType', [['main', 'Main breaker'], ['mlo', 'Main lugs only']])));
  r3.appendChild(field('Main / bus amps', selectFor(pan, 'mainAmps', AMP_CHOICES, { number: true })));
  sh.appendChild(r3);
  const r4 = el('div', { class: 'row' });
  r4.appendChild(field('Default wire size', selectFor(pan, 'defaultWire', WIRE_SIZES)));
  r4.appendChild(field('Location', inputFor(pan, 'location', { ph: 'Basement, north wall' })));
  sh.appendChild(r4);
  sh.appendChild(field('Tandem breakers allowed in', selectFor(pan, 'tandemSlots', [['all', 'Any slot'], ['none', 'No slots'], ['list', 'Only listed slots']])));
  if (pan.tandemSlots === 'list') sh.appendChild(field('Allowed slots', inputFor(pan, 'tandemList', { ph: '1 3 5 7 25 27' }), 'From the panel label. Comma or space separated.'));
  sh.appendChild(field('Notes', el('textarea', { class: 'i', oninput: e => { pan.notes = e.target.value; touchLive({}); } , html: esc(pan.notes || '') })));
  sh.appendChild(photoControl(pan));
  const bar = el('div', { style: 'display:flex;gap:8px;margin-top:14px' });
  bar.appendChild(el('button', { class: 'iconbtn on', style: 'flex:1', onclick: () => { snapshot(); touch(); m.remove(); render(); } }, ['Save panel']));
  if (P().panels.length > 1) bar.appendChild(el('button', { class: 'iconbtn', style: 'border-color:var(--bad);color:var(--bad)',
    onclick: () => { if (!confirm('Delete ' + pan.name + ' and everything in it?')) return;
      edit(() => {
        breakersOf(pan.id).forEach(b => { circuitsOf(b.id).forEach(c => { P().devices.forEach(d => { if (d.circuitId === c.id) d.circuitId = null; }); }); });
        P().circuits = P().circuits.filter(c => { const b = breakerById(c.breakerId); return !b || b.panelId !== pan.id; });
        P().breakers = P().breakers.filter(b => b.panelId !== pan.id);
        P().breakers.forEach(b => { if (b.subpanelId === pan.id) b.subpanelId = null; });
        P().panels = P().panels.filter(x => x.id !== pan.id);
        state.panelId = P().panels[0].id;
      }); m.remove(); render(); } }, ['Delete']));
  sh.appendChild(bar);
  m.appendChild(sh); document.body.appendChild(m);
}

/* ============================================================
   PRINT — directory card and full report
   ============================================================ */
function dirRows(pan) {
  const rows = Math.ceil(pan.spaces / 2), out = [];
  for (let r = 0; r < rows; r++) {
    const cells = [];
    [2 * r + 1, 2 * r + 2].forEach(slot => {
      const b = breakerAtSlot(pan.id, slot);
      if (!b) { cells.push({ slot, txt: ['<span class="empty">—</span>'], meta: '' }); return; }
      const cont = b.slot !== slot;
      const cs = circuitsOf(b.id);
      const txt = cont ? ['&#8593; ties to slot ' + b.slot]
        : (cs.length > 1 ? cs.map(c => `<b>${b.slot}${c.sub}</b> ${esc(c.label || '—')}`)
                         : [esc(b.label || '—')]);
      const meta = cont ? '' : [b.amps + 'A', b.poles > 1 ? b.poles + 'P' : '1P', b.type !== 'Standard' ? b.type : '', '#' + b.wire, b.hacr ? 'HACR' : '', b.tieId ? 'TIE' : '', b.subpanelId ? '→' + panelById(b.subpanelId).name : ''].filter(Boolean).join(' ');
      cells.push({ slot, txt, meta });
    });
    out.push(cells);
  }
  return out;
}
function directoryHTML(pan) {
  const rows = dirRows(pan);
  const body = rows.map(([L, R]) => `<tr>
    <td style="width:6%;text-align:center"><b>${L.slot}</b></td>
    <td style="width:29%">${L.txt.join('<br>')}</td><td style="width:13%" class="spec">${esc(L.meta)}</td>
    <td style="width:13%" class="spec">${esc(R.meta)}</td><td style="width:29%">${R.txt.join('<br>')}</td>
    <td style="width:6%;text-align:center"><b>${R.slot <= pan.spaces ? R.slot : ''}</b></td></tr>`).join('');
  return `<div class="page"><h1>${esc(pan.name)} — Circuit Legend</h1>
    <div class="meta">${esc(P().name)} · ${esc(pan.brand)} ${esc(pan.model)} · ${pan.spaces} spaces ·
    ${pan.mainType === 'main' ? pan.mainAmps + 'A main' : 'Main lugs only'} · ${esc(pan.location || '')} ·
    printed ${new Date().toLocaleDateString()}</div>
    <table class="dir"><thead><tr><th>#</th><th>Circuit</th><th>Spec</th><th>Spec</th><th>Circuit</th><th>#</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}
function printDirectory(pan) {
  $('#printroot').innerHTML = directoryHTML(pan);
  window.print();
}
function printFullReport() {
  const now = new Date().toLocaleString();
  let h = `<div class="page"><h1>${esc(P().name)} — Electrical Documentation</h1>
    <div class="meta">Generated ${now} · ${P().panels.length} panel(s) · ${P().breakers.length} breakers · ${P().devices.length} devices</div>
    <table><tr><th>Panel</th><th>Brand / model</th><th>Spaces</th><th>Main</th><th>Phase</th><th>Location</th></tr>
    ${P().panels.map(p2 => `<tr><td>${esc(p2.name)}</td><td>${esc(p2.brand)} ${esc(p2.model)}</td><td>${p2.spaces}</td>
      <td>${p2.mainType === 'main' ? p2.mainAmps + 'A' : 'MLO'}</td><td>${p2.phase}Ø</td><td>${esc(p2.location || '')}</td></tr>`).join('')}
    </table></div>`;
  P().panels.forEach(p2 => {
    h += directoryHTML(p2);
    h += `<div class="page"><h1>${esc(p2.name)} — Circuit Detail</h1>
      <table><tr><th>Slot</th><th>A</th><th>Poles</th><th>Type</th><th>Wire</th><th>Leg</th><th>Label</th><th>Rooms</th><th>Devices</th><th>VA</th><th>Verified</th></tr>
      ${breakersOf(p2.id).map(b => circuitsOf(b.id).map((c, i) => {
        const ds = devicesOf(c.id);
        const rooms = Array.from(new Set(ds.map(d => roomById(d.roomId)).filter(Boolean).map(r => r.name))).join(', ');
        return `<tr><td>${slotsFor(b.slot, b.poles).join('/')}${c.sub || ''}</td><td>${i ? '' : b.amps}</td><td>${i ? '' : b.poles}</td>
        <td>${i ? '' : esc(b.type) + (b.hacr ? ' HACR' : '')}</td><td>${i ? '' : '#' + b.wire}</td><td>${legOf(p2, b.slot)}</td>
        <td>${esc(c.label || b.label || '')}</td><td>${esc(rooms)}</td>
        <td>${esc(ds.map(d => d.label || DEVICE_KINDS.find(k => k.k === d.kind).n).join(', '))}</td>
        <td>${circuitVA(c.id) || ''}</td><td>${i ? '' : b.verify}</td></tr>`;
      }).join('')).join('')}</table>
      <p style="font-size:9px;margin-top:8px">Phase balance — ${Object.entries(legLoads(p2)).filter(([k, v]) => p2.phase === 3 || k !== 'C').map(([k, v]) => `Leg ${k}: ${Math.round(v)} VA`).join(' · ')}</p></div>`;
  });
  /* rooms */
  h += `<div class="page"><h1>Rooms</h1><table><tr><th>Floor</th><th>Room</th><th>Type</th><th>Devices</th><th>Breakers</th></tr>
    ${P().rooms.map(r => {
      const ds = P().devices.filter(d => d.roomId === r.id);
      const brk = Array.from(new Set(ds.map(d => { const c = circuitById(d.circuitId); return c ? c.breakerId : null; }).filter(Boolean)))
        .map(id => { const b = breakerById(id); return panelById(b.panelId).name + ' ' + slotsFor(b.slot, b.poles).join('/'); });
      const f = floorById(r.floorId);
      return `<tr><td>${esc(f ? f.name : '')}</td><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td>${ds.length}</td><td>${esc(brk.join(', '))}</td></tr>`;
    }).join('')}</table></div>`;
  /* checks */
  const iss = codeChecks();
  h += `<div class="page"><h1>Checks</h1><p style="font-size:9px">Advisory only. Code adoption varies by jurisdiction; verify with a licensed electrician.</p>
    <table><tr><th>Level</th><th>Finding</th><th>Reference</th></tr>
    ${iss.map(i => `<tr><td>${i.sev}</td><td>${esc(i.msg)}</td><td>${esc(i.ref)}</td></tr>`).join('')}</table></div>`;
  $('#printroot').innerHTML = h;
  window.print();
}

/* ============================================================
   BACKUP ARCHIVE
   A full-fidelity backup is a real .zip, so it opens anywhere and the
   images inside are browsable — but nothing here depends on a library.
   Entries are stored uncompressed, which images already are, and the
   file data is handed to the Blob constructor as Blob parts, so image
   bytes are never copied through a JS string. Only the CRC needs to
   read them, one file at a time.
   ============================================================ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
const dosDate = d => ((Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

async function zipWrite(entries) {
  if (entries.length > 0xFFFF) throw new Error('Too many files for a plain zip');
  const enc = new TextEncoder();
  const now = new Date(), time = dosTime(now), date = dosDate(now);
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const blob = e.blob instanceof Blob ? e.blob : new Blob([e.blob]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(bytes), size = bytes.length;
    if (offset + 30 + name.length + size > 0xFFFFFFFF) throw new Error('Backup is larger than a plain zip can address');
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);              /* version needed        */
    lh.setUint16(6, 0x0800, true);          /* names are UTF-8       */
    lh.setUint16(8, 0, true);               /* stored, not deflated  */
    lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, blob);
    central.push({ name, crc, size, offset });
    offset += 30 + name.length + size;
  }
  const cdStart = offset;
  central.forEach(c => {
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true);
    ch.setUint32(16, c.crc, true);
    ch.setUint32(20, c.size, true); ch.setUint32(24, c.size, true);
    ch.setUint16(28, c.name.length, true);
    ch.setUint32(38, 0, true);              /* external attributes   */
    ch.setUint32(42, c.offset, true);
    parts.push(new Uint8Array(ch.buffer), c.name);
    offset += 46 + c.name.length;
  });
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true);
  eo.setUint16(8, central.length, true); eo.setUint16(10, central.length, true);
  eo.setUint32(12, offset - cdStart, true);
  eo.setUint32(16, cdStart, true);
  parts.push(new Uint8Array(eo.buffer));
  return new Blob(parts, { type: 'application/zip' });
}

/* Reading stays lazy: entries come back as slices of the picked File, so
   a large archive is never held in memory all at once. */
async function zipRead(file) {
  const tailLen = Math.min(file.size, 66000);
  if (tailLen < 22) throw new Error('Not a zip archive');
  const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
  let p = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { p = i; break; }
  }
  if (p < 0) throw new Error('Not a zip archive');
  const eo = new DataView(tail.buffer, tail.byteOffset + p, 22);
  const count = eo.getUint16(10, true);
  const cdSize = eo.getUint32(12, true), cdOff = eo.getUint32(16, true);
  if (cdOff === 0xFFFFFFFF || count === 0xFFFF) throw new Error('Zip64 archives are not supported');
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const dir = new Map();
  let o = 0;
  for (let i = 0; i < count; i++) {
    if (o + 46 > cd.byteLength || cd.getUint32(o, true) !== 0x02014b50) throw new Error('Damaged zip directory');
    const method = cd.getUint16(o + 10, true);
    const csize = cd.getUint32(o + 20, true);
    const nlen = cd.getUint16(o + 28, true), elen = cd.getUint16(o + 30, true), clen = cd.getUint16(o + 32, true);
    const lho = cd.getUint32(o + 42, true);
    dir.set(dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + o + 46, nlen)), { method, csize, lho });
    o += 46 + nlen + elen + clen;
  }
  /* The local header's extra field can differ from the central one, so
     where the data actually starts is resolved per entry, on demand. */
  const read = async e => {
    const lh = new DataView(await file.slice(e.lho, e.lho + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('Damaged zip entry');
    const start = e.lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = file.slice(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) {
      if (typeof DecompressionStream !== 'function') throw new Error('That backup is compressed and this browser cannot expand it');
      return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    }
    throw new Error('Unsupported zip compression method ' + e.method);
  };
  return { names: () => Array.from(dir.keys()), get: n => dir.has(n) ? read(dir.get(n)) : Promise.resolve(null) };
}

/* ============================================================
   IMPORT / EXPORT
   ============================================================ */
/* Every key in the project that names something in the blob store. Walking
   the graph rather than listing the fields means a new kind of attachment
   is backed up without anyone remembering to come back here. */
function blobKeysOf(obj, out) {
  out = out || new Set();
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) { obj.forEach(x => blobKeysOf(x, out)); return out; }
  for (const k in obj) {
    const v = obj[k];
    if (typeof v === 'string' && v && /Key$/.test(k)) out.add(v);
    else if (v && typeof v === 'object') blobKeysOf(v, out);
  }
  return out;
}
const IMG_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif', 'image/svg+xml': 'svg',
  'image/bmp': 'bmp', 'image/tiff': 'tif', 'application/pdf': 'pdf'
};
/* Used only when restoring an archive with no usable manifest entry: a blob
   sliced out of a zip carries no type, and an untyped image is not reliably
   renderable, so the extension has to stand in for it. */
const EXT_MIME = Object.keys(IMG_EXT).reduce((m, k) => (m[IMG_EXT[k]] = k, m), { jpeg: 'image/jpeg' });
const slug = s => String(s || 'panel').replace(/\W+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'panel';
const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

function download(name, data, mime) {
  const b = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/json' });
  const url = URL.createObjectURL(b);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  /* Revoking immediately can cancel the download in some browsers; not
     revoking at all pins the whole archive until the page is closed. */
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function exportBackup() {
  if (state.busy) return;
  state.busy = true;
  try {
    toast('Building backup…');
    const entries = [], images = [];
    let missing = 0;
    for (const key of blobKeysOf(P())) {
      let blob = null;
      try { blob = await Store.get('blobs', key); } catch (e) {}
      if (!blob) { missing++; images.push({ key, missing: true }); continue; }
      const type = blob.type || 'application/octet-stream';
      const name = 'images/' + key + '.' + (IMG_EXT[type] || 'bin');
      entries.push({ name, blob });
      images.push({ key, file: name, type, size: blob.size });
    }
    const manifest = {
      app: 'circuit-legend', kind: 'backup', v: 1,
      exported: new Date().toISOString(),
      project: { id: P().id, name: P().name },
      images
    };
    entries.unshift(
      { name: 'project.json', blob: new Blob([JSON.stringify(P(), null, 2)], { type: 'application/json' }) },
      { name: 'manifest.json', blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }) }
    );
    const zip = await zipWrite(entries);
    const stamp = new Date().toISOString().slice(0, 10);
    download(`${slug(P().name)}-circuit-legend-backup-${stamp}.zip`, zip);
    toast(`Backup saved · ${plural(entries.length - 2, 'image')} · ${fmtSize(zip.size)}`
      + (missing ? ` · ${plural(missing, 'image')} missing from storage` : ''));
  } catch (e) {
    alert('The backup could not be built: ' + e.message);
  } finally { state.busy = false; }
}

function exportJSON() {
  download(slug(P().name) + '-circuit-legend.json', JSON.stringify(P(), null, 2));
  const n = blobKeysOf(P()).size;
  toast(n ? `Project data exported — ${plural(n, 'image')} not included, use Export backup for those`
          : 'Project data exported');
}
function exportCSV() {
  const rows = [['panel', 'slot', 'sub', 'amps', 'poles', 'type', 'wire', 'leg', 'label', 'hacr', 'locked', 'tie', 'subpanel', 'verify', 'room', 'floor', 'device', 'kind', 'va', 'critical', 'controls']];
  P().panels.forEach(p2 => breakersOf(p2.id).forEach(b => circuitsOf(b.id).forEach(c => {
    const ds = devicesOf(c.id);
    const base = [p2.name, slotsFor(b.slot, b.poles).join('/'), c.sub || '', b.amps, b.poles, b.type, b.wire, legOf(p2, b.slot),
      c.label || b.label || '', b.hacr, b.locked, b.tieId ? 'yes' : '', b.subpanelId ? panelById(b.subpanelId).name : '', b.verify];
    if (!ds.length) rows.push(base.concat(['', '', '', '', '', '', '']));
    ds.forEach(d => {
      const r = roomById(d.roomId), f = floorById(d.floorId);
      rows.push(base.concat([r ? r.name : '', f ? f.name : '', d.label || '', d.kind, d.watts, d.critical,
        controlsOf(d).map(deviceName).join('; ')]));
    });
  })));
  const csv = rows.map(r => r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(slug(P().name) + '-circuits.csv', csv, 'text/csv');
}

/* Swapping in a different project: one place, so nothing that has to be
   reset for the new data gets forgotten by one of the import paths. */
function adoptProject(data) {
  state.project = data;
  pruneControlLinks(data);
  state.panelId = data.panels.length ? data.panels[0].id : null;
  state.floorId = null;
  state.planFitted = false;
  state.moving = null;
  state.placing = null;
  state.sel = { breaker: null, circuit: null, device: null, room: null };
  state.devSelected = new Set();
  touch();
}

async function importBackupFile(file) {
  const zip = await zipRead(file);
  const pj = await zip.get('project.json');
  if (!pj) throw new Error('there is no project.json inside that archive');
  const data = JSON.parse(await pj.text());
  if (!data.panels || !data.breakers) throw new Error('that archive does not hold a Circuit Legend project');
  let manifest = null;
  const mf = await zip.get('manifest.json');
  if (mf) { try { manifest = JSON.parse(await mf.text()); } catch (e) {} }

  const wanted = blobKeysOf(data);
  if (!confirm(`Replace the current project with “${data.name || 'imported'}”?`
    + (wanted.size ? `\n\n${plural(wanted.size, 'image')} will be restored from the archive.` : ''))) return;

  /* Where each key's bytes live: the manifest is authoritative, and the
     file names are a fallback so a hand-edited archive still restores. */
  const byKey = new Map();
  zip.names().forEach(n => {
    const m = /^images\/([^/]+?)(?:\.([^./]*))?$/.exec(n);
    if (m) byKey.set(m[1], { file: n, type: EXT_MIME[(m[2] || '').toLowerCase()] || '' });
  });
  if (manifest && Array.isArray(manifest.images))
    manifest.images.forEach(i => { if (i && i.key && i.file) byKey.set(i.key, i); });

  /* Blobs first. If this throws, the loaded project is still untouched. */
  let restored = 0, absent = 0;
  for (const key of wanted) {
    const rec = byKey.get(key);
    const blob = rec ? await zip.get(rec.file) : null;
    if (!blob) { absent++; continue; }
    await Store.put('blobs', key, rec.type ? new Blob([blob], { type: rec.type }) : blob);
    restored++;
  }

  snapshot();
  adoptProject(data);
  await save();
  await loadImages();
  render();
  /* Whatever the old project referenced is unreachable now. Best effort:
     a storage engine that cannot enumerate must not fail the import. */
  try {
    const keep = blobKeysOf(state.project);
    for (const k of await Store.keys('blobs')) if (!keep.has(k)) await Store.del('blobs', k);
  } catch (e) {}
  toast(`Restored “${data.name || 'project'}” · ${plural(restored, 'image')}`
    + (absent ? ` · ${plural(absent, 'image')} not in the archive` : ''));
}

async function importProjectJSON(file) {
  const data = JSON.parse(await file.text());
  if (!data.panels || !data.breakers) throw new Error('that is not a Circuit Legend file');
  const wanted = blobKeysOf(data).size;
  if (!confirm(`Replace the current project with “${data.name || 'imported'}”?`
    + (wanted ? `\n\nThis file carries no images. ${plural(wanted, 'image')} will be blank unless they are already on this device.` : ''))) return;
  snapshot();
  adoptProject(data);
  await save();
  await loadImages();
  render();
  toast('Project imported' + (wanted ? ` · ${plural(wanted, 'image')} not in this file` : ''));
}

/* One entry point for both. The kind is sniffed from the file's own bytes
   rather than its extension, which is the part users rename. */
function importProject() {
  const inp = el('input', {
    type: 'file', accept: '.zip,.json,application/zip,application/json', style: 'display:none',
    onchange: async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
        const isZip = head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
        if (isZip) await importBackupFile(f);
        else await importProjectJSON(f);
      } catch (err) { alert('That file could not be read: ' + (err && err.message ? err.message : err)); }
    }
  });
  document.body.appendChild(inp); inp.click(); inp.remove();
}

/* ============================================================
   SEARCH
   ============================================================ */
function runSearch(q) {
  const box = $('#results');
  q = q.trim().toLowerCase();
  if (!q) { box.classList.remove('on'); box.innerHTML = ''; return; }
  const hits = [];
  P().breakers.forEach(b => {
    const pan = panelById(b.panelId);
    const hay = [b.label, b.type, b.notes, 'slot ' + b.slot, pan.name].join(' ').toLowerCase();
    if (hay.includes(q)) hits.push({ k: 'Breaker', n: `${pan.name} slot ${slotsFor(b.slot, b.poles).join('/')} — ${b.label || b.amps + 'A ' + b.type}`, go: () => { state.view = 'panel'; state.panelId = b.panelId; state.sel = { breaker: b.id, circuit: null, device: null, room: null }; } });
  });
  P().devices.forEach(d => {
    const r = roomById(d.roomId);
    const hay = [d.label, d.kind, d.notes, r ? r.name : ''].join(' ').toLowerCase();
    if (hay.includes(q)) hits.push({ k: 'Device', n: `${d.label || DEVICE_KINDS.find(k => k.k === d.kind).n} — ${r ? r.name : 'no room'}`, go: () => { state.view = 'plan'; if (d.floorId) state.floorId = d.floorId; state.sel = { breaker: null, circuit: null, device: d.id, room: null }; } });
  });
  P().rooms.forEach(r => { if ((r.name + ' ' + r.type).toLowerCase().includes(q)) hits.push({ k: 'Room', n: r.name, go: () => { state.view = 'rooms'; state.sel = { breaker: null, circuit: null, device: null, room: r.id }; } }); });
  box.innerHTML = '';
  if (!hits.length) { box.appendChild(el('div', { class: 'hit', style: 'color:var(--steel-500)' }, ['Nothing matched.'])); }
  hits.slice(0, 30).forEach(h => box.appendChild(el('div', { class: 'hit', onclick: () => { h.go(); state.sideOpen = true; $('#search').value = ''; box.classList.remove('on'); document.body.classList.remove('searching'); render(); },
    html: `<div class="k">${h.k}</div>${esc(h.n)}` })));
  box.classList.add('on');
}

/* ============================================================
   PROJECT MENU
   ============================================================ */
function openMenu() {
  const m = el('div', { class: 'modal', onclick: e => { if (e.target === m) m.remove(); } });
  const sh = el('div', { class: 'sheet' });
  sh.appendChild(el('h2', {}, ['Project']));
  const mk = (label, hint, fn) => {
    const b = el('button', { class: 'iconbtn', style: 'width:100%;text-align:left;margin-bottom:8px;padding:11px', onclick: () => { m.remove(); fn(); } });
    b.innerHTML = `${label}<div style="font:11px var(--ui);text-transform:none;letter-spacing:0;color:var(--steel-400);margin-top:3px">${hint}</div>`;
    return b;
  };
  sh.appendChild(mk('Export backup (.zip)', 'Everything: project data and every image. The one to keep.', exportBackup));
  sh.appendChild(mk('Export JSON', 'Project data only — small and diffable, no images.', exportJSON));
  sh.appendChild(mk('Export CSV', 'Flat circuit list for spreadsheets.', exportCSV));
  sh.appendChild(mk('Import backup or JSON', 'Replace this project from a .zip backup or a .json file.', importProject));
  sh.appendChild(mk('Print panel directory', 'The card that goes inside the panel door.', () => printDirectory(panelById(state.panelId) || P().panels[0])));
  sh.appendChild(mk('Print full report', 'Cover sheet, schedules, rooms and checks.', printFullReport));
  sh.appendChild(mk('Start a new project', 'Clears everything currently loaded.', () => {
    if (!confirm('Discard the current project and start fresh?')) return;
    snapshot(); state.project = newProject(); state.panelId = P().panels[0].id; state.floorId = null; state.planFitted = false; touch(); render();
  }));
  sh.appendChild(el('div', { class: 'hint', style: 'margin-top:12px' }, [
    'Everything is stored on this device and works with no network. Export regularly — clearing browser data will remove the project.'
  ]));
  m.appendChild(sh); document.body.appendChild(m);
}

/* ============================================================
   MOBILE SHELL
   Narrow screens get a bottom tab bar, and the inspector becomes a
   draggable bottom sheet instead of a fixed side rail.
   ============================================================ */
const mq = window.matchMedia('(max-width:900px)');
const isMobile = () => mq.matches;

const TAB_ICONS = {
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M3 9h9M12 15h9"/>',
  plan:  '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
  devices:'<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1.3"/><circle cx="4.5" cy="12" r="1.3"/><circle cx="4.5" cy="18" r="1.3"/>',
  rooms: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 10h18M10 10v11"/>',
  report:'<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5M9 13h7M9 17h7"/>'
};
const TAB_NAMES = { panel: 'Panel', plan: 'Plan', devices: 'Devices', rooms: 'Rooms', report: 'Report' };

function buildTabbar() {
  const bar = $('#tabbar');
  bar.innerHTML = '';
  ['panel', 'plan', 'devices', 'rooms', 'report'].forEach(v => {
    const b = el('button', {
      'data-view': v, 'aria-current': 'false', 'aria-label': TAB_NAMES[v],
      onclick: () => { closeSheet(); goView(v); }
    });
    b.innerHTML = `<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${TAB_ICONS[v]}</svg><span>${TAB_NAMES[v]}</span>`;
    bar.appendChild(b);
  });
}
function goView(v) {
  state.view = v;
  if (v !== 'panel') state.moving = null;
  if (v === 'plan') state.planFitted = false;
  render();
}

/* --- bottom sheet --- */
function openSheet()  { state.sideOpen = true;  syncSheet(); }
function closeSheet() { state.sideOpen = false; syncSheet(); }
function syncSheet() {
  const open = isMobile() && state.sideOpen;
  document.body.classList.toggle('sheet-open', open);
  document.body.classList.toggle('rail-hidden', !isMobile() && state.railHidden);
  $('#side').classList.toggle('open', open);
  $('#side').style.transform = '';
  const s = state.sel;
  document.body.classList.toggle('has-sel', !!(s.breaker || s.device || s.room) || state.view === 'plan');
}
function sheetTitle() {
  const s = state.sel;
  if (s.breaker) { const b = breakerById(s.breaker); return b ? 'Slot ' + slotsFor(b.slot, b.poles).join(' / ') : 'Breaker'; }
  if (s.device) { const d = deviceById(s.device); return d ? (d.label || 'Device') : 'Device'; }
  if (s.room) { const r = roomById(s.room); return r ? r.name : 'Room'; }
  if (state.view === 'plan') return 'Floor & view';
  return 'Project';
}
/* Drag the grabber down to dismiss — the gesture people expect. */
function makeSheetHead() {
  const head = el('div', { class: 'sheethead' });
  head.appendChild(el('div', { class: 'grab' }));
  const r = el('div', { class: 'r' });
  r.appendChild(el('div', { class: 't' }, [sheetTitle()]));
  r.appendChild(el('button', { class: 'iconbtn', 'aria-label': 'Close details', onclick: closeSheet }, ['Close']));
  head.appendChild(r);

  let sy = null, dy = 0;
  const side = $('#side');
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    sy = e.clientY; dy = 0;
    side.style.transition = 'none';
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', e => {
    if (sy === null) return;
    dy = Math.max(0, e.clientY - sy);
    side.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (sy === null) return;
    side.style.transition = '';
    side.style.transform = '';
    if (dy > 90) closeSheet();
    sy = null; dy = 0;
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
  return head;
}

function wireMobile() {
  buildTabbar();
  $('#scrim').addEventListener('click', closeSheet);
  $('#fab').addEventListener('click', () => {
    if (isMobile()) return openSheet();
    state.railHidden = false; render();
  });
  $('#searchBtn').addEventListener('click', () => {
    const on = document.body.classList.toggle('searching');
    $('#searchBtn').setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) $('#search').focus();
    else { $('#search').value = ''; $('#results').classList.remove('on'); }
  });
  /* Re-render when crossing the breakpoint so layout-dependent code
     (plan viewBox, sheet state) recomputes against the new width. */
  const onBreak = () => { state.planFitted = false; syncSheet(); render(); };
  if (mq.addEventListener) mq.addEventListener('change', onBreak);
  else mq.addListener(onBreak);
  window.addEventListener('orientationchange', () => setTimeout(onBreak, 250));
}

/* ============================================================
   RENDER + BOOT
   ============================================================ */
/* Re-rendering replaces the DOM node the user is typing into, which drops
   focus mid-word. Remember which field was focused and where the caret was,
   then put it back on the freshly built node. */
function captureFocus() {
  const a = document.activeElement;
  if (!a || !a.getAttribute) return null;
  const fid = a.getAttribute('data-fid');
  if (!fid) return null;
  let start = null, end = null;
  try { start = a.selectionStart; end = a.selectionEnd; } catch (e) {}
  return { fid, start, end };
}
function restoreFocus(f) {
  if (!f) return;
  const n = document.querySelector('[data-fid="' + f.fid.replace(/"/g, '\\"') + '"]');
  if (!n || n === document.activeElement) return;
  n.focus({ preventScroll: true });
  if (f.start !== null) { try { n.setSelectionRange(f.start, f.end); } catch (e) {} }
}

function render() {
  const focus = captureFocus();
  $('#projName').textContent = P().name || 'untitled project';
  $$('#tabs button, #tabbar button').forEach(b =>
    b.setAttribute('aria-current', b.getAttribute('data-view') === state.view ? 'true' : 'false'));
  if (state.view === 'panel') renderPanelView();
  else if (state.view === 'plan') renderPlanView();
  else if (state.view === 'rooms') renderRoomsView();
  else if (state.view === 'devices') renderDevicesView();
  else renderReportView();
  renderSide();
  restoreFocus(focus);
}
/* Rebuilds every floor's object URL from scratch. Importing replaces the
   whole floor list, so the old URLs are revoked first — otherwise they
   leak, and a reused floor id would keep showing the previous image. */
async function loadImages() {
  Object.values(state.imgURL).forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
  state.imgURL = {};
  for (const f of P().floors) {
    if (!f.imgKey) continue;
    try { const b = await Store.get('blobs', f.imgKey); if (b) state.imgURL[f.id] = URL.createObjectURL(b); } catch (e) {}
  }
}
async function boot() {
  await Store.open();
  let proj = null;
  try { proj = await Store.get('kv', 'project'); } catch (e) {}
  state.project = proj && proj.panels ? proj : newProject();
  pruneControlLinks(P());
  state.panelId = P().panels[0].id;
  await loadImages();

  $$('#tabs button').forEach(b => b.addEventListener('click', () => goView(b.dataset.view)));
  wireMobile();
  $('#undoBtn').addEventListener('click', undo);
  $('#menuBtn').addEventListener('click', openMenu);
  $('#search').addEventListener('input', e => runSearch(e.target.value));
  $('#search').addEventListener('blur', () => setTimeout(() => $('#results').classList.remove('on'), 180));
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') { /* let the browser print what we last built */ }
    if (e.key === 'Escape') {
      const wasPlacing = !!state.placing || !!state.moving;
      state.placing = null; state.moving = null; $('#results').classList.remove('on');
      document.body.classList.remove('searching');
      if (isMobile() && state.sideOpen) closeSheet();
      else if (!wasPlacing && hasSelection()) clearSelection();
      else render();
    }
  });
  let rsz;
  window.addEventListener('resize', () => {
    clearTimeout(rsz);
    rsz = setTimeout(() => { if (state.view === 'plan') render(); }, 120);
  });
  window.addEventListener('beforeunload', save);
  render();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
