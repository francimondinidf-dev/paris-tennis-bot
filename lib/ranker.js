import { readFileSync } from 'fs'
import { URLS, fetchHtml, parseCentre } from './site.js'

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'))

const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/^(tennis|tep|centre sportif)\s+/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

const haversineKm = (a, b) => {
  const r = (d) => (d * Math.PI) / 180
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(h))
}

// data/venue-catalogue.json is site data only (npm run venues). Distance and transit are
// computed here from config.home: a measured door-to-door time from
// data/transit-measurements.json when the venue name matches, else the linear transit model.
export const loadVenues = (config) => {
  const measured = new Map(read('transit-measurements.json').venues
    .filter((v) => v.transit_minutes != null).map((v) => [norm(v.name), v.transit_minutes]))
  const { intercept, minutesPerKm } = config.transitModel
  return read('venue-catalogue.json').venues.map((v) => {
    const distanceKm = Math.round(haversineKm(config.home, v) * 100) / 100
    const m = measured.get(norm(v.name))
    return {
      ...v,
      distanceKm,
      transitMinutes: m ?? Math.round(intercept + minutesPerKm * distanceKm),
      transitSource: m != null ? 'measured' : 'estimated',
    }
  })
}

// Venues worth scanning for a court type: within the transit cap, nearest first.
export const venuesFor = (courtType, config) => {
  const { maxTransitMinutes, maxVenuesToScan } = config.ranking
  return loadVenues(config)
    .filter((v) => (courtType === 'covered' ? v.hasCovered : v.hasOutdoor))
    .filter((v) => v.transitMinutes <= maxTransitMinutes)
    .sort((a, b) => a.transitMinutes - b.transitMinutes)
    .slice(0, maxVenuesToScan)
}

// One fetch per venue returns all 14 days, so a scan covers every target day at once.
// fetchPage lets book.js reuse the logged-in browser session; scan.js uses plain HTTP.
export const scanVenues = async (venues, { fetchPage = fetchHtml, concurrency = 4 } = {}) => {
  const out = new Map()
  const queue = [...venues]
  const worker = async () => {
    while (queue.length) {
      const v = queue.shift()
      try {
        out.set(v.id, parseCentre(await fetchPage(URLS.centre(v.id))))
      } catch (e) {
        console.log(`[scan] ${v.name}: ${e.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return out
}

// Score = transit minutes + a penalty per step away from the first-choice hour, so a 10h slot
// 30 min away beats an 11h slot 20 min away only if hourStepPenaltyMinutes > 10.
export const rankCandidates = (plan, venues, scans, config) => {
  const penalty = config.ranking.hourStepPenaltyMinutes
  const candidates = []
  for (const day of plan.days) {
    for (const v of venues) {
      const centre = scans.get(v.id)
      const d = centre?.days.find((x) => x.date === day.date)
      if (!d) continue
      for (const c of d.courts) {
        if ((day.courtType === 'covered') !== c.covered) continue
        for (const s of c.slots) {
          const rank = day.hours.indexOf(s.hour)
          if (rank < 0) continue
          candidates.push({
            date: day.date, weekday: day.weekday, courtType: day.courtType, regime: day.regime,
            hour: s.hour, time: s.time, slotId: s.slotId, priceEur: s.priceEur, cancellable: s.cancellable,
            venueId: v.id, venue: v.name, address: v.address, court: c.court, surface: c.surface,
            transitMinutes: v.transitMinutes,
            score: v.transitMinutes + rank * penalty,
          })
        }
      }
    }
  }
  // Earlier day first (in nearest mode that is the point), then score.
  return candidates.sort((a, b) => a.date.localeCompare(b.date) || a.score - b.score)
}
