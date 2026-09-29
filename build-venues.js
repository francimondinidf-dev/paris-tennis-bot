// Joins data/venue-catalogue.json (the real bookable venues, source of truth) with the
// door-to-door transit times in data/transit-measurements.json, and writes data/venues.json.
//
// Name matching is unreliable (the site renames venues to a "Broquedis - Asnières" style),
// so GPS distance from home is the backbone: every real venue has coordinates. Where a
// confident name match exists we keep the real measured transit time; for the rest we
// estimate minutes from distance using a line fitted on the matched pairs, so the whole
// list stays in one comparable unit.
import { readFileSync, writeFileSync } from 'fs'

const HOME = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8')).home

const norm = (s) =>
  (s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(tennis|tep|stade|gymnase|centre|sportif|courts?|couvert|ex|de|du|des|la|le|les|d|l|et)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(Boolean)

const tokenScore = (a, b) => {
  const A = new Set(a), B = new Set(b)
  if (!A.size || !B.size) return 0
  let shared = 0
  for (const t of A) if (B.has(t)) shared++
  return shared / Math.min(A.size, B.size)
}

const haversineKm = (aLat, aLon, bLat, bLon) => {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

const geo = JSON.parse(readFileSync(new URL('./data/venue-catalogue.json', import.meta.url), 'utf8'))
const ranked = JSON.parse(readFileSync(new URL('./data/transit-measurements.json', import.meta.url), 'utf8')).venues

// Collapse the 49 GeoJSON features to one record per venue NAME, because
// ajax_rechercher_creneau keys on _nomSrtm and duplicate features are seasonal variants.
// Court lists are unioned across variants so covered-court detection stays complete.
const byName = new Map()
for (const f of geo.features) {
  const g = f.properties?.general
  if (!g?._nomSrtm) continue
  const cur = byName.get(g._nomSrtm) || {
    name: g._nomSrtm,
    equipmentIds: [],
    address: g._adresse,
    cp: g._codePostal,
    arrondissement: g._arrondissement,
    lat: g._gpsLat,
    lon: g._gpsLon,
    courts: [],
  }
  if (!cur.equipmentIds.includes(g._id)) cur.equipmentIds.push(g._id)
  for (const c of f.properties.courts || []) {
    if (!cur.courts.some((x) => x.airId === c._airId)) {
      cur.courts.push({
        airId: c._airId,
        name: c._airNom,
        covered: c._airCvt === 'V',
        lit: c._airEcl === 'V',
        coating: c._coating?._revLib,
        coatingId: c._coating?._revId,
        openForReservation: c._airOuvRes === 'V',
      })
    }
  }
  byName.set(g._nomSrtm, cur)
}

// Puteaux and two others expose courts that are all flagged _airOuvRes != 'V' (not open for
// reservation), so they can never yield a booking.
const venues = [...byName.values()].filter((v) => v.courts.some((c) => c.openForReservation))
for (const v of venues) {
  v.distanceKm = Math.round(haversineKm(HOME.lat, HOME.lon, v.lat, v.lon) * 100) / 100
  v.hasCovered = v.courts.some((c) => c.covered && c.openForReservation)
  v.bookableCourts = v.courts.filter((c) => c.openForReservation).length
}

// Best-effort name match to recover measured transit times.
for (const v of venues) {
  const vt = norm(v.name)
  let best = null, bestScore = 0
  for (const r of ranked) {
    if (!r.transit_minutes) continue
    const s = tokenScore(vt, norm(r.name))
    if (s > bestScore) { bestScore = s; best = r }
  }
  if (best && bestScore >= 0.6) {
    v.transitMinutes = best.transit_minutes
    v.transitSource = 'measured'
    v.matchedRankedName = best.name
    v.matchScore = Math.round(bestScore * 100) / 100
  }
}

// Fit minutes = a + b*km on the matched pairs, then fill the gaps.
const fit = venues.filter((v) => v.transitSource === 'measured' && v.distanceKm > 0)
const n = fit.length
const sx = fit.reduce((s, v) => s + v.distanceKm, 0)
const sy = fit.reduce((s, v) => s + v.transitMinutes, 0)
const sxy = fit.reduce((s, v) => s + v.distanceKm * v.transitMinutes, 0)
const sxx = fit.reduce((s, v) => s + v.distanceKm ** 2, 0)
const b = (n * sxy - sx * sy) / (n * sxx - sx * sx)
const a = (sy - b * sx) / n
for (const v of venues) {
  if (v.transitSource !== 'measured') {
    v.transitMinutes = Math.max(1, Math.round(a + b * v.distanceKm))
    v.transitSource = 'estimated'
  }
}

venues.sort((x, y) => x.transitMinutes - y.transitMinutes || x.distanceKm - y.distanceKm)

writeFileSync(new URL('./data/venues.json', import.meta.url), JSON.stringify({
  generatedAt: new Date().toISOString(),
  home: HOME,
  transitModel: { intercept: Math.round(a * 100) / 100, minutesPerKm: Math.round(b * 100) / 100, fittedOn: n },
  venues,
}, null, 2))

console.log(`venues: ${venues.length}  (measured ${fit.length}, estimated ${venues.length - fit.length})`)
console.log(`transit model: ${a.toFixed(1)} + ${b.toFixed(1)}/km  (R fitted on ${n} pairs)`)
console.log(`covered-court venues: ${venues.filter((v) => v.hasCovered).length}`)
console.log('\nclosest 18:')
for (const v of venues.slice(0, 18)) {
  console.log(`  ${String(v.transitMinutes).padStart(3)}min ${v.transitSource === 'measured' ? '[m]' : '[e]'} ` +
    `${v.hasCovered ? 'COUV' : '    '} ${v.distanceKm.toFixed(2)}km  ${v.name}  (${v.bookableCourts} courts, arr ${v.arrondissement})`)
}
