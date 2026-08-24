# Multiple projects — implementation plan

Written against `0b822e6`. Line numbers are from that commit and will drift;
function names are the stable reference.

## Goal

Hold more than one project in the app at once, switch between them, and make the
project name in the header the switcher. One person documenting a house, a
rental, and their parents' place; or a contractor with a project per client site.

**Not in scope here:** sync, sharing, multi-user, cross-project search, client/site
metadata. See "What this deliberately doesn't do" at the end — some of it is cheap
to add afterwards, one item is an order of magnitude more work.

## Why this is tractable

The model is already per-project-clean:

- Only **8 lines** touch `state.project` (`app.js:158, 281, 292, 297, 2405, 2458, 2543, 2713`).
- Only **2 lines** touch the `kv` store (`app.js:292` write, `app.js:2712` read).
- **Every id reference is internal to one project graph.** Subpanel feeds
  (`subpanelId`), handle ties (`tieId`), `circuitId`, `roomId`, `floorId`,
  `panelId`, `mainPanelId` all point within the same project. There is nothing
  to untangle at the model layer.
- The header **already** renders the project name — `render()` writes `P().name`
  into `#projName` (`app.js:2687`). "My House" is just the default in
  `newProject()` (`app.js:125`). It becomes a button, not new plumbing.
- `adoptProject()` already exists (added for backup import) and is the natural
  seam for swapping projects.

Estimated ~300–400 lines, most of it new UI rather than surgery.

---

## Storage layout

```
kv   'index'          { v:1, current:<projectId>, projects:[ {id,name,created,updated,panels,devices} ] }
kv   'project:<id>'   the project record (same shape as today)
kv   'project'        LEGACY single slot — migrated on first boot, then LEFT IN PLACE (see below)
blobs <key>           unchanged: flat, one store, no project prefix
```

### Why blobs stay flat

Prefixing blob keys with a project id would mean rewriting every existing key —
a migration that touches every image, where a partial failure orphans them. A
flat store costs a reachability sweep instead, which only runs on delete and
import, not on every save. Take the cheaper failure mode.

```js
/* Every blob key any stored project can still reach. */
async function reachableBlobKeys() {
  const idx = await getIndex(), keep = new Set();
  for (const meta of idx.projects) {
    const p = meta.id === P().id ? state.project : await Store.get('kv', 'project:' + meta.id);
    if (p) blobKeysOf(p, keep);
  }
  return keep;
}
```

`blobKeysOf()` already exists (`app.js:2310`) and walks the graph for keys ending
in `Key`, so it needs no changes.

### Migration, and why the legacy key stays

```js
/* boot() */
let idx = await Store.get('kv', 'index');
if (!idx) {
  const legacy = await Store.get('kv', 'project');
  const first = legacy && legacy.panels ? legacy : newProject();
  await Store.put('kv', 'project:' + first.id, first);
  idx = { v: 1, current: first.id, projects: [indexRow(first)] };
  await Store.put('kv', 'index', idx);
  /* kv:'project' is deliberately NOT deleted here. */
}
```

**Do not delete `kv:'project'` in this release.** The service worker is
cache-first (`sw.js`), so after deploying, a tab that was already open — or one
that loads before the new worker activates — is still running the old `app.js`,
which reads and writes `kv:'project'` and knows nothing about the index. Leaving
the legacy record means that tab keeps working on its own data instead of
finding an empty app. The two copies diverge, which is untidy but not
destructive; deleting the key would be destructive. Remove it a release later,
once no old worker can plausibly still be live.

Bump `CACHE` in `sw.js` as usual so installed copies pick up the new `app.js`.

---

## Three hazards

These are the parts that are not obvious, and two of them are latent bugs in the
code **today** that only become visible once a second project exists.

### 1. The blob GC deletes other projects' images (bug today, dormant)

`importBackupFile()` ends with (`app.js:2455-2459`):

```js
const keep = blobKeysOf(state.project);
for (const k of await Store.keys('blobs')) if (!keep.has(k)) await Store.del('blobs', k);
```

That is correct only while exactly one project exists. The moment there are two,
importing a backup wipes the *other* project's floor plans and photos.

**Fix, and it must land in the same change as the index — not after:** swap
`blobKeysOf(state.project)` for `await reachableBlobKeys()`. Run the sweep on
project delete and backup import. Do **not** run it on every save.

### 2. Project-scoped state must swap as one unit

`adoptProject()` (`app.js:2404`) resets `panelId`, `floorId`, `planFitted`,
`moving`, `placing`, `sel`, `devSelected`. It **misses `devFilter`** — which
holds `floorId` and `roomId` ids (`app.js:265`, applied in `deviceRows()` at
`app.js:1301-1302`). After a switch, a stale filter silently empties the Devices
tab with no visible cause. This is already reachable today via backup import.

`state.plan` (pan/zoom) is not reset either, but `planFitted = false` makes the
next plan render call `fitPlan()`, so that one self-heals. Leave it.

`state.undo` needs a **different answer per caller**:

| caller | undo stack | why |
| --- | --- | --- |
| backup / JSON import | keep | `Ctrl`+`Z` should undo the import |
| project switch | clear | undoing across projects would restore another building over this one |

So give it a flag:

```js
function adoptProject(data, opts) {
  ...
  state.devFilter = { q: '', floorId: '', roomId: '', kind: '', flag: '' };
  if (!(opts && opts.keepUndo)) state.undo = [];
  touch();
}
```

`loadImages()` already revokes and rebuilds `state.imgURL`, so object URLs are
handled — keep calling it after every adopt.

### 3. The debounced save straddles the switch

`touch()` schedules `save()` 350 ms out; `save()` reads `state.project` when the
timer fires (`app.js:288-292`).

Keying the write by `P().id` fixes half of this by itself: a late save writes
whatever is in `state.project` to *that project's* key, so nothing lands in the
wrong slot. What it does **not** fix is the loss — switch inside the window and
the outgoing project's last 350 ms of edits are simply never written.

```js
async function flushSave() { clearTimeout(saveTimer); await save(); }
```

Call it first in `switchProject()`, and also before export and before delete.

---

## Work stages

Each stage is independently shippable and testable. Stage 1 changes no UI.

### Stage 1 — storage layer (no visible change)

- `getIndex()` / `putIndex()` / `indexRow(p)` helpers.
- `save()` keys by `'project:' + P().id`, and refreshes that project's index row
  in the same call (name and `updated` stay current for free — the row is cheap
  and `save()` is already debounced).
- `flushSave()`.
- `boot()` migration as above.
- `reachableBlobKeys()`; rewrite the import GC to use it.
- `adoptProject()` gains `devFilter` reset and the `keepUndo` option.
- Fix the aliasing bug below.

**Aliasing bug, also latent today.** `importFloorImage()` reuses the existing
key when replacing a plan image (`app.js:2020`):

```js
const key = f.imgKey || uid('img');
```

With one project that is fine. With duplicated or twice-imported projects, two
floors share a blob key, and replacing the image on one silently changes the
other. Mint a fresh key every time and let the GC reclaim the old blob:

```js
const key = uid('img');
```

(`photoControl()` already does this correctly — it always mints.)

### Stage 2 — switching and the project list

- `switchProject(id)`: `flushSave()` → load → `adoptProject(data)` →
  `loadImages()` → write `index.current` → `render()`.
- `newProject` / `renameProject` / `duplicateProject` / `deleteProject`.
- **Duplicate** must deep-clone the record with fresh ids throughout *and* copy
  its blobs under fresh keys — otherwise the copy aliases the original's images
  and the Stage 1 fix only covers the replace path.
- **Delete** requires a typed or explicit confirm (it destroys a survey), then
  runs the GC sweep, then switches to another project — or creates a fresh one
  if it was the last.
- `boot()` opens `index.current`, falling back to the most recently updated.

### Stage 3 — import/export semantics

The `.zip` format needs **no change** — it is already one project plus its
images, and `manifest.json` already carries `project: {id, name}`.

- Import gains a choice: **Replace current** or **Add as a new project**.
  Default to add-as-new once more than one project exists.
- Add-as-new must mint a fresh project id **if the incoming id already exists in
  the index**, or the two collide on `project:<id>`. Blob keys may legitimately
  be shared between the two copies — reachability handles that correctly, and
  the Stage 1 mint-on-replace fix stops them from clobbering each other.
- Export always exports the *current* project. Add "Export backup" per row in
  the project list so you can back up one without switching to it (it reads from
  the store, so it does not need to be loaded).

### Stage 4 — optional, once the above is solid

- `navigator.storage.estimate()` readout in the project list, and a warning past
  ~80%. Several buildings of plan photos will find the browser's limits, and a
  silent quota failure is the worst way to discover that.
- A "reclaim space" action that runs the GC sweep manually.
- Cross-project search (`runSearch()` currently walks `P()` only).

---

## UI

**Header.** `#projName` (`index.html:458`) becomes a button: current project name
plus a small chevron, opening the project menu. Keep the existing `.brand small`
type so the header does not reflow. On mobile the header is already tight
(`.brand` drops to 11px at the breakpoint, `index.html:324`) — the name needs a
`max-width` with ellipsis rather than being allowed to push the tabs.

**Project menu.** Reuse the existing `.modal` / `.sheet` pattern from
`openMenu()` (`app.js:2526`) rather than inventing a popover. One row per
project:

```
Maple St                                    3 panels · 84 devices · 2 days ago
Rental — Oak Ave                            1 panel  · 22 devices · Jun 14
─────────────────────────────────────────────────────────────────────────────
+ New project      Import as new project
```

Current project marked, tap to switch. Per-row overflow: Rename, Duplicate,
Export backup, Delete. Counts come from the index row, so the list renders
without loading every project.

**Project menu in `openMenu()`.** The existing "Start a new project" item
(`app.js:2543`) currently *replaces* the loaded project — that becomes "New
project" in the switcher and the destructive version goes away.

---

## Testing

The repo has no test runner; existing verification has been ad-hoc Playwright
scripts driving the real app (see the session history for the pattern —
`page.evaluate` against the app's own globals, plus `filechooser` /`download`
events). Worth writing these as scripts under `test/` this time, since the state
matrix is now big enough to regress.

Cases that matter:

1. **Migration** — boot with only `kv:'project'` present; project survives, index
   is created, legacy key still there.
2. **Switch round trip** — edit A, switch to B within the 350 ms save window,
   switch back; A's last edit is present. (Fails without `flushSave()`.)
3. **Stale filter** — set a Devices floor filter in A, switch to B; Devices tab
   is not mysteriously empty. (Fails without the `devFilter` reset.)
4. **Undo isolation** — edit A, switch to B, `Ctrl`+`Z`; B is unchanged and A is
   not restored over it.
5. **GC does not cross projects** — two projects with images, import a backup
   over one; the other's images still resolve. (Fails against today's GC.)
6. **Duplicate is independent** — duplicate a project, replace a floor image in
   the copy; the original's image is unchanged.
7. **Import-as-new with a colliding id** — import the same backup twice; two
   distinct projects, both with working images.
8. **Delete** — delete a project; its blobs go, every other project's survive;
   deleting the last one leaves a usable empty project.
9. **Reload** — after each of the above, reload and confirm the state persisted
   to IndexedDB rather than living in memory.

---

## What this deliberately doesn't do

**Site / building hierarchy.** Probably unnecessary. A project already holds
multiple panels wired as a distribution tree via subpanel feeders, which is how a
building actually works. A campus is a project per building; the grouping that
would add is a label, not a structure. Don't build it until something concretely
needs it.

**Contractor features.** Client and site metadata on the project record,
per-project branding on the printed directory, and cross-project search are each
small and additive once projects exist. None of them changes the model.

**Sync and sharing.** This is the expensive one, and it is a different project
entirely — the Drive/Sheets item in the README's "Not built yet". The moment two
people need the same project you need conflict resolution, and every local-first
assumption in the app gets re-examined. Local multi-project is a prerequisite for
it and forecloses nothing, which is a good reason to do it first and separately.
