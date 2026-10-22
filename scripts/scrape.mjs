#!/usr/bin/env node
// Scrapes the Oslo beer-price list from pilsguiden.no and updates data/bars.json.
//
// Usage:
//   node scripts/scrape.mjs              # upsert: update/add bars, keep anything else already in the catalogue
//   node scripts/scrape.mjs --overwrite  # replace the catalogue entirely with the fresh scrape

import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const BARS_FILE = path.join(DATA_DIR, "bars.json");
const GEOCODE_CACHE_FILE = path.join(DATA_DIR, "geocode-cache.json");

const SOURCE_URL = "https://www.pilsguiden.no/liste/oslo/__data.json";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "pilsguiden-location-map/1.0 (local hobby project; contact via github issue)";
const GEOCODE_DELAY_MS = 1100; // Nominatim allows max ~1 req/sec

const OVERWRITE = process.argv.includes("--overwrite");

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The __data.json payload is SvelteKit's "devalue" format: a flat array of
// parts where every object/array value is itself an index into the same
// array (so shared primitives are only stored once). Resolve it generically.
function resolveDevalue(parts) {
  const memo = new Map();
  function resolve(i) {
    if (memo.has(i)) return memo.get(i);
    const v = parts[i];
    if (Array.isArray(v)) {
      const arr = [];
      memo.set(i, arr);
      for (const idx of v) arr.push(resolve(idx));
      return arr;
    }
    if (v !== null && typeof v === "object") {
      const obj = {};
      memo.set(i, obj);
      for (const [key, idx] of Object.entries(v)) obj[key] = resolve(idx);
      return obj;
    }
    memo.set(i, v);
    return v;
  }
  return resolve(0);
}

async function fetchBars() {
  const res = await fetch(SOURCE_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Failed to fetch ${SOURCE_URL}: ${res.status} ${res.statusText}`);
  const payload = await res.json();

  // Find the data node that actually holds the bar list (SvelteKit emits one
  // node per +layout/+page load function; the list page's own load is what
  // carries `list.bars`).
  for (const node of payload.nodes ?? []) {
    if (node?.type !== "data" || !Array.isArray(node.data)) continue;
    const root = resolveDevalue(node.data);
    if (root?.list?.bars) return root.list.bars;
  }
  throw new Error("Could not find bars list in pilsguiden.no response (page structure may have changed)");
}

async function queryNominatim(query) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "no");
  url.searchParams.set("q", query);

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    console.warn(`  geocode failed (${res.status}) for "${query}"`);
    return null;
  }
  const results = await res.json();
  if (!results.length) return null;
  const { lat, lon } = results[0];
  return { lat: Number(lat), lng: Number(lon) };
}

// Strips the house number from "Streetname 11b, 0552 Oslo" -> "Streetname, 0552 Oslo".
// OSM/Nominatim's address data is crowd-sourced and often has the street or
// square mapped but not every individual house number, so falling back to
// the street still gets a usefully close point instead of no pin at all.
function withoutHouseNumber(address) {
  const stripped = address.replace(/^(.*?)\s+\d+[a-zA-Z]?,/, "$1,");
  return stripped !== address ? stripped : null;
}

async function geocodeAddress(address, cache) {
  const key = address.trim().toLowerCase();
  if (cache[key]) return cache[key];

  let entry = await queryNominatim(address);
  let approximate = false;

  if (!entry) {
    const fallbackQuery = withoutHouseNumber(address);
    if (fallbackQuery) {
      await sleep(GEOCODE_DELAY_MS);
      entry = await queryNominatim(fallbackQuery);
      approximate = Boolean(entry);
    }
  }

  if (!entry) {
    console.warn(`  no geocode match for "${address}"`);
    cache[key] = null;
    return null;
  }

  const result = { ...entry, approximate };
  cache[key] = result;
  return result;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  console.log(`Fetching bar list from ${SOURCE_URL} ...`);
  const rawBars = await fetchBars();
  console.log(`Found ${rawBars.length} entries.`);

  const geocodeCache = await readJson(GEOCODE_CACHE_FILE, {});
  const existingCatalogue = await readJson(BARS_FILE, { bars: [] });
  const existingById = new Map((existingCatalogue.bars ?? []).map((b) => [b.id, b]));

  let geocodedNew = 0;
  let skipped = 0;
  const freshBars = [];

  for (let i = 0; i < rawBars.length; i++) {
    const bar = rawBars[i];
    const key = bar.address.trim().toLowerCase();
    const hadCached = Boolean(geocodeCache[key]); // null = previous miss, still needs a live request

    const coords = await geocodeAddress(bar.address, geocodeCache);
    if (!hadCached) {
      geocodedNew++;
      await sleep(GEOCODE_DELAY_MS);
      if (geocodedNew % 25 === 0) {
        await writeFile(GEOCODE_CACHE_FILE, JSON.stringify(geocodeCache, null, 2));
        console.log(`  ... ${i + 1}/${rawBars.length} processed, cache saved`);
      }
    }

    if (!coords) {
      skipped++;
      continue;
    }

    freshBars.push({
      id: bar.id,
      name: bar.name,
      address: bar.address,
      slug: bar.slug,
      brewery: bar.brewery || null,
      pricePerHalfLiter: bar.pint,
      actualPrice: bar.price,
      actualSize: bar.size,
      priceChecked: bar.price_checked,
      validTo: bar.valid_to,
      // false = this is a time-limited (e.g. happy-hour) price, not the
      // everyday one. Confirmed against the source: default_price is
      // always true for "Prisen er alltid gyldig" / "Prisen gjelder
      // utenom happy hour", and always false for "Gyldig frem til kl X".
      defaultPrice: bar.default_price,
      lat: coords.lat,
      lng: coords.lng,
      approxLocation: coords.approximate || false,
      url: `https://www.pilsguiden.no/bar/${bar.slug}`,
    });
  }

  await writeFile(GEOCODE_CACHE_FILE, JSON.stringify(geocodeCache, null, 2));

  let finalBars;
  if (OVERWRITE) {
    finalBars = freshBars;
  } else {
    const merged = new Map(existingById);
    for (const bar of freshBars) merged.set(bar.id, bar);
    finalBars = [...merged.values()];
  }

  finalBars.sort((a, b) => a.pricePerHalfLiter - b.pricePerHalfLiter);

  const catalogue = {
    scrapedAt: new Date().toISOString(),
    source: "https://www.pilsguiden.no/liste/oslo",
    count: finalBars.length,
    bars: finalBars,
  };

  await writeFile(BARS_FILE, JSON.stringify(catalogue, null, 2));

  console.log(`\nDone (${OVERWRITE ? "overwrite" : "upsert"} mode).`);
  console.log(`  Scraped entries:   ${rawBars.length}`);
  console.log(`  Newly geocoded:    ${geocodedNew}`);
  console.log(`  Skipped (no geo):  ${skipped}`);
  console.log(`  Catalogue size:    ${finalBars.length} -> ${path.relative(ROOT, BARS_FILE)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
