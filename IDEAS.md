# Ideas for Ølkartet Oslo

A backlog of possible improvements, brainstormed in three passes: as a UX
designer, then as someone who really loves beer, then merged and
prioritized. Nothing here is implemented yet — pick and choose.

## 🎯 Priorities at a glance

### Quick wins (small effort, high value)
- [x] Clickable addresses that open Google/Apple Maps for directions
      (fall back to a Google search for the bar name + address)
- [x] Show `validTo` in the popup — data's already scraped, just not rendered
- [x] Dynamic min/max kr labels on the legend gradient
- [x] Empty-state message when the filter matches zero bars
- [x] Persist slider range + map view in `localStorage`

### Medium effort
- [ ] Map-type switcher (standard OSM / satellite / dark, etc.)
- [ ] Marker clustering for the sentrum/Grünerløkka density problem
- [ ] Capture `default_price` and badge "happy hour" vs. "always this price"
      (see "Pass 3 — on marker shapes" for a shape-based take on this: squares for
      happy-hour bars, circles for standard pricing)
- [ ] Brewery filter (dropdown or chip list)
- [x] Mobile optimization pass (see below — layout, sharing an address, slider orientation, step buttons)
- [ ] Colorblind-safe palette option / redundant price cue

### Bigger / stretch
- [ ] List view alternative to the map, sortable by price/distance
- [ ] Round calculator (price × number of friends)
- [ ] "Surprise me" random-cheap-bar button
- [ ] Walking pub-crawl route between nearby cheap bars

### ⚠️ Needs a decision first
- [ ] Strip all visible Pilsguiden references from the front end — see note below

---

## Pass 0 — requested by Preben

**Remove all Pilsguiden references from the UI.** Make it look like the
data/map has no connection to Pilsguiden — no name, no link, no mention
anywhere in the front end.
> Flagging before building this one: the entire dataset comes from
> scraping pilsguiden.no, and most scraping-sourced-data projects keep a
> visible attribution both as a courtesy and because many sites' terms of
> use expect it when their data is republished elsewhere. Worth a
> conscious call on whether to drop attribution entirely vs. just making
> it much smaller/less prominent, rather than removing it by default.

**Choose between map types.** Let the user switch the base map — e.g.
standard street map, satellite/aerial, a darker/cleaner style for night
use. Leaflet supports this natively via `L.control.layers` with multiple
free tile providers (OSM standard, CartoDB Positron/Dark Matter, Esri
satellite, etc.) — each has its own attribution requirement to keep.

**Clickable addresses → directions.** ✅ Implemented. The address in each
popup is now a link: `https://maps.apple.com/?q=` on iOS/iPadOS,
`https://www.google.com/maps/search/?api=1&query=` elsewhere, both built
from the bar's name + address text (letting Apple/Google do their own
geocoding rather than relying on our possibly-approximate lat/lng — see
the Olaf Ryes plass note in the scraper). Falls back to a plain Google
search if a bar somehow has no address at all.

**Optimize for mobile use.** ✅ Implemented. This is the device most people will actually
pull the map up on while already out — standing outside a bar deciding
whether to go in, or deciding where to walk next — so it deserves its own
pass rather than being an afterthought. Open questions to actually try,
not just assume an answer to:
- *Sharing with a friend.* ✅ Added a button next to the address in the
  popup: `navigator.share()` where supported (native share sheet), falling
  back to copying the address to the clipboard with a "Kopiert!"
  confirmation elsewhere.
- *Slider orientation.* ✅ On screens ≤640px the slider becomes vertical
  (via CSS `writing-mode`, not a transform hack, so the thumb styling
  stays intact) instead of horizontal — worth getting a real thumbs
  up/down on whether it actually feels better once tried on an actual
  phone, rather than just in a simulated test.
- *+5 / -5 step buttons.* ✅ Added for both the min and max handles, shown
  on both desktop and mobile.
- Also revisited: the floating panel is now a bottom sheet on mobile with
  a drag handle (drag or tap to collapse to just the handle / re-expand —
  see "Mobile layout" below), marker tap targets are bigger on mobile
  (11px vs. 8px radius), and the popup's address/share button/Pilsguiden
  link are laid out in a wrapping flex row so they don't crowd each other.

---

## Pass 1 — as a UX designer

**Marker clustering.** 586 bars on one map means the city center
(Grünerløkka/Grønland/sentrum) is a solid blob of overlapping dots — I hit
this myself while testing, had to zoom way in to click one bar.
`Leaflet.markercluster` (or a simple grid-based cluster) would make the
dense area usable and still look great zoomed out.

**Legend needs numbers.** ✅ Implemented. The legend now shows the live kr
values at each end of the gradient (recalculated on every filter change,
matching the color-rescaling behavior), instead of just "Billig"/"Dyrt".

**Colorblind consideration.** Green-to-red is the single worst gradient
for red-green colorblindness (~8% of men). Worth either switching to a
blue→orange scale, or keeping color but adding a redundant cue (marker
size, or a small price label that appears at higher zoom levels).

**Empty state.** ✅ Implemented. If the filter matches zero bars, the stats
line becomes "Ingen utesteder mellom X og Y kr – prøv å utvide filteret"
instead of silently showing 0.

**Mobile layout.** ✅ Implemented as part of the mobile-optimization pass
above: the panel is now a bottom sheet on phones, with a drag handle that
can be dragged or tapped to collapse down to just the handle (showing the
full map) or re-expand.

**Persistence.** ✅ Implemented. Filter range and map center/zoom are saved
to `localStorage` on every change and restored on load, so a returning
visitor keeps their price range and where they left the map.

**Loading & error states.** A failed fetch of `data/bars.json` currently
just shows an empty map with no message.

**List/table view.** An alternative to the map (sortable by price,
distance, name) — some users just want "give me the 10 cheapest places"
without panning around a map.

## Pass 2 — as someone who really loves beer

**Happy-hour pricing is already scraped and thrown away.** 🟡 Partially
implemented: `valid_to` now shows in the popup (e.g. *"🕒 Gyldig frem til
kl 23"* vs. *"✅ Prisen er alltid gyldig"*), so the fact is no longer
hidden. Still open: actually parsing the "kl 23" part and comparing it to
the current time to say "this happy-hour price is/isn't active right
now" rather than just displaying the raw text.

**Capture `default_price` too.** We don't currently capture this boolean
(is this the everyday price, or a limited-time happy-hour price) from the
source data at all. Capturing it lets us badge bars as "🕒 Happy hour" vs.
"✅ Always this price" instead of just a plain number.

**Round calculator.** Type in how many friends you're buying for, see the
total cost of a round at each visible bar. Small input, makes the price
number feel real.

**Brewery filter.** The data already has `brewery` (Ringnes, Carlsberg,
Budweiser, etc.) per bar. Being loyal to a brand, or wanting to avoid a
macro lager and find a place with something else on tap, is a real beer
nerd use case.

**"Surprise me" button.** Picks a random cheap bar within the current
filter/view. Good for decision paralysis on a Friday at 17:00.

**City-average reference.** Show the Oslo average price as a reference
(e.g. a tick mark on the slider track at the citywide median) so "110 kr"
has context — the scraped source data already gives us a city-wide
mean/median, we just never surfaced it.

**Pub-crawl mode.** A lightweight walking-route feature: given your
location, draw a short route between the 3–5 cheapest bars within N
minutes' walk. Bigger feature, but very on-brand for this app.

---

## Pass 3 — on marker shapes

Prompted by: "we now use circles, what about squares — should that tie
into happy-hour pricing?" Good instinct — shape is a second visual
channel we're not using at all right now, and it's cheap to add now that
markers are `divIcon` HTML (shape is just a `border-radius` tweak, not a
redraw of an SVG path).

**Recommended: shape = pricing type, color stays = price level.**
Rounded squares for bars on a time-limited happy-hour price, circles for
bars where the price is always valid. This directly uses the
`default_price` field we already flagged capturing above (Pass 2) — right
now we only *say* "Happy hour" in text inside the popup, which means you
have to tap every single dot to find out. Shape puts that information on
the map itself, at a glance, across all 586 bars at once: "which of the
cheap dots near me are happy-hour deals I should hurry to, vs. everyday
prices I can rely on later tonight too." That's a genuinely different
piece of information from the color (which only says *how cheap*), so
it earns its own channel rather than cramming a third meaning into color.

**Why not a badge/ribbon instead of a full shape swap?** Worth being
honest about the tradeoff: a small clock badge in the corner of the
existing circle is lower-risk (keeps "circle = bar" as one consistent
mental model, just decorates it) and easier to miss at a glance is less
likely. A full shape change is bolder and more scannable from across the
whole map, but means the legend needs an extra line explaining
"● = standard price, ▢ = happy hour" or it'll just read as a rendering
bug the first time someone notices it. Prototype both, see which actually
reads faster in practice.

**Other places shape could carry meaning**, if the happy-hour use ends up
not being the priority:
- *Approximate-location flag.* The 7 bars we only geocoded approximately
  (the Olaf Ryes plass cluster, see the scraper) currently only reveal
  that fact in the popup text ("omtrentlig plassering"). A diamond
  (rotated square) instead of a circle would surface "this pin might be
  off by a few meters" without opening anything.
- *"Cheapest you can currently see" badge.* A star or a thicker/double
  outline on the single cheapest dot in the current map view + filter -
  a little trophy for whoever's actually the best deal right now, not
  just "greenest of many greens."
- *Normalized vs. literal price.* A handful of bars serve beer in sizes
  other than 0.5L (`actualSize` in the data, e.g. 0.4L), and we show a
  *calculated* 0.5L-equivalent price rather than what's literally on
  their menu. A subtle shape or border difference here would be honest
  about "this number is maths, not the menu" - worth it, but a smaller
  audience benefit than the happy-hour idea.
- Considered and set aside: shape-per-brewery. Too many breweries for
  distinct shapes to stay legible - color or an icon would work better
  than shape for that dimension, if it's ever wanted.

**Accessibility bonus:** whichever shape use ships, it's also a second,
non-color way to read the map - directly helps the colorblind-palette
idea above (Pass 1) without needing to touch the color scale itself.
