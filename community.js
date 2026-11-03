// Community layer: Google login (via Supabase Auth) + user-submitted bars
// and price reports + admin moderation. Kept separate from app.js, which
// owns the map/markers/filter UI and just calls into the functions
// exported here.
//
// See supabase/schema.sql for the backing tables/RLS/RPCs, and
// supabase_readme.md for one-time project setup.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

export const SIZE_OPTIONS = [
  { value: "0.25", label: "0,25 L" },
  { value: "0.3", label: "0,3 L" },
  { value: "0.33", label: "0,33 L" },
  { value: "0.35", label: "0,35 L" },
  { value: "0.4", label: "0,4 L" },
  { value: "0.45", label: "0,45 L" },
  { value: "0.5", label: "0,5 L" },
  { value: "pint", label: "Pint (engelsk, 0,57 L)" },
  { value: "0.6", label: "0,6 L" },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let session = null;
let profile = null;
let communityBars = []; // raw rows from pilsguiden_location_bars
let currentPrices = []; // raw rows from pilsguiden_location_current_prices

const authListeners = [];
const dataListeners = [];

export function onAuthChanged(cb) {
  authListeners.push(cb);
}

export function onCommunityDataChanged(cb) {
  dataListeners.push(cb);
}

function notifyAuthChanged() {
  authListeners.forEach((cb) => cb());
}

function notifyDataChanged() {
  dataListeners.forEach((cb) => cb());
}

export function getSession() {
  return session;
}

export function getProfile() {
  return profile;
}

export function isSignedIn() {
  return Boolean(session);
}

export function isAdmin() {
  return Boolean(profile && profile.is_admin);
}

async function loadProfile() {
  if (!session) {
    profile = null;
    return;
  }
  const { data, error } = await supabase
    .from("pilsguiden_location_profiles")
    .select("id, email, display_name, is_admin")
    .eq("id", session.user.id)
    .maybeSingle();
  if (error) {
    console.error("Failed to load profile", error);
    profile = null;
    return;
  }
  profile = data;
}

export async function signInWithGoogle() {
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.href },
  });
}

export async function signOut() {
  await supabase.auth.signOut();
}

// Fetches the current state of the community bars + their active prices.
// Call after any write (submit/add/moderate) and once at startup.
export async function refreshCommunityData() {
  const [barsRes, pricesRes] = await Promise.all([
    supabase.from("pilsguiden_location_bars").select("id, name, address, brewery, lat, lng, created_by, created_at"),
    supabase.from("pilsguiden_location_current_prices").select("*"),
  ]);

  if (barsRes.error) console.error("Failed to load community bars", barsRes.error);
  if (pricesRes.error) console.error("Failed to load current prices", pricesRes.error);

  communityBars = barsRes.data || [];
  currentPrices = pricesRes.data || [];
  notifyDataChanged();
}

// Merges the static scraped catalogue with community data into one list
// the map can render. Always builds fresh bar objects (never mutates or
// reuses the objects from a previous call) so repeated merges - e.g. after
// every submission - don't compound in-place mutations like
// spreadOverlappingBars's marker-nudging in app.js.
export function mergeBars(scrapedBars) {
  const priceByScraped = new Map();
  const priceByCommunity = new Map();
  for (const price of currentPrices) {
    if (price.scraped_bar_id != null) priceByScraped.set(price.scraped_bar_id, price);
    if (price.community_bar_id != null) priceByCommunity.set(price.community_bar_id, price);
  }

  const scraped = scrapedBars.map((bar) => {
    const report = priceByScraped.get(bar.id);
    if (!report) return { ...bar, communitySourced: false, priceRef: { scrapedBarId: bar.id } };
    return {
      ...bar,
      pricePerHalfLiter: report.price_per_half_liter,
      priceChecked: report.created_at,
      communitySourced: true,
      priceRef: { scrapedBarId: bar.id },
    };
  });

  const community = communityBars
    .map((bar) => {
      const report = priceByCommunity.get(bar.id);
      // A community bar with no active report left (its only submission
      // got moderated away) simply isn't shown - there's no price to
      // display and nothing else establishes it as a real bar.
      if (!report) return null;
      return {
        id: `community-${bar.id}`,
        name: bar.name,
        address: bar.address,
        brewery: bar.brewery,
        lat: bar.lat,
        lng: bar.lng,
        pricePerHalfLiter: report.price_per_half_liter,
        priceChecked: report.created_at,
        communitySourced: true,
        priceRef: { communityBarId: bar.id },
      };
    })
    .filter(Boolean);

  return [...scraped, ...community];
}

export async function submitPriceReport({ scrapedBarId, communityBarId, sizeLabel, rawPrice }) {
  if (!isSignedIn()) throw new Error("Du må logge inn for å melde inn en pris.");
  const { data, error } = await supabase.rpc("pilsguiden_location_submit_price_report", {
    p_scraped_bar_id: scrapedBarId ?? null,
    p_community_bar_id: communityBarId ?? null,
    p_size_label: sizeLabel,
    p_raw_price: rawPrice,
  });
  if (error) throw error;
  await refreshCommunityData();
  return data;
}

export async function addBarWithPrice({ name, address, brewery, lat, lng, sizeLabel, rawPrice }) {
  if (!isSignedIn()) throw new Error("Du må logge inn for å legge til et utested.");
  const { data, error } = await supabase.rpc("pilsguiden_location_add_bar_with_price", {
    p_name: name,
    p_address: address || null,
    p_brewery: brewery || null,
    p_lat: lat,
    p_lng: lng,
    p_size_label: sizeLabel,
    p_raw_price: rawPrice,
  });
  if (error) throw error;
  await refreshCommunityData();
  return data;
}

// Geocodes a free-text address via Nominatim (same service scripts/scrape.mjs
// uses), for placing the pin when someone types an address instead of using
// their location. Best-effort: the pin stays draggable afterward so an
// imprecise match is never the final word.
export async function geocodeAddress(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Klarte ikke å slå opp adressen.");
  const results = await res.json();
  if (!results.length) return null;
  return { lat: Number(results[0].lat), lng: Number(results[0].lon) };
}

// --- Admin moderation -------------------------------------------------

export async function fetchAdminFeed() {
  const { data, error } = await supabase
    .from("pilsguiden_location_admin_report_feed")
    .select("*")
    .limit(200);
  if (error) throw error;
  return data;
}

export async function adminRemoveReport(reportId, reason) {
  const { error } = await supabase.rpc("pilsguiden_location_admin_remove_report", {
    p_report_id: reportId,
    p_reason: reason || null,
  });
  if (error) throw error;
  await refreshCommunityData();
}

export async function adminRemoveUserReports(targetUserId, reason) {
  const { data, error } = await supabase.rpc("pilsguiden_location_admin_remove_user_reports", {
    p_target_user_id: targetUserId,
    p_reason: reason || null,
  });
  if (error) throw error;
  await refreshCommunityData();
  return data; // number of reports removed
}

export async function adminRestoreReport(reportId) {
  const { error } = await supabase.rpc("pilsguiden_location_admin_restore_report", {
    p_report_id: reportId,
  });
  if (error) throw error;
  await refreshCommunityData();
}

// --- Startup ------------------------------------------------------------

export async function initCommunity() {
  const { data } = await supabase.auth.getSession();
  session = data.session;
  await loadProfile();

  supabase.auth.onAuthStateChange(async (_event, newSession) => {
    session = newSession;
    await loadProfile();
    notifyAuthChanged();
  });

  await refreshCommunityData();
}
