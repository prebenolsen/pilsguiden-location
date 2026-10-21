# Ølkartet Oslo

Map of Oslo bars/restaurants with the cheapest half-liter (0,5L) beer prices,
sourced from [Pilsguiden](https://www.pilsguiden.no/liste/oslo).

## Data

`data/bars.json` is the data catalogue consumed by the front end. Each entry has:

```json
{
  "id": 1689,
  "name": "Doug's Hamburgers Aker Brygge",
  "address": "Fjordalléen 4, 0250 Oslo",
  "pricePerHalfLiter": 55,
  "priceChecked": "2026-10-16T17:16:19.566749+02:00",
  "lat": 59.909,
  "lng": 10.728,
  "url": "https://www.pilsguiden.no/bar/dougs-hamburgers-aker-brygge"
}
```

`data/geocode-cache.json` caches address → coordinates lookups (via
OpenStreetMap Nominatim) so re-running the scraper doesn't re-geocode
addresses that haven't changed.

## Re-scraping

```
npm run scrape            # upsert: update/add bars, keep everything else already in the catalogue
npm run scrape:overwrite  # replace data/bars.json entirely with a fresh scrape
```

The scraper reads pilsguiden.no's own page-data endpoint
(`/liste/oslo/__data.json`) and geocodes any new/changed addresses through
Nominatim at its required rate limit (~1 request/second), so a full run with
no cache takes several minutes.

## Running the map locally

```
npm run serve
```

then open http://localhost:8080. (A local server is required — browsers
block `fetch()` of local JSON files opened directly as `file://`.)

## Front end

Plain HTML/CSS/JS using [Leaflet](https://leafletjs.com/) + OpenStreetMap
tiles, no build step:

- Markers are colored on a green → yellow → red scale from cheapest to most
  expensive visible price.
- A dual-handle slider filters bars between a min and max price.
- Bars whose price was last checked 14+ days ago are shown with a dashed
  outline and reduced opacity, and flagged in the popup.
- "Finn meg" requests browser geolocation and drops a blue marker at the
  user's position.
