# nakatha-ephemeris

The sky-position service behind Nakatha. [Swiss Ephemeris](https://www.astro.com/swisseph/) (`sweph`) behind a small, authenticated JSON API.

It does **pure sky maths** and nothing else: planet longitudes, the ascendant, sunrise and sunset, and "when does this change" searches. It knows nothing about astrology (no nakshatras, tithis, yogas, rules or texts) and nothing about users, payments or databases. Whatever *interprets* the sky lives in the application that calls it.

- Sidereal zodiac, **Lahiri** ayanamsa. The built-in **Moshier** ephemeris: no data files to ship.
- Times are **Julian days (UT)**. Longitudes are degrees, 0 ≤ x < 360.
- Node 24.2+, TypeScript run directly (no build step), one dependency (`sweph`).

## Run it

```bash
npm install
EPHEMERIS_ALLOW_ANON=1 npm start      # local development: no token needed, listens on 127.0.0.1:4010
npm test                              # 14 tests, including NASA new/full moon times and a security suite
npm run typecheck
```

| Variable | Meaning |
|---|---|
| `EPHEMERIS_TOKEN` | Shared secret. Callers send `Authorization: Bearer <token>`. **Required** unless `EPHEMERIS_ALLOW_ANON=1`; the server refuses to start without one |
| `EPHEMERIS_ALLOW_ANON` | `1` = no token (development only; ignored when `NODE_ENV=production`) |
| `PORT`, `HOST` | Default `4010`, and `127.0.0.1` (`0.0.0.0` when `NODE_ENV=production`) |
| `SOURCE_URL` | Public repository URL, served at `GET /source` |

## API

All `/v1/*` routes are `POST` with `Content-Type: application/json` and a bearer token. Errors are `{ "error": "message" }` with `400` (bad input), `401`, `404`, `405`, `413` (over 256 KB), `415`, `422` (valid input the service refuses to compute, e.g. a search that is too large), or `500`.

`GET /healthz` (no token) → `{ ok, service, ephemeris, ayanamsa, source }`. `GET /source` → redirect to `SOURCE_URL`.

### `POST /v1/positions`
```jsonc
{ "jds": [2451545.0], "bodies": ["sun", "moon"], "speed": false, "ayanamsa": false }
// → { "longitudes": [[256.52, 199.47]] }          // [jd][body]; + "speeds" / "ayanamsa" when asked
```
Bodies: `sun moon mars mercury jupiter venus saturn mean_node true_node`.

### `POST /v1/ascendant`
```jsonc
{ "jds": [2451545.0], "lat": 6.9271, "lon": 79.8612 }   // → { "ascendants": [69.20] }
```

### `POST /v1/rise-set`
Each event is the next one after the previous.
```jsonc
{ "items": [{ "jd": 2461043.77, "lat": 6.9271, "lon": 79.8612, "sequence": ["rise", "set", "rise"] }] }
// → { "results": [[jdRise, jdSet, jdNextRise]] }
```

### `POST /v1/changes`
When does `floor(wrap360(Σ coef × longitude) / divisor)` (or the ascendant) change?
```jsonc
{
  "from": 2461043.0, "to": 2461044.0, "dir": 1,            // dir: 1 forward, -1 backward; to = from → just the next change
  "quantities": [
    { "kind": "longitude", "terms": [{ "body": "moon", "coef": 1 }, { "body": "sun", "coef": -1 }], "divisor": 12 },   // tithi
    { "kind": "ascendant", "lat": 6.9271, "lon": 79.8612, "divisor": 30, "step": 0.04 }                              // lagna
  ]
}
// → { "results": [{ "start": 11, "changes": [{ "jd": 2461043.4, "value": 12 }, …] }] }
```
Returns the value at `from` and every change up to and including the first one at or beyond `to`. `step` (days, optional, default 1 h) can be coarser for slow quantities, such as 1 day for the Sun's sign. Changes are located to about one second.

### `POST /v1/ingresses`
Every moment a planet (or the ascendant) crosses a multiple of `size` degrees, handling retrograde turns.
```jsonc
{ "from": 2461041.5, "to": 2461406.5,
  "searches": [{ "subject": { "body": "saturn" }, "size": 30 },
               { "subject": { "ascendant": { "lat": 6.9, "lon": 79.8 } }, "size": 3.3333, "step": 0.000694 }] }
// → { "results": [[{ "jd": …, "index": 11 }, …], […]] }     // index = the division entered, 0 … 360/size − 1
```

## Limits and security

- **Authentication**: bearer token compared in constant time. No token → no calculation. The service should also not be reachable from the internet (Render **Private Service**, or a firewall).
- **Bounded work**: sweph blocks the event loop, so each request has a cost cap. At most 5,000 instants, 20,000 positions, 8 quantities, 16 searches, 400 changes and 400 days per request, and a budget of 120,000 sky evaluations. Anything larger is refused with `422` before it can hog the process. Julian days must fall between the years 1000 and 3000.
- **Input is validated strictly** (types, ranges, body names). Bodies over 256 KB, wrong content types and bad JSON are rejected. Errors never include stack traces. Request logs contain method, path, status and duration only, never payloads.
- **Stateless**: no database, no files written. Run as many instances as you need behind any load balancer.

## Licence and source

AGPL-3.0-or-later (see `LICENSE`), because Swiss Ephemeris is AGPL. If you run a modified version as a network service you must offer its users the source: keep this repository public, set `SOURCE_URL`, and `GET /source` will send people to it. The Nakatha application that calls this service is a separate program that talks to it only over HTTP.

## Deploy (Render)

Private Service, same region as the app. Build `npm ci`, start `npm start`, Node 24+, `NODE_ENV=production`, `EPHEMERIS_TOKEN` (a long random secret), `SOURCE_URL`. Then give the web service `EPHEMERIS_URL=http://<internal-host>:<port>` and the same token. `GET /healthz` is the health check path.
