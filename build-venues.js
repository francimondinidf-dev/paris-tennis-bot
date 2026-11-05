import { writeFileSync } from 'fs'
import { URLS, fetchHtml, parseVenueList, parseCentre } from './lib/site.js'

// Rebuilds data/venue-catalogue.json from the live Paris Tennis Padel site: every tennis venue
// and its courts (covered or not). Site data only, nothing about where you live: distance and
// transit are computed at run time in lib/ranker.js from config.home.

const main = async () => {
  const list = parseVenueList(await fetchHtml(URLS.home))
  console.log(`[venues] ${list.length} tennis venues on the home page`)

  const venues = []
  for (const v of list) {
    const centre = parseCentre(await fetchHtml(URLS.centre(v.id)))
    // Court type per court name, taken from whichever day lists that court.
    const courts = new Map()
    for (const d of centre.days) for (const c of d.courts) courts.set(c.court, { name: c.court, covered: c.covered, lit: c.lit, surface: c.surface })
    venues.push({
      id: v.id,
      name: v.name,
      address: centre.address,
      cp: centre.cp,
      lat: v.lat,
      lon: v.lon,
      courtsTotal: centre.courtsTotal,
      coveredTotal: centre.coveredTotal,
      hasCovered: (centre.coveredTotal ?? 0) > 0,
      hasOutdoor: (centre.courtsTotal ?? 0) > (centre.coveredTotal ?? 0),
      courts: [...courts.values()],
    })
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 300)) // be gentle: these pages are ~1 MB each
  }

  writeFileSync(new URL('./data/venue-catalogue.json', import.meta.url), JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'tennispadel.paris.fr',
    venues,
  }, null, 2))
  console.log(`\n[venues] wrote ${venues.length} venues (${venues.filter((v) => v.hasCovered).length} with covered courts)`)
}

main().catch((e) => { console.error('[venues] failed:', e); process.exit(1) })
