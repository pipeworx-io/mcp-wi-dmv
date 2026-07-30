# @pipeworx/wi-dmv

Wisconsin DMV (WisDOT) customer service centers, with the services each individual counter
actually performs. Keyless.

## Why Wisconsin gets its own pack

This came out of splitting a single multiplexed `us-dmv` tool into one pack per state agency.
Wisconsin's grain is a **per-station capability matrix** — does this counter issue commercial
plates, give the written knowledge test in a language other than English, take cash — which has
nothing in common with California's ZIP-level registration snapshot or New York's record-level
file. A union schema across states leaves most arguments ignored on every call, so Wisconsin's
arguments are Wisconsin's.

## Tools

| Tool | What it returns |
|---|---|
| `wi_dmv_offices` | Address, county, per-day hours, coordinates, wheelchair access, accepted payment methods, and the 13 service capabilities each center publishes |

Filters: `city`, `county`, `zip` (prefix match), `name`, `service` (matches both the service
labels and the payment methods), `limit`.

## The distinctive field

`DRV_KNLG_TEST_VAR_LANG_FL` — surfaced as the service label **"knowledge test in multiple
languages"** — records, per counter, whether the written knowledge test is offered in languages
beyond English. No other state DMV layer publishes this. It is what makes "which Wisconsin DMV
gives the written test in Spanish" answerable at all: 79 of the 88 centers do.

## Auth

None. `dotmaps.wi.gov` is a public WisDOT ArcGIS host.

## Gotchas worth knowing

- **WisDOT's ArcGIS host is intermittently slow.** It overran a 12s budget on a production call
  and answered in ~1s on the retry; during this pack's smoke test one call took 15.3s (a stall
  plus a successful retry) while the identical call either side of it took 93ms. Queries run on
  the shared helper's 15s budget with one retry, and a genuine stall returns
  `{ error, hint }` telling the caller to retry rather than an empty office list that reads
  as "Wisconsin has no DMV offices".
- **The statewide count moves.** WisDOT opens and closes rural counters — the layer held 92
  centers in mid-2026 and 88 as of 2026-07-30. Nothing in this pack hardcodes the number;
  responses carry `statewide_office_count` from the live layer, and the not-found hint quotes
  the live figure.
- **`LAT`/`LON` are real attribute columns** on this layer, unusually for a state ArcGIS
  service, so no `outSR=4326` geometry round-trip is needed.
- **There are no per-station phone numbers.** WisDOT routes every center through one statewide
  number, so `phone` is null by design rather than by omission.
- **Hours list open days only.** `STN_HRS_*` carries the literal `CLOSED` for the rest; a day
  absent from `hours` is a closed day. Many rural counters open one or two days a week.
- **`services_excluded` is the interesting negative space.** WisDOT's `STN_EXLD_PRDT_DSPL` is
  free text naming transactions that specific center sends elsewhere (salvage titles,
  personalised plates, commercial over 10,000 lb) — it is returned verbatim, whitespace-collapsed.
- **`service` matches payment methods too**, so `service: "cash"` is a valid filter alongside
  `service: "commercial vehicle plates"`.

## Data source

- [WisDOT ArcGIS `agohub/DMV_SERVICE_CENTER/MapServer/0`](https://dotmaps.wi.gov/arcgis/rest/services/agohub/DMV_SERVICE_CENTER/MapServer/0)
  — verified live 2026-07-30

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "wi-dmv": {
      "url": "https://gateway.pipeworx.io/wi-dmv/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1392+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Wisconsin DMV data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
