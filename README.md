# paris-tennis-bot

Books a municipal tennis court on [tennis.paris.fr](https://tennis.paris.fr) at the moment slots
are released, picking the court that is quickest to reach and switching to a covered one when the
forecast says rain.

Paris releases every court for a given day at **08:00, exactly six days ahead**. Popular slots are
gone within seconds. That deadline is the whole design constraint: by the time the release lands
there is no budget left for deciding *where* to play, so all of that work happens beforehand.

## How it works

The run is split into a slow planning phase and a fast execution phase.

```
07:55  precompute.js                      ← no deadline pressure
       ├─ Open-Meteo hourly forecast for the target date
       ├─ decide: covered court needed? which hours, in what order?
       ├─ rank venues by door-to-door transit time
       └─ write decision.json

07:59:50  book.js                         ← every second counts
       ├─ log in (paid for before the release, not during)
       ├─ one ajax_disponibilite_map call → which venues have anything free
       ├─ walk viable venues in preference order, read slot buttons
       └─ submit the first slot that matches, then the payment wizard
```

Two decisions carry most of the latency budget:

**Log in before the release, not after.** Authentication costs a few seconds. Doing it at 07:59:50
means the first search request fires the instant slots open.

**One triage call before any page loads.** `ajax_disponibilite_map` returns GeoJSON for every venue
with an `available` flag. Filtering on that first avoids a full page load for venues that cannot
yield a booking. Combined with blocking images, fonts, map tiles and analytics, a venue attempt
drops from roughly 25 seconds to about two.

## Venue ranking

`build-venues.js` produces the ranking input. It joins the site's venue catalogue against a set of
measured door-to-door transit times, which is harder than it sounds because the site renames venues
(`TEP Jean-Pierre Wimille` becomes `Broquedis - Asnières`), so names cannot be joined directly.

The approach: use GPS distance as the backbone, since every venue has coordinates. Where a
confident token-overlap name match exists, keep the real measured transit time. For the rest, fit
`minutes = a + b·km` by least squares on the matched pairs and use it to fill the gaps. Every venue
then carries a transit estimate in the same unit, tagged `measured` or `estimated` so the
provenance stays visible rather than being quietly averaged away.

Weather only overrides distance when it has to. Rain promotes venues with a covered court, because
an outdoor court is useless in the rain regardless of how close it is. Cold does not: a covered
court is not a heated one, so cold is handled by choosing a warmer hour instead.

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
| `api` | Delegates to a third-party solving service. This is the extension point the scheduled workflow uses. |

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

## Running it

```bash
npm install
npx playwright install chromium

cp config.json.sample config.json   # hour preferences, weather thresholds, court types
cp .env.example .env                # ACCOUNT_EMAIL / ACCOUNT_PASSWORD

node precompute.js                  # writes decision.json
node book.js --dry-run              # stages the booking POST without submitting
node book.js --headed               # real run, CAPTCHA solvable by hand
```

Credentials are read from the environment only, never from `config.json`, so a checked-in config
can never carry an account.

Useful flags: `--at=08:00:00` holds after login until a given Paris time, `--max-venues=N` caps
attempts, `--dry-run` stops before submitting.

Exit codes: `0` booked, `1` error, `2` no bookable slot, `3` account already holds a reservation.

### Shipped data

`data/venues.json` is generated for the example origin in `config.json.sample`, a central-Paris
reference point. The transit times in it are **not** meaningful for any other address. Set your own
`home` coordinates and run `npm run build:venues` to regenerate.

| File | Contents |
|---|---|
| `data/venue-catalogue.json` | Venue and court catalogue scraped from the site: coordinates, surfaces, covered flags. |
| `data/transit-measurements.json` | Measured door-to-door transit times used to fit the distance model. |
| `data/venues.json` | Generated join of the two. Consumed by `lib/ranker.js`. |

## Site constraints

These are the site's rules, not limitations of the code, and they bound what any booking tool can
do here:

- **Two 1-hour slots per week**, one reservation per day, and only one *active* reservation at a
  time. Back-to-back hours on one day are not obtainable, and a Saturday/Sunday pair cannot be held
  in advance. This is why only one booking workflow is scheduled: a second one would collide with
  the first booking and always return exit code 3. Use `workflow_dispatch` with `TARGET_DATE` for
  a different day.
- **Payment uses an existing carnet.** The bot spends pre-paid hours; it never enters card details.
  `courtType` is therefore a hard constraint, not a preference, since a court type outside the
  carnet would put a real card payment in the middle of the flow.
- **Court coverage comes from local data.** The results page frequently returns `indoorOutdoor` as
  null, so `data/venues.json` is authoritative. A court unknown to both sources is refused rather
  than guessed at.

## Notes

Written for personal use against my own account. It automates a form a logged-in user is entitled
to submit, at a volume far below manual browsing, and it does not attempt to bypass the site's
anti-bot controls. If you run it, that is your call to make against the site's terms.

`lib/ntfy.js` is adapted from [par-ici-tennis](https://github.com/bertrandda/par-ici-tennis) by
Bertrand d'Aure (MIT); the reverse-engineered booking flow, weather logic, and venue ranking here
are my own. See [LICENSE](LICENSE).

Built with AI coding assistance. The reverse-engineering of the site's request flow, the design
decisions described above, and the review of what shipped are mine.
