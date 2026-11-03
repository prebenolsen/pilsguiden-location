import * as Community from "./community.js";

const STALE_DAYS = 14;
const OSLO_CENTER = [59.9139, 10.7522];
// Bars just outside the slider range fade out gradually instead of
// disappearing immediately, so a bar 1-2 kr over the limit is still
// visible (faintly) rather than vanishing. A bar inside the filter is
// always fully opaque; the instant it's outside, it steps straight down
// to FADE_START_OPACITY, then fades the rest of the way to invisible by
// FADE_WINDOW_KR past the edge. Staleness never affects opacity - only
// the price filter does - it's shown purely via the dashed border.
const FADE_WINDOW_KR = 20;
const FADE_START_OPACITY = 0.5;

const STORAGE_KEYS = { filter: "olkartet:filter", view: "olkartet:view", showNearby: "olkartet:showNearby" };

function loadStored(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null; // unavailable (private browsing, quota, etc.) - just skip persistence
  }
}

function saveStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ditto
  }
}

// iPadOS 13+ identifies as "MacIntel" in the UA string, so a touch check
// is needed to tell it apart from an actual Mac.
function isApplePlatform() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

// Point directions at the address text itself (not our geocoded lat/lng):
// Apple/Google's own geocoding of a well-formed street address is at least
// as good as what we got from Nominatim, and for the handful of bars we
// only approximately placed, it's likely better.
function directionsUrl(bar) {
  if (!bar.address) {
    return `https://www.google.com/search?q=${encodeURIComponent(bar.name)}`;
  }
  const query = encodeURIComponent(`${bar.name}, ${bar.address}`);
  return isApplePlatform()
    ? `https://maps.apple.com/?q=${query}`
    : `https://www.google.com/maps/search/?api=1&query=${query}`;
}

const map = L.map("map", { zoomControl: false }).setView(OSLO_CENTER, 12);

const savedView = loadStored(STORAGE_KEYS.view);
if (
  savedView &&
  Number.isFinite(savedView.lat) &&
  Number.isFinite(savedView.lng) &&
  Number.isFinite(savedView.zoom)
) {
  map.setView([savedView.lat, savedView.lng], savedView.zoom);
}
map.on("moveend", () => {
  const center = map.getCenter();
  saveStored(STORAGE_KEYS.view, { lat: center.lat, lng: center.lng, zoom: map.getZoom() });
});

// Tapping the bare map (not a marker/popup/control - those all stop this
// event reaching here, per Leaflet convention) collapses the bottom sheet
// out of the way, since that's almost always what someone wants right
// after they've tapped the map itself.
map.on("click", () => {
  document.getElementById("panel").classList.add("collapsed");
});

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI_GRAY_ATTRIBUTION = "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS";

// Esri's gray "Canvas" basemaps ship as two layers: a base (landmass/roads)
// and a transparent "Reference" overlay with labels - combine them with a
// layerGroup so they switch together as one entry in the control. Unlike
// CartoDB's Positron/Dark Matter (now API-key-only), these work anonymously.
function grayCanvasLayer(variant) {
  const opts = { maxNativeZoom: 16, maxZoom: 19, attribution: ESRI_GRAY_ATTRIBUTION };
  return L.layerGroup([
    L.tileLayer(
      `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${variant}_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
      opts
    ),
    L.tileLayer(
      `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${variant}_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
      { maxNativeZoom: 16, maxZoom: 19 }
    ),
  ]);
}

const baseLayers = {
  Standard: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: OSM_ATTRIBUTION,
  }),
  Lys: grayCanvasLayer("Light"),
  Mørk: grayCanvasLayer("Dark"),
  Satellitt: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics, and the GIS community",
    }
  ),
};

const STORAGE_KEY_BASE_LAYER = "olkartet:baseLayer";
const savedBaseLayerName = loadStored(STORAGE_KEY_BASE_LAYER);
const initialBaseLayer = baseLayers[savedBaseLayerName] ? savedBaseLayerName : "Standard";
baseLayers[initialBaseLayer].addTo(map);

L.control.layers(baseLayers, null, { position: "topright" }).addTo(map);
map.on("baselayerchange", (e) => saveStored(STORAGE_KEY_BASE_LAYER, e.name));

const markersLayer = L.layerGroup().addTo(map);

let scrapedBars = []; // pristine catalogue from data/bars.json, never mutated
let bars = []; // scrapedBars merged with community data - what's actually rendered
let minPrice = 0;
let maxPrice = 0;

// Rebuilds `bars` from the pristine scraped catalogue + whatever community
// data is currently cached in community.js. Always starts from
// `scrapedBars` (never the previous `bars`) so spreadOverlappingBars below
// doesn't compound its in-place lat/lng nudging across repeated merges.
function rebuildBars() {
  bars = Community.mergeBars(scrapedBars);
  spreadOverlappingBars(bars);
}

// Bar names only show up once zoomed in enough that there's realistically
// room for them - below this, the dots alone are already dense (see
// renderMarkers' collision-avoidance, which also has the final say on any
// individual bar: this is just the "even bother checking" gate).
const NAME_LABEL_MIN_ZOOM = 15;
const labelMeasureCtx = document.createElement("canvas").getContext("2d");

function nameLabelWidth(name) {
  labelMeasureCtx.font = "700 11px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  return labelMeasureCtx.measureText(name).width;
}

function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// Markers currently on the map, kept outside renderMarkers so zoom/pan
// handlers can re-run label placement without re-filtering the dataset.
let currentMarkers = [];

// Greedy label placement: dots (always shown) occupy space first, then
// each bar - cheapest first, since that's what the app is for - tries a
// label above its dot, then below, and goes label-less if neither pixel
// rect is free. Re-run on every zoom/pan since screen positions and the
// zoom gate both change.
function updateNameLabels() {
  if (map.getZoom() < NAME_LABEL_MIN_ZOOM) {
    currentMarkers.forEach(({ marker }) => {
      if (marker.getTooltip()) marker.unbindTooltip();
    });
    return;
  }

  const occupied = currentMarkers.map(({ marker, radius }) => {
    const pt = map.latLngToLayerPoint(marker.getLatLng());
    return { left: pt.x - radius, right: pt.x + radius, top: pt.y - radius, bottom: pt.y + radius };
  });

  const byPrice = [...currentMarkers].sort((a, b) => a.bar.pricePerHalfLiter - b.bar.pricePerHalfLiter);

  byPrice.forEach(({ marker, bar, radius }) => {
    const pt = map.latLngToLayerPoint(marker.getLatLng());
    const halfWidth = nameLabelWidth(bar.name) / 2 + 4;
    const labelHeight = 14;
    const gap = 4;
    const candidates = [
      { dir: "top", top: pt.y - radius - gap - labelHeight },
      { dir: "bottom", top: pt.y + radius + gap },
    ].map((c) => ({ ...c, left: pt.x - halfWidth, right: pt.x + halfWidth, bottom: c.top + labelHeight }));

    const fit = candidates.find((c) => !occupied.some((rect) => rectsOverlap(c, rect)));

    if (marker.getTooltip()) marker.unbindTooltip();

    if (fit) {
      occupied.push(fit);
      marker.bindTooltip(escapeHtml(bar.name), {
        permanent: true,
        direction: fit.dir,
        offset: [0, fit.dir === "top" ? -radius : radius],
        className: "bar-name-label",
        interactive: false,
      });
    }
  });
}

map.on("zoomend moveend", updateNameLabels);

function daysSince(isoDate) {
  const then = new Date(isoDate).getTime();
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

function isStale(bar) {
  return daysSince(bar.priceChecked) >= STALE_DAYS;
}

// default_price === false means this is a time-limited (happy-hour)
// price rather than the bar's everyday one - confirmed against the
// source data: it's always paired with "Gyldig frem til kl X" text.
function isHappyHour(bar) {
  return bar.defaultPrice === false;
}

// Oslo's current wall-clock minute-of-day, independent of the visitor's
// own timezone - "kl 23" in the source data always means 23:00 in Oslo.
function osloMinutesNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour * 60 + minute;
}

// Parses "Gyldig frem til kl 23" (or "kl 23:30") into a minute-of-day.
// Returns null for anything else ("Prisen gjelder til stengetid" etc.) -
// we can't compute a countdown without a concrete hour.
function parseValidToMinuteOfDay(validTo) {
  const match = /kl\.?\s*(\d{1,2})(?:[:.](\d{2}))?/i.exec(validTo || "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

// Minutes until a happy-hour bar's price reverts to normal, today, Oslo
// time. Null if not a happy-hour bar, the cutoff can't be parsed, or
// today's cutoff has already passed (stale snapshot - don't guess).
function minutesUntilPriceChange(bar) {
  if (!isHappyHour(bar)) return null;
  const cutoff = parseValidToMinuteOfDay(bar.validTo);
  if (cutoff === null) return null;
  const remaining = cutoff - osloMinutesNow();
  return remaining > 0 ? remaining : null;
}

// "2t" once under 2h left, exact minutes once under 1h - null (no badge)
// otherwise, per the "nobody cares yet if it's 3 hours away" call.
function priceChangeBadge(bar) {
  const remaining = minutesUntilPriceChange(bar);
  if (remaining === null || remaining > 120) return null;
  if (remaining > 60) return "2t";
  return `${remaining}m`;
}

// Green (cheap) -> yellow (mid) -> red (expensive), interpolated in HSL hue space.
// lo/hi are the currently visible price range, so the scale always stretches
// across whatever the filter/slider is showing right now.
// alpha lets the fill fade (for bars just outside the filter) without
// touching the dot's own opacity - that would wash out the price number
// along with the background, against the busy map tiles underneath.
function priceColor(price, lo, hi, alpha = 1) {
  const hue = hi === lo ? 140 : 140 - Math.max(0, Math.min(1, (price - lo) / (hi - lo))) * 140;
  return `hsla(${hue}, 85%, 45%, ${alpha})`;
}

// Dot radius, doubled from the original plain-circle size as a first pass
// at making the price number inside legible, then doubled again (same size
// on every device, not just touchscreens) for easier tapping/clicking.
const DOT_RADIUS = 22;

function priceDotIcon(bar, color, stale) {
  const radius = DOT_RADIUS;
  const diameter = radius * 2;
  const fontSize = Math.round(diameter * 0.38);
  const borderColor = stale ? "#333" : "#1a1a1a";
  const borderStyle = stale ? "dashed" : "solid";
  const borderWidth = stale ? 2 : 1;
  const happyHour = isHappyHour(bar);
  const badge = priceChangeBadge(bar);

  // Shape is a second, color-independent channel: rounded squares mark a
  // time-limited (happy-hour) price, circles mark the everyday price.
  const shapeClass = happyHour ? " price-dot--square" : "";
  const badgeHtml = badge ? `<span class="price-dot-badge" title="Prisen stiger om ${badge}">${badge}</span>` : "";

  // The dot's own opacity stays at 1 always - only the fill color (passed
  // in with its own alpha, see priceColor) fades, so the number and
  // border stay fully legible no matter how faded the fill is.
  const html = `
    <div class="price-dot${shapeClass}" style="
      width: ${diameter}px;
      height: ${diameter}px;
      font-size: ${fontSize}px;
      background: ${color};
      border-color: ${borderColor};
      border-style: ${borderStyle};
      border-width: ${borderWidth}px;
    ">${Math.round(bar.pricePerHalfLiter)}${badgeHtml}</div>
  `;

  return L.divIcon({
    html,
    className: "price-dot-anchor",
    iconSize: [diameter, diameter],
    iconAnchor: [diameter / 2, diameter / 2],
    popupAnchor: [0, -diameter / 2],
  });
}

// Simple "opens elsewhere" glyph (box + outward arrow), the standard
// external-link cue, so it's clear the address button leaves the page.
const EXTERNAL_LINK_ICON = `
  <svg class="external-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
    <path d="M14 3h7v7h-2V6.41l-9.3 9.3-1.41-1.42 9.29-9.29H14V3z" fill="currentColor"/>
    <path d="M5 5h6v2H7v10h10v-4h2v6H5V5z" fill="currentColor"/>
  </svg>
`;

function popupHtml(bar) {
  const stale = isStale(bar);
  const staleHtml = stale
    ? `<div class="stale-warning">⚠ Pris sjekket for ${Math.floor(daysSince(bar.priceChecked))} dager siden</div>`
    : "";
  const happyHour = isHappyHour(bar);
  const remaining = minutesUntilPriceChange(bar);
  const countdownHtml =
    remaining !== null
      ? ` – stiger til vanlig pris om ${remaining > 60 ? `${Math.floor(remaining / 60)}t ${remaining % 60}min` : `${remaining} min`}`
      : "";
  const validToHtml = bar.validTo
    ? `<div class="valid-to${happyHour ? " time-limited" : ""}">${happyHour ? "🕒" : "✅"} ${escapeHtml(bar.validTo)}${countdownHtml}</div>`
    : "";
  const metaHtml = bar.brewery ? `<div class="meta">Bryggeri: ${escapeHtml(bar.brewery)}</div>` : "";
  const addressLabel = bar.address
    ? `${escapeHtml(bar.address)}${bar.approxLocation ? " (omtrentlig plassering)" : ""}`
    : "";
  const addressActionHtml = bar.address
    ? `
        <a class="popup-btn address-btn" href="${directionsUrl(bar)}" target="_blank" rel="noopener" title="Åpne veibeskrivelse i kart-app">
          📍 ${addressLabel}${EXTERNAL_LINK_ICON}
        </a>
        <button type="button" class="popup-btn copy-btn" data-bar-id="${bar.id}">
          📋 Kopier adresse
        </button>
      `
    : "";
  const communityHtml = bar.communitySourced
    ? `<div class="community-badge">👥 Pris meldt inn av brukere</div>`
    : "";
  const priceRefAttrs = bar.priceRef.scrapedBarId != null
    ? `data-scraped-bar-id="${bar.priceRef.scrapedBarId}"`
    : `data-community-bar-id="${bar.priceRef.communityBarId}"`;
  const sizeOptionsHtml = Community.SIZE_OPTIONS.map(
    (opt) => `<option value="${opt.value}">${escapeHtml(opt.label)}</option>`
  ).join("");

  return `
    <div class="bar-popup">
      <h3>${escapeHtml(bar.name)}</h3>
      <div class="price">${Math.round(bar.pricePerHalfLiter)} kr / 0,5L</div>
      ${communityHtml}
      ${validToHtml}
      ${metaHtml}
      ${staleHtml}
      <div class="popup-actions">
        ${addressActionHtml}
      </div>
      <div class="popup-submit-price">
        <button type="button" class="popup-btn submit-price-toggle">💶 Meld inn pris</button>
        <form class="price-submit-form" ${priceRefAttrs} hidden>
          <select class="price-submit-size">${sizeOptionsHtml}</select>
          <input type="number" class="price-submit-amount" placeholder="kr" min="1" max="999" step="1" required />
          <button type="submit" class="popup-btn">Send</button>
          <span class="price-submit-status"></span>
        </form>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function wireCopyButton(el) {
  const btn = el.querySelector(".copy-btn");
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = "1";

  btn.addEventListener("click", async () => {
    // Bar ids are numeric for scraped bars, "community-<uuid>" strings for
    // community ones - compare as strings so both match.
    const bar = bars.find((b) => String(b.id) === btn.dataset.barId);
    if (!bar || !navigator.clipboard) return;

    try {
      await navigator.clipboard.writeText(bar.address);
      const original = btn.textContent;
      btn.textContent = "✅ Kopiert!";
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    } catch {
      // clipboard blocked (permissions/insecure context) - nothing else we can do
    }
  });
}

function wirePriceSubmitForm(el) {
  const toggle = el.querySelector(".submit-price-toggle");
  const form = el.querySelector(".price-submit-form");
  if (!toggle || !form || toggle.dataset.wired) return;
  toggle.dataset.wired = "1";

  toggle.addEventListener("click", () => {
    if (!Community.isSignedIn()) {
      Community.signInWithGoogle();
      return;
    }
    form.hidden = !form.hidden;
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const statusEl = form.querySelector(".price-submit-status");
    const sizeLabel = form.querySelector(".price-submit-size").value;
    const rawPrice = Number(form.querySelector(".price-submit-amount").value);
    const submitBtn = form.querySelector("button[type=submit]");

    if (!rawPrice || rawPrice <= 0) {
      statusEl.textContent = "Skriv inn en gyldig pris.";
      return;
    }

    const scrapedBarId = form.dataset.scrapedBarId ? Number(form.dataset.scrapedBarId) : null;
    const communityBarId = form.dataset.communityBarId || null;

    submitBtn.disabled = true;
    statusEl.textContent = "Sender...";
    try {
      await Community.submitPriceReport({ scrapedBarId, communityBarId, sizeLabel, rawPrice });
      statusEl.textContent = "Takk! Prisen er oppdatert.";
      // The resulting data refresh re-renders all markers/popups shortly
      // after this, which closes this popup - the message above is mostly
      // for the instant before that happens.
    } catch (err) {
      submitBtn.disabled = false;
      statusEl.textContent = err.message || "Noe gikk galt.";
    }
  });
}

// Popups are cached on their marker by Leaflet (closing doesn't destroy the
// DOM), so each wire-up function guards against re-wiring on every reopen.
map.on("popupopen", (e) => {
  const el = e.popup.getElement();
  if (!el) return;
  wireCopyButton(el);
  wirePriceSubmitForm(el);
});

// 1 (fully opaque) inside the filter range. The instant a bar is outside
// it, this steps down to FADE_START_OPACITY (at 1 kr past the edge) and
// then fades linearly the rest of the way to 0 by FADE_WINDOW_KR past it.
function fadeFactor(price, filterMin, filterMax) {
  if (price >= filterMin && price <= filterMax) return 1;
  const distance = price < filterMin ? filterMin - price : price - filterMax;
  const remainingSpan = FADE_WINDOW_KR - 1 || 1;
  return Math.max(0, FADE_START_OPACITY * (1 - (distance - 1) / remainingSpan));
}

// Whether the faded "near-miss" bars (just outside the filter) are drawn
// at all. Defaults to hidden - persisted like the other filter state.
let showNearby = Boolean(loadStored(STORAGE_KEYS.showNearby));
let currentFilter = { min: 0, max: 0 };

function renderMarkers(filterMin, filterMax) {
  currentFilter = { min: filterMin, max: filterMax };
  markersLayer.clearLayers();

  const inRangeBars = bars.filter(
    (bar) => bar.pricePerHalfLiter >= filterMin && bar.pricePerHalfLiter <= filterMax
  );
  const nearbyBars = bars.filter((bar) => {
    const fade = fadeFactor(bar.pricePerHalfLiter, filterMin, filterMax);
    return fade > 0 && fade < 1;
  });

  // Rescale the color gradient to whatever's strictly in range, so the
  // priciest in-range bar is always red and the cheapest always green.
  // Faded near-misses naturally clamp to the nearest extreme color.
  const inRangePrices = inRangeBars.map((b) => b.pricePerHalfLiter);
  const colorLo = inRangePrices.length ? Math.min(...inRangePrices) : filterMin;
  const colorHi = inRangePrices.length ? Math.max(...inRangePrices) : filterMax;

  const radius = DOT_RADIUS;
  currentMarkers = [];
  const barsToDraw = showNearby ? [...inRangeBars, ...nearbyBars] : inRangeBars;
  for (const bar of barsToDraw) {
    const fade = fadeFactor(bar.pricePerHalfLiter, filterMin, filterMax);
    const stale = isStale(bar);
    const marker = L.marker([bar.lat, bar.lng], {
      icon: priceDotIcon(bar, priceColor(bar.pricePerHalfLiter, colorLo, colorHi, fade), stale),
    });
    marker.bindPopup(popupHtml(bar));
    marker.addTo(markersLayer);
    currentMarkers.push({ marker, bar, radius });
  }
  updateNameLabels();

  document.getElementById("legend-min").textContent = `${colorLo} kr`;
  document.getElementById("legend-max").textContent = `${colorHi} kr`;

  // Only speak up when the filter comes up empty - the user doesn't need a
  // running tally of how many bars are shown or hidden otherwise.
  const countEl = document.getElementById("visible-count");
  if (inRangeBars.length === 0) {
    countEl.textContent = `Ingen utesteder mellom ${filterMin} og ${filterMax} kr – prøv å utvide filteret.`;
    countEl.classList.add("empty-state");
  } else {
    countEl.textContent = "";
    countEl.classList.remove("empty-state");
  }
}

function setupNearbyToggle() {
  const btn = document.getElementById("toggle-nearby-btn");

  function updateLabel() {
    btn.textContent = showNearby
      ? "🙈 Skjul utestedene nær filtergrensen"
      : "👁 Vis utestedene nær filtergrensen";
  }

  updateLabel();
  btn.addEventListener("click", () => {
    showNearby = !showNearby;
    saveStored(STORAGE_KEYS.showNearby, showNearby);
    updateLabel();
    renderMarkers(currentFilter.min, currentFilter.max);
  });
}

function setupSlider() {
  const minInput = document.getElementById("slider-min");
  const maxInput = document.getElementById("slider-max");
  const rangeEl = document.getElementById("slider-range");
  const label = document.getElementById("price-range-label");

  [minInput, maxInput].forEach((input) => {
    input.min = minPrice;
    input.max = maxPrice;
  });

  const savedFilter = loadStored(STORAGE_KEYS.filter);
  if (savedFilter && Number.isFinite(savedFilter.min) && Number.isFinite(savedFilter.max)) {
    minInput.value = Math.max(minPrice, Math.min(maxPrice, savedFilter.min));
    maxInput.value = Math.max(minPrice, Math.min(maxPrice, savedFilter.max));
  } else {
    minInput.value = minPrice;
    maxInput.value = Math.min(minPrice * 2, maxPrice);
  }

  function update() {
    let lo = Number(minInput.value);
    let hi = Number(maxInput.value);
    if (lo > hi) {
      [lo, hi] = [hi, lo];
    }
    const span = maxPrice - minPrice || 1;
    const loPct = ((lo - minPrice) / span) * 100;
    const hiPct = ((hi - minPrice) / span) * 100;

    rangeEl.style.left = `${loPct}%`;
    rangeEl.style.right = `${100 - hiPct}%`;

    label.textContent = `${lo} – ${hi} kr`;
    saveStored(STORAGE_KEYS.filter, { min: Number(minInput.value), max: Number(maxInput.value) });
    renderMarkers(lo, hi);
  }

  minInput.addEventListener("input", update);
  maxInput.addEventListener("input", update);
  window.addEventListener("resize", update);

  document.querySelectorAll(".step-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = btn.dataset.target === "min" ? minInput : maxInput;
      const next = Number(input.value) + Number(btn.dataset.delta);
      input.value = Math.max(minPrice, Math.min(maxPrice, next));
      update();
    });
  });

  update();
}

// Bottom-sheet drag-to-collapse behavior for the panel (see style.css -
// one layout for every screen size, no mobile/desktop split).
function setupPanelDrag() {
  const panel = document.getElementById("panel");
  const handle = document.getElementById("panel-handle");
  const content = document.getElementById("panel-content");

  let dragging = false;
  let startY = 0;
  let startHeight = 0;
  let naturalHeight = 0;

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = e.clientY;
    naturalHeight = content.scrollHeight;
    startHeight = panel.classList.contains("collapsed") ? 0 : naturalHeight;
    content.style.transition = "none";
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const delta = startY - e.clientY; // finger moving up = positive = expand
    const next = Math.max(0, Math.min(naturalHeight, startHeight + delta));
    content.style.maxHeight = `${next}px`;
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    content.style.transition = "";

    const movedMuch = Math.abs(startY - (e.clientY ?? startY)) > 4;
    let expand;
    if (!movedMuch) {
      expand = panel.classList.contains("collapsed"); // tap = toggle
    } else {
      const current = parseFloat(content.style.maxHeight || `${startHeight}`);
      expand = current > naturalHeight / 2;
    }

    content.style.maxHeight = "";
    panel.classList.toggle("collapsed", !expand);
  }

  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

let userMarker = null;

// Crosshair/target glyph - the conventional "locate me" icon (Google Maps,
// etc.), drawn with currentColor so it inherits the control's text color
// (including the error-state red below) without a second icon asset.
const LOCATE_ICON = `
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/>
    <line x1="12" y1="2" x2="12" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <line x1="2" y1="12" x2="6" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <line x1="18" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>
`;

function locateMe(btn) {
  if (!navigator.geolocation) {
    btn.title = "Geolokasjon støttes ikke av nettleseren";
    return;
  }
  btn.classList.remove("locate-error");
  btn.classList.add("locating");
  btn.title = "Lokaliserer...";

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      btn.classList.remove("locating");
      btn.title = "Finn meg";
      if (userMarker) map.removeLayer(userMarker);
      userMarker = L.marker([latitude, longitude], {
        icon: L.divIcon({ className: "user-location-marker", iconSize: [16, 16] }),
      }).addTo(map);
      map.setView([latitude, longitude], 17);
    },
    (err) => {
      btn.classList.remove("locating");
      btn.classList.add("locate-error");
      btn.title = err.code === 1 ? "Tilgang avslått" : "Fant ikke posisjon";
      setTimeout(() => {
        btn.classList.remove("locate-error");
        btn.title = "Finn meg";
      }, 2500);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// A custom Leaflet control (top-left, empty since zoomControl is off and
// the layers switcher lives top-right) styled like the built-in map-layer
// toggle: a single icon button, no label.
const LocateControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const container = L.DomUtil.create("div", "leaflet-control locate-control");
    const link = L.DomUtil.create("a", "locate-control-btn", container);
    link.href = "#";
    link.title = "Finn meg";
    link.setAttribute("role", "button");
    link.setAttribute("aria-label", "Finn meg");
    link.innerHTML = LOCATE_ICON;

    // Matches how Leaflet's own controls behave: a click/scroll on the
    // button shouldn't also reach the map underneath it (which would
    // otherwise also collapse the panel via the map's own click handler).
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(link, "click", (e) => {
      L.DomEvent.preventDefault(e);
      locateMe(link);
    });

    return container;
  },
});

function setupLocate() {
  map.addControl(new LocateControl());
}

function setupAuthUI() {
  document.getElementById("google-signin-btn").addEventListener("click", () => {
    Community.signInWithGoogle();
  });
  document.getElementById("sign-out-btn").addEventListener("click", () => {
    Community.signOut();
  });
}

function updateAuthUI() {
  const signInBtn = document.getElementById("google-signin-btn");
  const chip = document.getElementById("user-chip");
  const nameEl = document.getElementById("user-name");

  if (Community.isSignedIn()) {
    const profile = Community.getProfile();
    signInBtn.hidden = true;
    chip.hidden = false;
    nameEl.textContent = (profile && (profile.display_name || profile.email)) || Community.getSession().user.email;
  } else {
    signInBtn.hidden = false;
    chip.hidden = true;
  }
}

function updateAdminVisibility() {
  document.getElementById("admin-panel").hidden = !Community.isAdmin();
}

function adminRowHtml(row) {
  const barLabel = row.community_bar_name || `Pilsguiden-bar #${row.scraped_bar_id}`;
  const removed = Boolean(row.removed_at);
  const createdLabel = new Date(row.created_at).toLocaleString("no-NO");
  const actionsHtml = removed
    ? `<button type="button" class="text-btn admin-restore-btn" data-report-id="${row.id}">Gjenopprett</button>`
    : `
        <button type="button" class="text-btn admin-remove-btn" data-report-id="${row.id}">Fjern</button>
        <button type="button" class="text-btn admin-remove-user-btn" data-user-id="${row.user_id}">Fjern alle fra denne brukeren</button>
      `;

  return `
    <div class="admin-row${removed ? " admin-row--removed" : ""}">
      <div class="admin-row-main">
        <strong>${escapeHtml(barLabel)}</strong>
        – ${row.raw_price} kr / ${escapeHtml(row.size_label)}
        (${Math.round(row.price_per_half_liter)} kr/0,5L)
      </div>
      <div class="admin-row-meta">${escapeHtml(row.user_email)} · ${createdLabel}</div>
      ${removed ? `<div class="admin-row-meta">Fjernet${row.removed_reason ? `: ${escapeHtml(row.removed_reason)}` : ""}</div>` : ""}
      <div class="admin-row-actions">${actionsHtml}</div>
    </div>
  `;
}

async function renderAdminFeed() {
  const feedEl = document.getElementById("admin-feed");
  feedEl.textContent = "Laster...";
  try {
    const rows = await Community.fetchAdminFeed();
    feedEl.innerHTML = rows.map(adminRowHtml).join("") || "<p>Ingen innmeldinger ennå.</p>";
  } catch (err) {
    feedEl.textContent = err.message || "Klarte ikke å laste innmeldinger.";
  }
}

function setupAdminPanel() {
  const details = document.getElementById("admin-panel");
  const feedEl = document.getElementById("admin-feed");

  details.addEventListener("toggle", () => {
    if (details.open) renderAdminFeed();
  });

  feedEl.addEventListener("click", async (ev) => {
    const removeBtn = ev.target.closest(".admin-remove-btn");
    const removeUserBtn = ev.target.closest(".admin-remove-user-btn");
    const restoreBtn = ev.target.closest(".admin-restore-btn");

    if (removeBtn) {
      const reason = window.prompt("Begrunnelse (valgfritt):") || "";
      await Community.adminRemoveReport(removeBtn.dataset.reportId, reason);
      renderAdminFeed();
    } else if (removeUserBtn) {
      if (!window.confirm("Fjerner ALLE innmeldinger fra denne brukeren. Er du sikker?")) return;
      const reason = window.prompt("Begrunnelse (valgfritt):") || "";
      await Community.adminRemoveUserReports(removeUserBtn.dataset.userId, reason);
      renderAdminFeed();
    } else if (restoreBtn) {
      await Community.adminRestoreReport(restoreBtn.dataset.reportId);
      renderAdminFeed();
    }
  });
}

// "Legg til utested": a draggable pin the user positions via their
// location, a geocoded address, or just dragging it by hand, paired with a
// form for the bar's name and its first price. Submits atomically through
// Community.addBarWithPrice (one bar + one price report, see
// supabase/schema.sql) so a bar never exists without a price.
let addBarMarker = null;

function setupAddBarFlow() {
  const btn = document.getElementById("add-bar-btn");
  const form = document.getElementById("add-bar-form");
  const nameInput = document.getElementById("add-bar-name");
  const addressInput = document.getElementById("add-bar-address");
  const geocodeBtn = document.getElementById("add-bar-geocode-btn");
  const useLocationBtn = document.getElementById("add-bar-use-location-btn");
  const breweryInput = document.getElementById("add-bar-brewery");
  const breweryList = document.getElementById("add-bar-brewery-list");
  const sizeSelect = document.getElementById("add-bar-size");
  const priceInput = document.getElementById("add-bar-price");
  const cancelBtn = document.getElementById("add-bar-cancel-btn");
  const statusEl = document.getElementById("add-bar-status");

  sizeSelect.innerHTML = Community.SIZE_OPTIONS.map(
    (opt) => `<option value="${opt.value}">${opt.label}</option>`
  ).join("");

  // Suggests breweries already known from the scraped catalogue (bars.json's
  // "brewery" field) so a contributor can pick an existing one instead of
  // retyping/misspelling it; the input stays free-text for a brewery that
  // isn't in there yet.
  const knownBreweries = [...new Set(scrapedBars.map((b) => b.brewery).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "no")
  );
  breweryList.innerHTML = knownBreweries.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");

  function placeMarkerAt(latlng) {
    if (addBarMarker) {
      addBarMarker.setLatLng(latlng);
    } else {
      addBarMarker = L.marker(latlng, {
        draggable: true,
        icon: L.divIcon({ className: "add-bar-marker", iconSize: [22, 22], iconAnchor: [11, 11] }),
      }).addTo(map);
    }
    map.panTo(latlng);
  }

  function closeForm() {
    form.hidden = true;
    statusEl.textContent = "";
    form.reset();
    if (addBarMarker) {
      map.removeLayer(addBarMarker);
      addBarMarker = null;
    }
  }

  btn.addEventListener("click", () => {
    if (!Community.isSignedIn()) {
      Community.signInWithGoogle();
      return;
    }
    if (!form.hidden) {
      closeForm();
      return;
    }
    form.hidden = false;
    placeMarkerAt(map.getCenter());
  });

  geocodeBtn.addEventListener("click", async () => {
    const query = addressInput.value.trim();
    if (!query) return;
    statusEl.textContent = "Søker...";
    try {
      const pos = await Community.geocodeAddress(query);
      if (!pos) {
        statusEl.textContent = "Fant ikke adressen – dra nålen dit manuelt.";
        return;
      }
      placeMarkerAt([pos.lat, pos.lng]);
      statusEl.textContent = "";
    } catch (err) {
      statusEl.textContent = err.message || "Klarte ikke å søke opp adressen.";
    }
  });

  useLocationBtn.addEventListener("click", () => {
    if (!navigator.geolocation) return;
    statusEl.textContent = "Lokaliserer...";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        placeMarkerAt([pos.coords.latitude, pos.coords.longitude]);
        statusEl.textContent = "";
      },
      () => {
        statusEl.textContent = "Fant ikke posisjonen din.";
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  cancelBtn.addEventListener("click", closeForm);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = nameInput.value.trim();
    const rawPrice = Number(priceInput.value);

    if (!name || !addBarMarker || !rawPrice || rawPrice <= 0) {
      statusEl.textContent = "Fyll ut navn og pris, og plasser nålen i kartet.";
      return;
    }

    statusEl.textContent = "Lagrer...";
    try {
      const { lat, lng } = addBarMarker.getLatLng();
      await Community.addBarWithPrice({
        name,
        address: addressInput.value.trim(),
        brewery: breweryInput.value.trim(),
        lat,
        lng,
        sizeLabel: sizeSelect.value,
        rawPrice,
      });
      closeForm();
    } catch (err) {
      statusEl.textContent = err.message || "Noe gikk galt.";
    }
  });
}

// Bars sharing an exact address (e.g. three food stalls all registered to
// the same street number, like Torggata 18) geocode to the exact same
// point and would otherwise stack into one pin, hiding the rest. Nudge
// each one a few meters apart around the shared point, evenly spaced in
// a circle, so every one of them stays visible and clickable.
function spreadOverlappingBars(barList) {
  const OFFSET_METERS = 4;
  const METERS_PER_DEGREE_LAT = 111320;

  const groups = new Map();
  for (const bar of barList) {
    const key = `${bar.lat},${bar.lng}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bar);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos((group[0].lat * Math.PI) / 180);
    group.forEach((bar, i) => {
      const angle = (2 * Math.PI * i) / group.length;
      bar.lat += (OFFSET_METERS * Math.sin(angle)) / METERS_PER_DEGREE_LAT;
      bar.lng += (OFFSET_METERS * Math.cos(angle)) / metersPerDegreeLng;
    });
  }
}

async function init() {
  const res = await fetch("data/bars.json");
  const catalogue = await res.json();
  scrapedBars = catalogue.bars;

  await Community.initCommunity();
  rebuildBars();

  const prices = bars.map((b) => b.pricePerHalfLiter);
  minPrice = Math.min(...prices);
  maxPrice = Math.max(...prices);

  setupSlider();
  setupLocate();
  setupPanelDrag();
  setupNearbyToggle();
  setupAuthUI();
  setupAddBarFlow();
  setupAdminPanel();
  updateAuthUI();
  updateAdminVisibility();

  // Re-render whenever a submission/moderation changes the community data
  // (own and other users' - everyone's refreshCommunityData is the same
  // read), and refresh the auth-dependent UI whenever sign-in state changes.
  Community.onCommunityDataChanged(() => {
    rebuildBars();
    renderMarkers(currentFilter.min, currentFilter.max);
  });
  Community.onAuthChanged(() => {
    updateAuthUI();
    updateAdminVisibility();
  });
}

init();
