import dayjs from 'dayjs'
import { readFileSync, writeFileSync } from 'fs'
import { buildPlan, courtTypeFor, hoursFor } from './lib/plan.js'
import { loadVenues, venuesFor, scanVenues, rankCandidates } from './lib/ranker.js'
import { URLS, RULES, fetchHtml } from './lib/site.js'

// Read-only. Plans the target days (season -> court type and hours), scans live
// availability over plain HTTP (no login needed) and prints the best slots. Books nothing.
//
//   node scan.js                    nearest weekend day with a match, next 14 days
//   node scan.js --mode=snipe       only the day that opens today (D+14), if it is a weekend
//   node scan.js --date=2026-11-21  one specific day
//   node scan.js --horizon          furthest day with any free slot (confirms release time)
//   node scan.js --plan-only        plan and write decision.json without touching the site (CI)

const CONFIG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'))
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]

const horizon = async () => {
  const v = loadVenues(CONFIG).sort((a, b) => a.transitMinutes - b.transitMinutes)[0]
  let last = null
  for (let i = 0; i <= RULES.horizonDays + 2; i++) {
    const d = dayjs().add(i, 'day').format('YYYY-MM-DD')
    const { html } = JSON.parse(await fetchHtml(URLS.creneaux(v.id, d)))
    const free = (html.match(/cell available/g) || []).length
    console.log(`D+${String(i).padStart(2)} ${d}  ${free} free cells at ${v.name}`)
    if (free) last = i
  }
  console.log(`\n${dayjs().format('HH:mm:ss')}  furthest open day: D+${last} (rule says D+${RULES.horizonDays})`)
}

const main = async () => {
  if (process.argv.includes('--horizon')) return horizon()

  const date = arg('date')
  const plan = date
    ? await (async () => {
        const d = dayjs(date)
        return { mode: 'date', days: [{ date, weekday: d.format('dddd'), courtType: courtTypeFor(d, CONFIG), ...hoursFor(d, CONFIG) }] }
      })()
    : await buildPlan(CONFIG, { mode: arg('mode') || 'nearest' })

  if (!plan.days.length) return console.log('No target day (snipe mode only fires when D+14 is a configured weekend day).')
  for (const d of plan.days) {
    console.log(`${d.date} ${d.weekday}: ${d.courtType}, ${d.regime} season, hours ${d.hours.join('h, ')}h`)
  }

  if (process.argv.includes('--plan-only')) {
    writeFileSync(new URL('./decision.json', import.meta.url), JSON.stringify(plan, null, 2))
    return
  }

  const types = [...new Set(plan.days.map((d) => d.courtType))]
  const venues = types.flatMap((t) => venuesFor(t, CONFIG))
  console.log(`\nScanning ${venues.length} venues...`)
  const scans = await scanVenues(venues)
  const candidates = rankCandidates(plan, venues, scans, CONFIG)

  writeFileSync(new URL('./decision.json', import.meta.url), JSON.stringify({ ...plan, candidates: candidates.slice(0, 30) }, null, 2))

  if (!candidates.length) return console.log('No matching slot.')
  console.log(`\n${candidates.length} matching slots. Best:`)
  for (const c of candidates.slice(0, 12)) {
    console.log(`  ${c.date} ${c.time}  ${String(c.transitMinutes).padStart(2)} min  ${c.venue} / ${c.court}  ${c.priceEur} €  (slot ${c.slotId}, score ${c.score})`)
  }
}

main().catch((e) => { console.error('[scan] failed:', e); process.exit(1) })
