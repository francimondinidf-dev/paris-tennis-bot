import 'dotenv/config'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import tz from 'dayjs/plugin/timezone.js'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { chromium } from 'playwright'
import { URLS, RULES } from './lib/site.js'
import { buildPlan } from './lib/plan.js'
import { venuesFor, scanVenues, rankCandidates } from './lib/ranker.js'
import { loadSolver, passCaptcha } from './lib/captcha.js'

// Booking run. DORMANT unless config.enabled is true.
//
//   node book.js --mode=snipe     wait for the 08:00 release and go for D+14 (Sat/Sun only)
//   node book.js --mode=nearest   go now for the nearest weekend day with a match
//   --dry-run                     log in, check counters, pick a slot, stop before clicking Réserver
//   --at=08:00:00                 release time override (Paris)
//
// Flow: login (Mon Paris) -> preflight (no active booking, weekly hours left) -> plan ->
// wait for release -> scan with the logged-in session -> select slot on the centre page ->
// CAPTCHA strategy (lib/captcha.js, CAPTCHA_PROVIDER=manual|none|api) -> reservation-etape-1, where it hands over to you: add the
// partner, pay with the carnet, confirm. Steps after the captcha are not automated yet: they
// have never been observed on the new site.

dayjs.extend(utc)
dayjs.extend(tz)
const PARIS = 'Europe/Paris'

const CONFIG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'))
const arg = (name, def) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def
const MODE = arg('mode', 'snipe')
const DRY_RUN = process.argv.includes('--dry-run')
const RELEASE_AT = arg('at', `${RULES.releaseTime}:00`)

const SOLVER = loadSolver(process.env, { timeoutMs: (CONFIG.captchaManualTimeoutSec ?? 600) * 1000 })
const log = (msg) => console.log(`${dayjs().tz(PARIS).format('HH:mm:ss.SSS')} ${msg}`)
mkdirSync(new URL('./logs/', import.meta.url), { recursive: true })

const notify = async (message) => {
  log(`notify: ${message}`)
  const topic = process.env.NTFY_TOPIC || CONFIG.ntfy?.topic
  if (!CONFIG.ntfy?.enable || !topic || topic.startsWith('REPLACE')) return
  await fetch(`https://${process.env.NTFY_DOMAIN || 'ntfy.sh'}/${topic}`, {
    method: 'POST', headers: { Title: 'Paris Tennis Padel', Tags: 'tennis', Priority: 'high' }, body: message,
  }).catch((e) => log(`ntfy failed: ${e.message}`))
}

const waitUntilParis = async (hhmmss) => {
  const target = dayjs.tz(`${dayjs().tz(PARIS).format('YYYY-MM-DD')} ${hhmmss}`, PARIS)
  const ms = target.diff(dayjs())
  if (ms <= 0) return
  log(`waiting ${Math.round(ms / 1000)}s for ${hhmmss}`)
  await new Promise((r) => setTimeout(r, ms))
}

// Mon Paris (Keycloak, v70-auth.paris.fr) asks for the email, then the password on a second
// screen. Selectors are generic on purpose: UNVERIFIED against the new two-step form.
const login = async (page) => {
  await page.goto(URLS.reservations, { waitUntil: 'domcontentloaded' })
  if (!/v70-auth\.paris\.fr/.test(page.url())) return log('login: session still valid')
  const email = process.env.ACCOUNT_EMAIL
  const password = process.env.ACCOUNT_PASSWORD
  await page.locator('input[type="email"], input[name="username"], #username').first().fill(email)
  const pwd = page.locator('input[type="password"]').first()
  if (!(await pwd.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /continuer/i }).click()
    await pwd.waitFor({ timeout: 15000 })
  }
  await pwd.fill(password)
  await Promise.all([
    page.waitForURL(/tennispadel\.paris\.fr/, { timeout: 30000 }),
    page.locator('button[type="submit"], input[type="submit"]').first().click(),
  ])
  log('login: ok')
}

// One active booking at a time, 2h/week as réservataire. Read both before trying anything.
const preflight = async (page) => {
  await page.goto(URLS.reservations, { waitUntil: 'domcontentloaded' })
  const res = (await page.locator('main').innerText()).replace(/\s+/g, ' ')
  if (/Ma réservation en cours/i.test(res) && /Annuler ma réservation/i.test(res)) {
    const current = res.match(/Ma réservation en cours (.+?) Modifier ma réservation/)?.[1] ?? 'see profile'
    return { ok: false, reason: `active booking already held: ${current}` }
  }
  await page.goto(URLS.infos, { waitUntil: 'domcontentloaded' })
  const infos = (await page.locator('main').innerText()).replace(/\s+/g, ' ')
  const played = Number(infos.match(/(\d+)h sur (\d+) heures maximum en tant que réservataire/)?.[1] ?? 0)
  if (played >= RULES.bookerHoursPerWeek) return { ok: false, reason: `weekly cap reached (${played}h played)` }
  return { ok: true, played }
}

const trySlot = async (page, c) => {
  await page.goto(URLS.centre(c.venueId), { waitUntil: 'domcontentloaded' })
  const radio = page.locator(`input[name="creneauRadio"][value="${c.slotId}"]`)
  if (!(await radio.count())) return false // taken since the scan
  await radio.check({ force: true })
  const button = page.locator('#btnReserverCreneau:not(.d-none)').first()
  if (DRY_RUN) {
    log(`dry run: would click Réserver for ${c.venue} ${c.court} ${c.date} ${c.time}`)
    return true
  }
  await button.click()
  await passCaptcha(page, SOLVER, { log, notify })
  return true
}

const main = async () => {
  if (!CONFIG.enabled && !DRY_RUN) {
    log('dormant: config.enabled is false. Nothing booked. (--dry-run still works.)')
    return
  }

  if (!process.env.ACCOUNT_EMAIL || !process.env.ACCOUNT_PASSWORD) {
    console.error('ACCOUNT_EMAIL and ACCOUNT_PASSWORD must be set (see .env.example)')
    process.exitCode = 1
    return
  }

  // Persistent profile keeps the Mon Paris session between runs, so most runs skip login.
  const context = await chromium.launchPersistentContext(new URL('./.browser-profile', import.meta.url).pathname, {
    headless: SOLVER.name !== 'manual' && !process.argv.includes('--headed'), // manual needs a visible window
    locale: 'fr-FR',
    timezoneId: PARIS,
  })
  const page = context.pages()[0] ?? await context.newPage()

  try {
    await login(page)
    const pre = await preflight(page)
    if (!pre.ok) {
      log(`stop: ${pre.reason}`)
      if (!DRY_RUN) await notify(`Tennis bot did not book: ${pre.reason}`)
      return
    }
    log(`preflight ok: ${pre.played}h played this week`)

    const plan = await buildPlan(CONFIG, { mode: MODE })
    if (!plan.days.length) return log(`no target day for mode ${MODE} today`)
    for (const d of plan.days) log(`plan ${d.date} ${d.weekday}: ${d.courtType}, ${d.regime}, hours ${d.hours.join('/')}`)
    const venues = [...new Set(plan.days.map((d) => d.courtType))].flatMap((t) => venuesFor(t, CONFIG))

    if (MODE === 'snipe' && !DRY_RUN) await waitUntilParis(RELEASE_AT)

    const fetchPage = async (url) => (await context.request.get(url)).text()
    const scans = await scanVenues(venues, { fetchPage, concurrency: 6 })
    const candidates = rankCandidates(plan, venues, scans, CONFIG)
    writeFileSync(new URL('./decision.json', import.meta.url), JSON.stringify({ ...plan, candidates: candidates.slice(0, 30) }, null, 2))
    log(`${candidates.length} matching slots`)

    for (const c of candidates.slice(0, 8)) {
      log(`trying ${c.date} ${c.time} ${c.venue} ${c.court} (${c.transitMinutes} min)`)
      if (!(await trySlot(page, c))) continue
      if (DRY_RUN) return
      writeFileSync(new URL('./logs/etape-1.html', import.meta.url), await page.content())
      await notify(`Slot held at step 1: ${c.weekday} ${c.date} ${c.time}, ${c.venue} ${c.court}. ` +
        'Finish in the bot window: add your partner, pay with the carnet, confirm.')
      log('handing over at reservation-etape-1; browser stays open')
      await page.waitForEvent('close', { timeout: 0 })
      return
    }
    await notify('Tennis bot: no matching slot could be selected')
  } catch (e) {
    log(`error: ${e.message}`)
    await page.screenshot({ path: new URL('./logs/failure.png', import.meta.url).pathname }).catch(() => {})
    await notify(`Tennis bot error: ${e.message.slice(0, 140)}`)
    process.exitCode = 1
  } finally {
    await context.close().catch(() => {})
  }
}

main()
