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
// Keep in sync with the breakpoint in style.css.
const MOBILE_BREAKPOINT_PX = 640;
const CAN_SHARE = typeof navigator.share === "function";

function isMobile() {
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
}

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

const map = L.map("map", { zoomControl: true }).setView(OSLO_CENTER, 12);

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

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const markersLayer = L.layerGroup().addTo(map);

let bars = [];
let minPrice = 0;
let maxPrice = 0;

function daysSince(isoDate) {
  const then = new Date(isoDate).getTime();
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

function isStale(bar) {
  return daysSince(bar.priceChecked) >= STALE_DAYS;
}

// Green (cheap) -> yellow (mid) -> red (expensive), interpolated in HSL hue space.
// lo/hi are the currently visible price range, so the scale always stretches
// across whatever the filter/slider is showing right now.
function priceColor(price, lo, hi) {
  if (hi === lo) return "hsl(140, 70%, 45%)";
  const frac = Math.max(0, Math.min(1, (price - lo) / (hi - lo)));
  const hue = 140 - frac * 140; // 140=green, 70=yellow-green, 0=red
  return `hsl(${hue}, 85%, 45%)`;
}

// Dot radius, doubled from the original plain-circle size as a first pass
// at making the price number inside legible.
const DOT_RADIUS_DESKTOP = 16;
const DOT_RADIUS_MOBILE = 22;

function priceDotIcon(bar, color, fade, stale) {
  const radius = isMobile() ? DOT_RADIUS_MOBILE : DOT_RADIUS_DESKTOP;
  const diameter = radius * 2;
  const fontSize = Math.round(diameter * 0.38);
  const borderColor = stale ? "#333" : "#1a1a1a";
  const borderStyle = stale ? "dashed" : "solid";
  const borderWidth = stale ? 2 : 1;
  const opacity = fade; // staleness is shown only via the border, never via opacity

  const html = `
    <div class="price-dot" style="
      width: ${diameter}px;
      height: ${diameter}px;
      font-size: ${fontSize}px;
      background: ${color};
      opacity: ${opacity};
      border-color: ${borderColor};
      border-style: ${borderStyle};
      border-width: ${borderWidth}px;
    ">${Math.round(bar.pricePerHalfLiter)}</div>
  `;

  return L.divIcon({
    html,
    className: "price-dot-anchor",
    iconSize: [diameter, diameter],
    iconAnchor: [diameter / 2, diameter / 2],
    popupAnchor: [0, -diameter / 2],
  });
}

function formatDate(isoDate) {
  return new Date(isoDate).toLocaleDateString("nb-NO", { year: "numeric", month: "short", day: "numeric" });
}

function popupHtml(bar) {
  const stale = isStale(bar);
  const staleHtml = stale
    ? `<div class="stale-warning">⚠ Pris sjekket for ${Math.floor(daysSince(bar.priceChecked))} dager siden – kan være utdatert</div>`
    : "";
  const isTimeLimited = bar.validTo && !/alltid gyldig/i.test(bar.validTo);
  const validToHtml = bar.validTo
    ? `<div class="valid-to${isTimeLimited ? " time-limited" : ""}">${isTimeLimited ? "🕒" : "✅"} ${escapeHtml(bar.validTo)}</div>`
    : "";
  return `
    <div class="bar-popup">
      <h3>${escapeHtml(bar.name)}</h3>
      <div class="price">${bar.pricePerHalfLiter} kr / 0,5L</div>
      <a class="address" href="${directionsUrl(bar)}" target="_blank" rel="noopener" title="Få veibeskrivelse">
        📍 ${escapeHtml(bar.address)}${bar.approxLocation ? " (omtrentlig plassering)" : ""}
      </a>
      ${validToHtml}
      <div class="meta">
        ${bar.brewery ? `Bryggeri: ${escapeHtml(bar.brewery)}<br>` : ""}
        Pris sjekket: ${formatDate(bar.priceChecked)}
      </div>
      ${staleHtml}
      <div class="popup-actions">
        <button type="button" class="share-btn" data-bar-id="${bar.id}">
          ${CAN_SHARE ? "📤 Del adresse" : "📋 Kopier adresse"}
        </button>
        <a href="${bar.url}" target="_blank" rel="noopener">Pilsguiden →</a>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// Wires the share/copy button each time a popup opens. Popups are cached
// on their marker by Leaflet (closing doesn't destroy the DOM), so guard
// against re-wiring the same button on every reopen.
map.on("popupopen", (e) => {
  const el = e.popup.getElement();
  const btn = el && el.querySelector(".share-btn");
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = "1";

  btn.addEventListener("click", async () => {
    const bar = bars.find((b) => b.id === Number(btn.dataset.barId));
    if (!bar) return;
    const shareText = `${bar.name} – ${bar.address}`;

    if (navigator.share) {
      try {
        await navigator.share({ title: bar.name, text: shareText, url: bar.url });
      } catch {
        // user cancelled the share sheet - nothing to do
      }
      return;
    }

    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(shareText);
        const original = btn.textContent;
        btn.textContent = "✅ Kopiert!";
        setTimeout(() => {
          btn.textContent = original;
        }, 1500);
      } catch {
        // clipboard blocked (permissions/insecure context) - nothing else we can do
      }
    }
  });
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

  const barsToDraw = showNearby ? [...inRangeBars, ...nearbyBars] : inRangeBars;
  for (const bar of barsToDraw) {
    const fade = fadeFactor(bar.pricePerHalfLiter, filterMin, filterMax);
    const stale = isStale(bar);
    const marker = L.marker([bar.lat, bar.lng], {
      icon: priceDotIcon(bar, priceColor(bar.pricePerHalfLiter, colorLo, colorHi), fade, stale),
    });
    marker.bindPopup(popupHtml(bar));
    marker.addTo(markersLayer);
  }

  document.getElementById("legend-min").textContent = `${colorLo} kr`;
  document.getElementById("legend-max").textContent = `${colorHi} kr`;

  const countEl = document.getElementById("visible-count");
  if (inRangeBars.length === 0) {
    countEl.textContent = `Ingen utesteder mellom ${filterMin} og ${filterMax} kr – prøv å utvide filteret.`;
    countEl.classList.add("empty-state");
  } else {
    countEl.classList.remove("empty-state");
    if (!nearbyBars.length) {
      countEl.textContent = `Viser ${inRangeBars.length} av ${bars.length} utesteder`;
    } else if (showNearby) {
      countEl.textContent = `Viser ${inRangeBars.length} av ${bars.length} utesteder (+${nearbyBars.length} i nærheten av filteret)`;
    } else {
      countEl.textContent = `Viser ${inRangeBars.length} av ${bars.length} utesteder (${nearbyBars.length} skjult i nærheten)`;
    }
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
  const maxValueEl = document.getElementById("max-value");

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

    if (isMobile()) {
      // Vertical track: 0% is the bottom (min), 100% is the top (max).
      rangeEl.style.left = "";
      rangeEl.style.right = "";
      rangeEl.style.bottom = `${loPct}%`;
      rangeEl.style.top = `${100 - hiPct}%`;
    } else {
      rangeEl.style.top = "";
      rangeEl.style.bottom = "";
      rangeEl.style.left = `${loPct}%`;
      rangeEl.style.right = `${100 - hiPct}%`;
    }

    label.textContent = `${lo} – ${hi} kr`;
    maxValueEl.textContent = `${maxInput.value} kr`;
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

// Bottom-sheet drag-to-collapse behavior for the mobile panel. Harmless
// on desktop since #panel-handle is display:none there, so the handle
// never receives pointer events.
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

function setupLocate() {
  const btn = document.getElementById("locate-btn");
  const status = document.getElementById("locate-status");

  btn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      status.textContent = "Geolokasjon støttes ikke av nettleseren";
      return;
    }
    status.textContent = "Lokaliserer...";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        status.textContent = "";
        if (userMarker) map.removeLayer(userMarker);
        userMarker = L.marker([latitude, longitude], {
          icon: L.divIcon({ className: "user-location-marker", iconSize: [16, 16] }),
        }).addTo(map);
        map.setView([latitude, longitude], 17);
      },
      (err) => {
        status.textContent = err.code === 1 ? "Tilgang avslått" : "Fant ikke posisjon";
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

async function init() {
  const res = await fetch("data/bars.json");
  const catalogue = await res.json();
  bars = catalogue.bars;

  const prices = bars.map((b) => b.pricePerHalfLiter);
  minPrice = Math.min(...prices);
  maxPrice = Math.max(...prices);

  setupSlider();
  setupLocate();
  setupPanelDrag();
  setupNearbyToggle();
}

init();
