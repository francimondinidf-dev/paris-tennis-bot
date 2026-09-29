// Books one 1-hour tennis court on tennis.paris.fr for the target Saturday.
//
// Why one hour and not two: the site enforces max 2x1h per week, one reservation per day,
// and only one active reservation at a time, with the next one required to be on a different
// day and only after the current one has been honoured. So two back-to-back hours on a single
// Saturday is not achievable, and a Sat+Sun pair cannot be booked in advance either.
//
// Flow:
//   1. login
//   2. ajax_disponibilite_map once -> which venues have ANY availability on the target date
//   3. for each viable venue in preference order, submit #search_form by venue NAME
//      (this bypasses the address autocomplete and lands on a results page that already
//      carries the slot buttons plus #formReservation and a fresh captchaRequestId)
//   4. pick the best slot by hour priority, honouring the covered-court requirement
//   5. submit #formReservation and walk the confirmation wizard
import { chromium } from 'playwright'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import 'dotenv/config'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { createEvent } from 'ics'
import { notify } from './lib/ntfy.js'
import { loadSolver, isCaptchaPresent, CaptchaUnsolvedError } from './lib/captcha.js'

dayjs.extend(customParseFormat)
dayjs.extend(utc)
dayjs.extend(timezone)

const ARTIFACTS = 'artifacts'
try { mkdirSync(ARTIFACTS, { recursive: true }) } catch {}

const CONFIG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'))
const DECISION = JSON.parse(readFileSync(new URL('./decision.json', import.meta.url), 'utf8'))
const VENUES = JSON.parse(readFileSync(new URL('./data/venues.json', import.meta.url), 'utf8'))
const CAPTCHA = loadSolver()

// courtId on a slot button is the court's airId. The results page does NOT always render the
// indoorOutdoor attribute (it came back null for every button on 2026-09-19), so the local
// venue data is the authoritative source for whether a court is covered.
const COURT_COVERED = new Map(
  VENUES.venues.flatMap((v) => v.courts.map((c) => [String(c.airId), c.covered])))

const arg = (name, def) => {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split('=').slice(1).join('=') : def
}
const DRY_RUN = process.argv.includes('--dry-run')
const HEADED = process.argv.includes('--headed')
const MAX_VENUES = parseInt(arg('max-venues', '12'), 10)
// Paris-time HH:mm:ss to hold at after logging in, e.g. --at=08:00:00. Logging in costs a few
// seconds, so paying that before the release means the first search lands the instant slots open.
const AT = arg('at', null)

const COATINGS = ['92', '94', '96', '1324', '2016', '2095']
const SEARCH_URL = 'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!'
const log = (msg) => console.log(`${dayjs().tz('Europe/Paris').format('HH:mm:ss')} ${msg}`)

// Blocks until the given Paris-time HH:mm:ss. Returns immediately if that moment has passed,
// so a late start never stalls the run.
const waitUntilParis = async (hhmmss) => {
  const target = dayjs.tz(`${dayjs().tz('Europe/Paris').format('YYYY-MM-DD')} ${hhmmss}`, 'Europe/Paris')
  const ms = target.valueOf() - Date.now()
  if (ms <= 0) { log(`--at=${hhmmss} already passed, going now`); return }
  log(`holding ${(ms / 1000).toFixed(1)}s until ${hhmmss} Paris`)
  await new Promise((r) => setTimeout(r, ms))
}

// Credentials come from the environment only, never from config.json, so a checked-in config
// can never carry an account.
const credentials = () => {
  const { ACCOUNT_EMAIL: email, ACCOUNT_PASSWORD: password } = process.env
  if (!email || !password) {
    throw new Error('ACCOUNT_EMAIL and ACCOUNT_PASSWORD must be set (see .env.example)')
  }
  return { email, password }
}

const login = async (page) => {
  const { email, password } = credentials()
  await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')
  await page.click('#button_suivi_inscription')
  await page.fill('#username', email)
  await page.fill('#password', password)
  await page.click('#form-login >> button')
  await page.waitForSelector('.main-informations', { timeout: 30000 })
}

// One request tells us which venues have any free court on the target date, so we only
// pay for a full page load on venues that can actually yield a booking.
const venuesWithAvailability = async (page, whenIso) => {
  const res = await page.evaluate(async ({ when, coatings, inout }) => {
    const body = new URLSearchParams()
    body.append('hourRange', '8-22')
    body.append('when', when)
    for (const c of coatings) body.append('selCoating', c)
    for (const i of inout) body.append('selInOut', i)
    const r = await fetch('jsp/site/Portal.jsp?page=recherche&action=ajax_disponibilite_map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: body.toString(),
      credentials: 'same-origin',
    })
    return r.ok ? r.text() : null
  }, { when: whenIso, coatings: COATINGS, inout: IN_OUT })

  if (!res) return null
  try {
    const geo = JSON.parse(res)
    return new Set((geo.features || [])
      .filter((f) => f.properties?.available)
      .map((f) => f.properties.general._nomSrtm))
  } catch {
    return null
  }
}

// Navigates to the results page for one venue by submitting the search form directly.
const openVenue = async (page, venueName, whenIso) => {
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#search_form', { timeout: 20000 })
  await page.evaluate(({ venue, when }) => {
    const sel = document.querySelector('#selWhereTennisName')
    if (sel) {
      sel.innerHTML = ''
      const o = document.createElement('option')
      o.value = venue
      o.text = venue
      o.selected = true
      sel.appendChild(o)
      sel.value = venue
    }
    const where = document.querySelector('#where')
    if (where) where.value = venue
    const iso = document.querySelector('#whenIso')
    if (iso) iso.value = when
    const hr = document.querySelector('#hourRange')
    if (hr) hr.value = '8-22'
    document.querySelector('#search_form').submit()
  }, { venue: venueName, when: whenIso })
  // #formReservation only exists on the results page, so its presence is the signal that the
  // POST landed. It must be awaited as 'attached', not 'visible': the form holds nothing but
  // hidden inputs, so waiting for visibility silently burns the whole timeout on every venue.
  await page.waitForSelector('#formReservation', { state: 'attached', timeout: 25000 }).catch(() => {})
}

// Reads every slot button on the current results page.
const readSlots = (page, whenIso) =>
  page.evaluate((when) => {
    const wanted = when.split('/').reverse().join('/') // DD/MM/YYYY -> YYYY/MM/DD
    return [...document.querySelectorAll('[dateDeb]')]
      .map((b) => {
        const dateDeb = b.getAttribute('dateDeb') || ''
        return {
          dateDeb,
          dateFin: b.getAttribute('dateFin'),
          equipmentId: b.getAttribute('equipmentId'),
          courtId: b.getAttribute('courtId'),
          typePrice: b.getAttribute('typePrice'),
          indoorOutdoor: b.getAttribute('indoorOutdoor'),
          price: b.getAttribute('price'),
          hour: parseInt((dateDeb.split(' ')[1] || '').slice(0, 2), 10),
          day: dateDeb.split(' ')[0],
          blocked: b.className.includes('buttonHasReservation'),
          bookable: b.className.includes('buttonAllOk'),
        }
      })
      .filter((s) => s.day === wanted && Number.isFinite(s.hour))
  }, whenIso)

// Court types the bot is allowed to book. This is a hard constraint, not a preference: the
// pre-paid carnet only holds outdoor hours, and a court type outside the carnet would put a real
// card payment in the middle of the booking wizard, which is not automated. Widen this only once
// a matching carnet exists.
const BOOKABLE = CONFIG.courtType?.length ? CONFIG.courtType : ['Découvert']

// true if this slot's court type is one we are allowed to book. Falls back to the page attribute
// when the court is absent from venues.json, and refuses the slot when neither source knows,
// so an unidentified court can never be booked by accident.
const courtTypeAllowed = (slot) => {
  const known = COURT_COVERED.get(String(slot.courtId))
  const covered = known !== undefined ? known
    : slot.indoorOutdoor ? slot.indoorOutdoor === 'Couvert'
    : null
  if (covered === null) return false
  return BOOKABLE.includes(covered ? 'Couvert' : 'Découvert')
}
// Same constraint in the search API's vocabulary: V = couvert, F = découvert. Passing only the
// bookable types keeps the triage call from flagging a venue whose sole free court is covered.
const IN_OUT = BOOKABLE.map((t) => (t === 'Couvert' ? 'V' : 'F'))

// Every slot at this venue worth attempting, best first. Returns a list rather than a single
// pick so a slot lost to another user mid-race can fall through to the next court or hour.
const rankSlots = (slots, hoursPriority, preferCovered) => {
  const eligible = slots.filter((s) => {
    if (!hoursPriority.includes(s.hour)) return false
    if (!courtTypeAllowed(s)) return false
    if (CONFIG.priceType?.length && !CONFIG.priceType.includes(s.typePrice)) return false
    return true
  })
  // Rain makes covered nicer, but only ranks it up if covered is bookable at all.
  const wantCovered = preferCovered && BOOKABLE.includes('Couvert')
  return eligible.sort((a, b) => {
    const ha = hoursPriority.indexOf(a.hour) - hoursPriority.indexOf(b.hour)
    if (ha !== 0) return ha
    if (!wantCovered) return 0
    return (a.indoorOutdoor === 'Couvert' ? 0 : 1) - (b.indoorOutdoor === 'Couvert' ? 0 : 1)
  })
}

// Submits #formReservation for the chosen slot and walks the confirmation wizard.
const bookSlot = async (page, slot, dryRun) => {
  await page.evaluate((s) => {
    document.querySelector('#equipmentId').value = s.equipmentId
    document.querySelector('#courtId').value = s.courtId
    document.querySelector('#dateDeb').value = s.dateDeb
    document.querySelector('#dateFin').value = s.dateFin
    document.querySelector('#annulation').value = 'false'
  }, slot)

  if (dryRun) {
    const staged = await page.evaluate(() => ({
      equipmentId: document.querySelector('#equipmentId').value,
      courtId: document.querySelector('#courtId').value,
      dateDeb: document.querySelector('#dateDeb').value,
      dateFin: document.querySelector('#dateFin').value,
      captchaRequestId: document.querySelector('#captchaRequestId')?.value,
    }))
    log(`  [dry-run] would POST formReservation: ${JSON.stringify(staged)}`)
    return { confirmed: false, dryRun: true }
  }

  await page.evaluate(() => document.querySelector('#formReservation').submit())
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${ARTIFACTS}/book_01_after_submit.png`, fullPage: true })

  // A CAPTCHA sits between the slot POST and the reservation wizard. Delegated to the configured
  // strategy (see lib/captcha.js); an unsolved one is a lost slot, not a crashed run, so the
  // caller can fall through to the next candidate.
  if (await isCaptchaPresent(page)) {
    try {
      await CAPTCHA.solve(page, { headed: HEADED, log: (m) => log(`  ${m}`) })
      await page.waitForTimeout(1500)
      log('  captcha cleared')
    } catch (e) {
      if (!(e instanceof CaptchaUnsolvedError)) throw e
      log(`  ${e.message}`)
      return { confirmed: false, captcha: true }
    }
  }

  // Players: solo booking leaves this empty, but fill it if configured.
  for (const [i, player] of (CONFIG.players || []).entries()) {
    if (i > 0) await page.click('.addPlayer').catch(() => {})
    await page.waitForSelector(`[name="player${i + 1}"]`, { timeout: 15000 })
    await page.fill(`[name="player${i + 1}"] >> nth=0`, player.lastName)
    await page.fill(`[name="player${i + 1}"] >> nth=1`, player.firstName)
  }

  // Payment step: pay with an already-purchased ticket rather than a card.
  const paymentMode = page.locator('#order_select_payment_form #paymentMode')
  if (await paymentMode.count()) {
    await paymentMode.evaluate((el) => { el.removeAttribute('readonly'); el.style.display = 'block' })
    await paymentMode.fill('existingTicket')
    const submit = page.locator('#order_select_payment_form #envoyer')
    await submit.evaluate((el) => el.classList.remove('hide')).catch(() => {})
    await submit.click()
    await page.waitForTimeout(3000)
  }

  await page.screenshot({ path: `${ARTIFACTS}/book_02_final.png`, fullPage: true })

  const confirmed = await page.locator('.confirmReservation').count()
  return { confirmed: confirmed > 0 }
}

const writeIcs = (r) => {
  const start = dayjs(r.slot.dateDeb, 'YYYY/MM/DD HH:mm:ss')
  const ics = createEvent({
    start: [start.year(), start.month() + 1, start.date(), start.hour(), 0],
    duration: { hours: 1 },
    title: `Tennis — ${r.venue.name}`,
    description: `Court ${r.slot.courtId} (${r.slot.indoorOutdoor}, ${r.slot.typePrice})\n`
      + `${r.venue.address}, ${r.venue.cp}\nTransit ~${r.venue.transitMinutes} min`,
    location: `${r.venue.address}, ${r.venue.cp} Paris`,
    status: 'CONFIRMED',
  })
  if (!ics.error) writeFileSync('reservation.ics', ics.value)
}

const main = async () => {
  // Fail before launching a browser or reading the decision. Cheap, deterministic, and lets CI
  // exercise this check on a runner without Playwright installed.
  credentials()

  const date = dayjs(DECISION.targetDate, 'YYYY-MM-DD')
  const whenIso = date.format('DD/MM/YYYY')
  const { preferCovered, hours: hoursPriority } = DECISION

  log(`target ${date.format('YYYY-MM-DD dddd')} | hours ${hoursPriority.join(', ')} | preferCovered=${preferCovered}`)
  log(`reason: ${DECISION.reason}`)
  log(`bookable court types: ${BOOKABLE.join(', ')}`)
  if (preferCovered && !BOOKABLE.includes('Couvert')) {
    log('NOTE: rain expected but covered courts are disabled (no covered carnet), so this will')
    log('book outdoors anyway. Cancel at least 24h ahead if the forecast holds — the hour is recredited.')
  }
  if (date.day() !== 6) log(`WARNING: target is a ${date.format('dddd')}, not a Saturday`)

  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 200 : 0, timeout: 90000 })
  const page = await (await browser.newContext({ locale: 'fr-FR', timezoneId: 'Europe/Paris' })).newPage()
  log(`captcha strategy: ${CAPTCHA.name}`)

  // Slots vanish within seconds of the 08:00 release, and every venue attempt reloads the
  // search page. Dropping images, map tiles, fonts and analytics cuts that load from ~25s to
  // a couple of seconds; none of it is needed to read slot attributes or submit the form.
  // moncompte.paris.fr is the Paris identity provider and must stay reachable, or login breaks.
  await page.route('**/*', (route) => {
    const req = route.request()
    if (['image', 'media', 'font'].includes(req.resourceType())) return route.abort()
    if (/matomo|esri|arcgisonline|tameteo|googletagmanager|google-analytics/i.test(req.url())) {
      return route.abort()
    }
    return route.continue()
  })
  page.setDefaultTimeout(60000)

  let result = null
  try {
    await login(page)
    log('logged in')

    await page.goto(SEARCH_URL)
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})

    if (AT) await waitUntilParis(AT)

    const available = await venuesWithAvailability(page, whenIso)
    if (available) log(`${available.size} venues report availability on ${whenIso}`)
    else log('availability map unavailable — falling back to trying every ranked venue')

    // Keep preference order from decision.json, but skip venues the map says are full.
    const candidates = DECISION.venues
      .filter((v) => !available || available.has(v.name))
      .slice(0, MAX_VENUES)
    log(`trying ${candidates.length} venue(s) in preference order`)

    let sawBlocked = false
    venues: for (const [i, venue] of candidates.entries()) {
      log(`[${i + 1}/${candidates.length}] ${venue.name} (~${venue.transitMinutes} min${venue.hasCovered ? ', has covered' : ''})`)
      await openVenue(page, venue.name, whenIso)

      const slots = await readSlots(page, whenIso)
      if (!slots.length) { log('  no slots on page'); continue }

      const ranked = rankSlots(slots, hoursPriority, preferCovered)
      if (!ranked.length) {
        const offered = [...new Set(slots.map((s) => s.hour))].sort((a, b) => a - b)
        const skipped = slots.filter((s) => !courtTypeAllowed(s)).length
        log(`  ${slots.length} slots but none match (offered hours: ${offered.join(', ')}`
          + `${skipped ? `; ${skipped} skipped as non-bookable court type` : ''})`)
        continue
      }
      log(`  ${ranked.length} candidate slot(s): `
        + ranked.slice(0, 4).map((s) => `${s.hour}h/court${s.courtId}/${s.indoorOutdoor}`).join(', '))

      for (const [j, slot] of ranked.entries()) {
        if (slot.blocked) {
          sawBlocked = true
          log(`  ${slot.hour}h court ${slot.courtId} is taken or blocked for this account`)
          continue
        }
        // A previous attempt at this venue navigated away from the results page, which also
        // invalidates the captchaRequestId, so the page has to be re-fetched before retrying.
        if (j > 0 && page.url().includes('reservation')) {
          await openVenue(page, venue.name, whenIso)
          if (!(await page.locator('#formReservation').count())) { log('  lost results page'); continue venues }
        }

        log(`  trying ${slot.hour}h court ${slot.courtId} (${slot.indoorOutdoor}, ${slot.typePrice}, ${slot.price}EUR)`)
        const outcome = await bookSlot(page, slot, DRY_RUN)
        if (outcome.confirmed || outcome.dryRun) { result = { venue, slot, date, ...outcome }; break venues }
        log('  lost it — falling through to the next candidate')
      }
    }

    if (!result && sawBlocked) {
      log('')
      log('BLOCKED: slots exist, but every booking button came back as "buttonHasReservation".')
      log('The site allows only one active reservation at a time, so this account cannot book')
      log('again until the current reservation has been played or cancelled.')
      await browser.close()
      process.exit(3)
    }

    if (!result) {
      log('no bookable slot found')
      await browser.close()
      process.exit(2)
    }

    log('')
    log(`${result.dryRun ? 'DRY RUN — would book' : result.confirmed ? 'BOOKED' : 'UNCONFIRMED'}: `
      + `${result.slot.hour}h @ ${result.venue.name} court ${result.slot.courtId} (${result.slot.indoorOutdoor})`)

    if (result.confirmed) {
      writeIcs(result)
      if (CONFIG.ntfy?.enable === true || process.env.NTFY_TOPIC) {
        await notify(
          Buffer.from(JSON.stringify({ venue: result.venue.name, ...result.slot }, null, 2)),
          'booking.json',
          `Tennis booked ${date.format('ddd DD/MM')} ${result.slot.hour}h — ${result.venue.name}`,
          { domain: CONFIG?.ntfy?.domain || process.env.NTFY_DOMAIN, topic: CONFIG?.ntfy?.topic || process.env.NTFY_TOPIC },
        ).catch((e) => log(`ntfy failed: ${e.message}`))
      }
    }
  } catch (e) {
    log(`ERROR: ${e.message}`)
    try {
      const shot = await page.screenshot({ path: `${ARTIFACTS}/failure.png`, fullPage: true })
      if (CONFIG.ntfy?.enable === true || process.env.NTFY_TOPIC) {
        await notify(shot, 'failure.png', `Tennis bot error: ${e.message.slice(0, 120)}`, {
          domain: CONFIG?.ntfy?.domain || process.env.NTFY_DOMAIN,
          topic: CONFIG?.ntfy?.topic || process.env.NTFY_TOPIC,
        })
      }
    } catch {}
    process.exitCode = 1
  } finally {
    await browser.close().catch(() => {})
  }
}

main()
