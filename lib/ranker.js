import { readFileSync } from 'fs'

const VENUES_PATH = new URL('../data/venues.json', import.meta.url)

// Orders the real bookable venues for the booking attempt. Closest-first by default;
// when rain is forecast, venues that actually have a covered court open for reservation
// come first, because an outdoor court is useless in the rain regardless of distance.
export const rankVenues = ({ preferCovered, maxVenues = 15 }) => {
  const { venues } = JSON.parse(readFileSync(VENUES_PATH, 'utf8'))

  const pool = preferCovered ? venues.filter((v) => v.hasCovered) : venues
  const sorted = [...pool].sort((a, b) => a.transitMinutes - b.transitMinutes || a.distanceKm - b.distanceKm)

  return sorted.slice(0, maxVenues).map((v) => ({
    name: v.name,
    equipmentIds: v.equipmentIds,
    address: v.address,
    cp: v.cp,
    arrondissement: v.arrondissement,
    transitMinutes: v.transitMinutes,
    transitSource: v.transitSource,
    distanceKm: v.distanceKm,
    hasCovered: v.hasCovered,
    coveredCourtIds: v.courts.filter((c) => c.covered && c.openForReservation).map((c) => c.airId),
  }))
}
