# Indian Markets Terminal

A **standalone web application** — plain source code you can copy anywhere and run yourself. It is *not* a Muse artefact and needs no Muse account or connection to run. Terminal-inspired dark UI (amber on black, function codes + GO) for Indian markets. It does not use Bloomberg's name, logo or trademarks anywhere.

## Requirements

- **Node.js 18 or newer** (uses only built-in modules — `http`, `fs`, `path` — plus the global `fetch`. No npm install, no build step, no dependencies.)

## Run it

```bash
cd indian-markets-terminal
node server.js
```

Then open **http://localhost:4173** in a browser.

- Port: set `PORT` to change it, e.g. `PORT=8080 node server.js`.
- Hosting: copy this whole folder to any machine/VPS with Node 18+, run the same command (use `nohup`, `pm2`, systemd, etc. if you want it always-on). The server binds `0.0.0.0`, so it is reachable on your network at `http://<that-machine-ip>:4173`.

## Folder structure

```
indian-markets-terminal/
├── server.js            # the whole server: static UI + JSON APIs + data fetching
├── public/
│   └── index.html       # the single-page terminal UI (vanilla HTML/CSS/JS, no CDN anything)
├── data/
│   ├── watchlist.json   # your EQ watchlist (created with defaults on first run)
│   └── instructions.json# TELL instructions + their statuses (created empty on first run)
└── README.md
```

## Using the terminal

Top command bar: type a function code and press GO (or click the nav buttons).

| Code | Module |
|---|---|
| `IDX` | Market overview: Nifty 50, Sensex, Bank Nifty, Fin Nifty, Nifty IT, Nifty Next 50, Midcap 100, India VIX, Nifty P/E, advance/decline breadth |
| `EQ`  | Equities watchlist — add/remove symbols, click a row to chart it |
| `GP`  | Chart for a symbol/index, ranges 1D / 5D / 1M / 6M / 1Y (e.g. command `GP RELIANCE`) |
| `FNO` | Nifty index futures + options chain snapshot (strikes, CE/PE OI, PCR) |
| `FX`  | USD/INR, EUR/INR, GBP/INR, JPY/INR + crosses, plus ECB daily reference rates |
| `NEWS`| Dated headlines from Economic Times and Livemint |
| `TELL`| "Tell Muse what to change" instruction panel (see below) |

Modules can be closed with the ✕ on each panel and reopened from the nav. Data auto-refreshes every ~60 seconds.

## Data sources (all fetched at runtime by the server)

- **Yahoo Finance** public chart endpoint — indices (Sensex), equities, charts, FX pairs. This is the no-auth endpoint; Yahoo's authenticated quote API is *not* used.
- **NSE India** `/api/allIndices` — index values, Nifty P/E, breadth.
- **NSE India** derivatives endpoints — F&O (best-effort, see limitations).
- **ECB** daily reference rates XML — dated reference FX rates.
- **RSS** — Economic Times markets feed, Livemint markets feed.

Every module names its source and shows an as-of timestamp. Figures are the **latest available** from those sources — **never labelled "live quotes"**. If a source fails, the module shows an honest "unavailable" state. No number is ever estimated or invented.

Server-side responses are cached for ~60 seconds so the sources are not hammered.

### JSON APIs

`GET /api/indices` · `GET /api/quotes?symbols=RELIANCE.NS,TCS.NS` · `GET /api/chart?symbol=NIFTY&range=1M` · `GET /api/fno` · `GET /api/fx` · `GET /api/news` · `GET /api/watchlist` · `POST /api/watchlist {symbol}` · `DELETE /api/watchlist?symbol=X` · `GET /api/instructions` · `POST /api/instructions {text}`

## TELL — how instructions work

1. In the TELL panel, type an instruction and press **Send**.
2. The server appends it to `data/instructions.json` and returns immediately. Entry format:

```json
{
  "id": "ins_1792450000000",
  "text": "Add a BANKNIFTY view",
  "sentAt": "20 Oct 2026, 11:52 IST-style local string",
  "sentAtISO": "2026-10-20T06:22:00.000Z",
  "status": "received",
  "steps": [{ "t": "…", "step": "Instruction saved on this page" }],
  "outcome": null
}
```

3. The page polls and displays every entry with its status, timestamps, steps and outcome **as recorded in that file**.
4. To get a change applied: tell Muse in chat "apply the terminal instructions". Muse reads `data/instructions.json`, makes the change to the app (code/data), and writes back `status: "done"` (or `"failed"`), the `steps` taken, the `outcome` line, and `finishedAt`. The app itself only stores and displays instructions — it never edits its own code.

Statuses used: `received` → `working` → `done` / `failed`.

## Known limitations

- **F&O reachability:** NSE's public derivatives endpoints (`option-chain-indices`, `quote-derivative`) are bot-protected and, from many networks (including the one this app was built/tested on), return an error page instead of JSON. The server tries them with a normal browser session warm-up on every refresh; when they don't respond, the FNO module shows an honest "unavailable from NSE right now" message. **OI/PCR are never fabricated.** From a network where NSE's API responds, the same code renders futures + the near-ATM chain with PCR automatically.
- **Market cap:** Yahoo's no-auth endpoints and NSE's public equity-quote endpoint do not expose market capitalisation from here, so the EQ table shows "—" for market cap instead of guessing.
- **Data freshness:** public sources are delayed/end-of-day snapshots depending on the feed and market hours; the as-of time on each module is the source of truth.
- **No authentication:** anyone who can reach the port can view data and add instructions/watchlist symbols. Put it behind your own reverse proxy/VPN if you host it publicly.
- The UI is a single HTML file with inline CSS/JS by design — easy to copy, no build tooling.
