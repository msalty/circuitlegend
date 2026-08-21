# Circuit Legend

Offline breaker panel documentation. No build step, no dependencies, no network.

## Files

```
index.html            app shell + stylesheet
app.js                everything else
sw.js                 service worker (directory-scoped)
manifest.webmanifest  PWA manifest
icon-192.png
icon-512.png
```

## Deploying under a subdirectory

Drop the whole folder at any path — `https://yoursite.com/circuit-legend/`, for
example — and it works as-is. Every path in the app is relative, and `sw.js` sits
beside `index.html`, so its scope is that directory and it will not interfere
with other PWAs on the same host.

Two things to know about co-residing PWAs:

- **Storage is origin-scoped, not path-scoped.** IndexedDB and Cache Storage are
  shared across every app on the host. This app namespaces both
  (`breakerpanel.db`, `circuitlegend-v1`). Make sure your other apps do the same.
  The IndexedDB name predates the rename from "Panel Book" and is kept as-is so
  existing projects are not orphaned; it is still unique on the origin.
- **The manifest sets an explicit `id`** (`"./"`, which resolves to whatever
  directory it is served from). Without an `id`, some browsers key installability
  off `start_url` and sibling apps can shadow each other. Because it is relative,
  you do not need to edit it when you choose a path.

Serve over HTTPS (or `localhost`) or the service worker will not register. The
app still runs fine without it — you just lose offline caching of the app shell
itself.

Opening `index.html` from the filesystem works too, but service workers are
disabled on `file://`.

## Where data lives

- Project data: IndexedDB, store `kv`, key `project`
- Floor plan images and photos: IndexedDB, store `blobs`

Nothing leaves the device. **Export JSON regularly** — clearing browser data
removes the project. JSON export is full fidelity and re-importable; images are
not embedded, so keep the originals.

## Layout

The app reflows at 900px.

**Desktop** — panel on the left, inspector docked on the right, tabs in the header.

**Phone / small tablet** — sections move to a bottom tab bar, and the inspector
becomes a bottom sheet you can dismiss by tapping Close, tapping outside it, or
dragging the grabber down. When something is selected but the sheet is closed, a
Details button floats above the tab bar to bring it back. The breaker ladder
scales to the viewport rather than scrolling sideways, toolbars scroll
horizontally, and the wide circuit schedule drops to Slot / Amps / Label / Load
below 420px. On the floor plan, floors run across the top, zoom sits bottom-left
and Details bottom-right, so nothing overlaps.

Safe-area insets are respected on notched devices, and inputs are set at 16px on
mobile so iOS does not zoom when a field is focused.

## Reading the ladder

The ladder is drawn at a fixed, legible size rather than shrunk to fit. On a
phone that means it is wider than the screen: one column plus the bus is visible
at a time, and **◀ Odd** / **Even ▶** jump between sides. This is deliberate —
readable slot text matters more than seeing both columns at once.

A **tandem** shows its two circuits as separate halves, each independently
selectable. Choosing 1A highlights only 1A's devices and the impact panel reports
only what 1A feeds, because the two halves have their own handles and one staying
live while the other is off is exactly the situation worth documenting. An A / B
switch in the details pane moves between them.

## Moving circuits

A rebuilt panel puts the same circuits on different spaces, so both halves of
that are editable after the fact.

**Moving a breaker** — the *Position* card in a breaker's details. Pick a slot
from the list, or press **Pick a space on the ladder** and tap the destination.
Everything hangs off the breaker record, so the label, rating, wire, notes,
photo, handle tie, verification and every circuit and device below it travel
with it; only the slot number changes. The phase leg is shown next to each
candidate slot, which is what you want when the balance readout tells you a
heavy circuit is on the wrong leg.

Landing on an occupied space **swaps** the two breakers — the one already there
takes the slots you vacated. A swap is refused rather than half-applied when it
cannot work cleanly: more than one breaker across the destination, a multi-pole
that would run past the last space or would not fit back into the slots you
left, or either breaker being locked. The ladder greys out every space that
would fail and tells you why if you tap one.

**Moving loads** — *Move loads to another circuit*, in the circuit card. This
reassigns every device on the circuit to another circuit anywhere in the
project, for when the breaker stayed put but the wiring under it was re-landed.
Locked devices are left behind and the count is reported.

Both are one undo step (`Ctrl`/`Cmd` + `Z`), and `Esc` cancels a move in
progress.

## Panel size

**Spaces** accepts any number from 2 to 200, with common sizes offered as
suggestions. Space counts vary by manufacturer and series — 22, 26 and 34 all
exist, and odd counts are handled correctly (the last row simply has one side).
The ladder, slot numbering, phase legs, checks and printed directory all follow
whatever count you set.

Shrinking a panel below an occupied slot is refused rather than silently
orphaning breakers; clear the high slots first.

## Locking pins

Two levels, because they solve different problems:

- **Per device** — tick *Locked* in a device's details. That pin cannot be
  dragged, edited or deleted until you unlock it, and bulk actions skip it
  (they report how many were held back). Lock or unlock many at once from the
  Devices list.
- **Whole plan** — the **Lock pins** button on the plan freezes every pin on
  every floor. Use this once a survey is finished; locking a few hundred pins
  individually is not realistic. The setting is saved with the project.

A locked pin still selects on click and still highlights normally — dragging it
pans the plan instead of moving the pin, as though it were part of the drawing.
Locked pins carry a small ⚿ mark.

## Devices list

The **Devices** tab is the master list of everything in the project. Filter by
floor, room, or free text; the count chips across the top double as filters for
the states you usually want to fix — no circuit, no room, unverified, critical.
Sort by any column header. Tick rows to bulk-assign a circuit or room, mark them
verified, or delete them, which is the fast way to clean up after a survey.

**+ Add on plan** drops unassigned devices: useful when walking a building and
recording what exists before you know which breaker feeds it. Assign circuits
later from this list.

## Placing devices

Open a breaker, pick a circuit, and press **+ Add device on plan**. The plan
switches to crosshair mode with a banner across the top; each click drops a
device on that circuit, so you can add several in a row. Press **Done** in the
banner or `Esc` to stop. Dragging to pan never places a device, and clicking an
existing pin selects it instead.

Pan by dragging, zoom with the wheel, pinch, or the `−` / `+` / `FIT` controls.
Drag a pin to reposition it.

Plan controls — **Import image**, **Onion skin**, **Labels**, **Discovery** — sit
on the canvas next to the zoom buttons rather than in the side panel, so they
stay reachable no matter what is selected. Onion skin only appears when there is
a floor below the current one.

The rail shows one subject at a time — the selected breaker, device or room, or
the floor settings when nothing is selected. **Floor setup** on the plan is the
explicit route back to floor settings while something else is selected.

Clicking empty space on the plan or beside the panel clears the selection, and
so does `Esc`. On desktop the rail header carries **Deselect** and **Hide**
(collapse the rail); a handle on the right edge brings it back. On mobile the
rail is a sheet: **Close**, tap outside, or drag the grabber down, and
**Details** reopens it.

## Keyboard

- `Ctrl`/`Cmd` + `Z` — undo
- `Esc` — cancel pin placement or a breaker move, close search
- `Tab` / `Enter` — breakers and pins are focusable and activatable

## Model notes

**Poles vs. handle tie** are deliberately separate concepts:

- **Poles (1/2/3)** is a real multi-pole breaker with common trip. It occupies
  slots *n*, *n+2*, *n+4* — the physical 1-3-5 geometry — and serves one 240 V
  circuit.
- **Handle tie** joins two *independent* breakers, consecutive or not. They
  switch together but remain separate circuits at separate loads.

**Tandem** splits one space into circuits A and B. If your panel only permits
tandems in listed slots, enter them under *Panel setup* and the checks will flag
violations.

**Subpanel** on a breaker makes that breaker a feeder. Downstream load rolls up
into the feeder's VA, phase balance, and impact analysis automatically.

## Checks

Advisory only. Wire ampacity uses the 240.4(D) small-conductor limits for 14/12/10
AWG and the 75 °C copper table above that; GFCI and AFCI expectations are keyed to
room type. Code adoption varies by jurisdiction and cycle. This is a documentation
tool, not an inspection.

## Not built yet

- Google Sheets / Drive sync (see the plan in chat — Drive JSON as canonical,
  Sheets as a generated projection)
- QR label sheets
- PDF plan import (needs `pdf.js` bundled into this folder to stay offline)
- Capacitor wrapper for app-store distribution
