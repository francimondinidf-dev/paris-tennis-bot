# paris-tennis-bot

Finds and books a weekend tennis hour on **Paris Tennis Padel**
([tennispadel.paris.fr](https://tennispadel.paris.fr)), the City of Paris platform that replaced
tennis.paris.fr on 4 November 2026.

**Status: dormant.** `config.enabled` is `false` in the sample config, so `book.js` exits without
doing anything. `scan.js` is read-only and needs no account.

## What it picks

| | Rule |
|---|---|
| Days | Saturday or Sunday |
| Court type | **Covered Nov–Mar, outdoor Apr–Oct** (`config.season`) |
| Hours, Apr–Oct | 10h, then 11h, 9h, 12h (`hours.warmOrder`) |
| Hours, Nov–Mar | warmest part of the day: 14h, 13h, 15h, 12h (`hours.coldOrder`) |
| Weather | not used: season alone decides court type and hours |
| Venue order | transit minutes + 15 min per step away from the first-choice hour; venues over 45 min skipped |

## Site rules (FAQ and règlement, read 2026-11-05)

- Slots open **14 days ahead** (measured: D+14 has slots, D+15 none). The release **time is not yet
  confirmed** on the new site; the old one released at 08:00. `npm run horizon` just before and after
  08:00 settles it.
- **One active booking at a time**: the next one can only be made once the current one is played.
- 2 h per week (Mon–Sun) as booker, plus 2 h as a partner; at most 1 h per day as booker.
- **No solo play**: a partner (name, first name, date of birth) must be on the booking before the
  hour starts. They can be added after booking, until a few minutes before.
- Cancel at least 24 h ahead or the hour is billed. 5 no-shows a year block the account for a month.
- ID is checked at reception for the booker and partners.

## How it works

```
scan.js / book.js
  plan       lib/plan.js     target days → court type and hours by season
  scan       lib/ranker.js   one GET per venue returns every free slot for D+1..D+14
  book       book.js         login (Mon Paris, email → Continuer → password)
                             preflight: no active booking, under 2 h this week
                             wait for release → check radio[value=slotId] → "Réserver ce créneau"
  CAPTCHA    lib/captcha.js  strategy interface, see below
  step 1     reservation-etape-1: hands over to a human (partner, carnet payment, confirm)
```

The steps after the CAPTCHA (partner, payment, confirmation) are not automated yet because they
have not been observed on the new site. `book.js` saves `logs/etape-1.html` on the first real run
so they can be mapped.

## Commands

```bash
npm install
npx playwright install chromium
cp config.json.sample config.json   # set home, transitModel, preferences
cp .env.example .env                # ACCOUNT_EMAIL / ACCOUNT_PASSWORD (Mon Paris)

npm run venues      # rebuild data/venue-catalogue.json from the live site
npm run scan        # nearest weekend day with a matching slot, next 14 days
npm run scan:snipe  # only the day that opens today (D+14), when it is a Sat/Sun
node scan.js --date=2026-11-21
npm run horizon     # furthest open day right now
npm run book:dry    # logs in, checks counters, picks a slot, stops before "Réserver"
```

## CAPTCHA

A LiveIdentity image/audio CAPTCHA sits between the slot POST and the reservation wizard, so the
last step of the booking flow needs a solver. That solver is the one extension point in an
otherwise fully autonomous pipeline: everything from login through slot selection, form submission
and payment runs unattended.

`lib/captcha.js` defines a small strategy interface with three implementations, selected by
`CAPTCHA_PROVIDER`:

| Value | Behaviour |
|---|---|
| `manual` (default) | Waits for a human to clear the widget in a visible browser. Requires `--headed`. Right for a first local run. |
| `none` | Fails fast; the slot is treated as a miss and the pipeline moves on. Right for CI. |
| `api` | Delegates to a third-party solving service. This is the extension point the booking workflow uses. |

`ApiSolver` in `lib/captcha.js` is intentionally left as a placeholder that throws a clear "no
provider client is implemented" message. Wiring a real one — 2Captcha, Anti-Captcha, CapMonster,
whatever — is a one-file change: extract the challenge from `#formCaptcha`, hand it to the provider,
write the token back, resolve. Everything else in the pipeline is already in place.

Two reasons the placeholder ships rather than a working client:
- **Legal.** tennis.paris.fr has not granted permission for automated CAPTCHA solving. That decision
  belongs to whoever deploys this, not to the library.
- **Cleanliness.** An unsolved CAPTCHA becomes a `CaptchaUnsolvedError` that the caller catches and
  degrades to a lost slot, so the booking loop never crashes on it regardless of which strategy is
  wired in.

### On the new site

The widget moved: on Paris Tennis Padel it runs when "Réserver ce créneau" is clicked on a centre
page. A passed invisible check goes straight to `reservation-etape-1`; otherwise
`#tc-centre-sportif-modal-captchaModal` opens with an icon/audio challenge. Each strategy now
resolves once the page reaches `reservation-etape-1`.

## Site contract (observed 2026-11-05)

- Venues: `Portal.jsp?page=paristennis&sport=1`, one `<li class="equipement-list-item" id data-lat data-lng>` each.
- Slots: `Portal.jsp?page=centre-sportif&id=<venue>` lists every free slot for D+1..D+14, without
  login. `<h3>` day → court `<li data-js-center-slot-container>` (covered/outdoor, surface) →
  `input[name=creneauRadio][value=<slotId>]` with hour and price.
- Booking: `Portal.jsp?page=reservation-etape-1&id=<slotId>&li-antibot-token=…&idCentre=<venue>`.
- Occupancy grid: `rest/paristennis/creneaux?idEquipement=<venue>&date=YYYY-MM-DD` → `{html, date}`.
- Profile: `page=reservations` (active booking), `page=infos` (hours played, absences), `page=carnets`.

## Data

| File | Contents |
|---|---|
| `data/venue-catalogue.json` | Venues and courts scraped from the site: coordinates, address, surfaces, covered flags. No home-specific data. |
| `data/transit-measurements.json` | Measured door-to-door transit times, used when a venue name matches. Not meaningful for other addresses. |

Distance and transit are computed at run time from `config.home` and `config.transitModel`.
Credentials come from the environment only, never from `config.json`.
