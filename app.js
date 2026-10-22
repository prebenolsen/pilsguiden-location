const STALE_DAYS = 14;
const OSLO_CENTER = [59.9139, 10.7522];

const map = L.map("map", { zoomControl: true }).setView(OSLO_CENTER, 12);

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

function formatDate(isoDate) {
  return new Date(isoDate).toLocaleDateString("nb-NO", { year: "numeric", month: "short", day: "numeric" });
}

function popupHtml(bar) {
  const stale = isStale(bar);
  const staleHtml = stale
    ? `<div class="stale-warning">⚠ Pris sjekket for ${Math.floor(daysSince(bar.priceChecked))} dager siden – kan være utdatert</div>`
    : "";
  return `
    <div class="bar-popup">
      <h3>${escapeHtml(bar.name)}</h3>
      <div class="price">${bar.pricePerHalfLiter} kr / 0,5L</div>
      <div class="address">${escapeHtml(bar.address)}${bar.approxLocation ? " (omtrentlig plassering)" : ""}</div>
      <div class="meta">
        ${bar.brewery ? `Bryggeri: ${escapeHtml(bar.brewery)}<br>` : ""}
        Pris sjekket: ${formatDate(bar.priceChecked)}
      </div>
      ${staleHtml}
      <a href="${bar.url}" target="_blank" rel="noopener">Se på Pilsguiden →</a>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function renderMarkers(filterMin, filterMax) {
  markersLayer.clearLayers();

  const visibleBars = bars.filter(
    (bar) => bar.pricePerHalfLiter >= filterMin && bar.pricePerHalfLiter <= filterMax
  );

  // Rescale the color gradient to whatever's actually on screen, so the
  // priciest visible bar is always red and the cheapest always green.
  const visiblePrices = visibleBars.map((b) => b.pricePerHalfLiter);
  const colorLo = visiblePrices.length ? Math.min(...visiblePrices) : filterMin;
  const colorHi = visiblePrices.length ? Math.max(...visiblePrices) : filterMax;

  for (const bar of visibleBars) {
    const stale = isStale(bar);
    const marker = L.circleMarker([bar.lat, bar.lng], {
      radius: 8,
      fillColor: priceColor(bar.pricePerHalfLiter, colorLo, colorHi),
      fillOpacity: stale ? 0.45 : 0.9,
      color: stale ? "#333" : "#1a1a1a",
      weight: stale ? 2 : 1,
      dashArray: stale ? "3,2" : null,
    });
    marker.bindPopup(popupHtml(bar));
    marker.addTo(markersLayer);
  }

  document.getElementById("visible-count").textContent = `Viser ${visibleBars.length} av ${bars.length} utesteder`;
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
  minInput.value = minPrice;
  maxInput.value = Math.min(minPrice * 2, maxPrice);

  function update() {
    let lo = Number(minInput.value);
    let hi = Number(maxInput.value);
    if (lo > hi) {
      [lo, hi] = [hi, lo];
    }
    const span = maxPrice - minPrice || 1;
    const leftPct = ((lo - minPrice) / span) * 100;
    const rightPct = ((hi - minPrice) / span) * 100;
    rangeEl.style.left = `${leftPct}%`;
    rangeEl.style.right = `${100 - rightPct}%`;
    label.textContent = `${lo} – ${hi} kr`;
    renderMarkers(lo, hi);
  }

  minInput.addEventListener("input", update);
  maxInput.addEventListener("input", update);
  update();
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
}

init();
