import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'
import { forecastForSlot, decideWeatherProfile } from './lib/weather.js'
import { rankVenues } from './lib/ranker.js'

// The site opens a new day for reservation at 08:00 Paris, always exactly 6 days out, so the
// only date we can ever snipe is D+6. Running the job on a Sunday therefore targets Saturday.
const RELEASE_OFFSET_DAYS = 6

dayjs.extend(customParseFormat)

const CONFIG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'))

const targetDate = () => {
  if (process.env.TARGET_DATE) return dayjs(process.env.TARGET_DATE, 'YYYY-MM-DD')
  return dayjs().add(RELEASE_OFFSET_DAYS, 'day')
}

const main = async () => {
  const date = targetDate()
  const allCandidateHours = [...new Set([
    ...CONFIG.hourPreferences.warm,
    ...CONFIG.hourPreferences.coldCandidates,
  ])].sort((a, b) => a - b)

  console.log(`[precompute] target date: ${date.format('YYYY-MM-DD')} (${date.format('dddd')})`)
  console.log(`[precompute] checking weather for hours: ${allCandidateHours.join(', ')}`)

  const forecast = await forecastForSlot({
    lat: CONFIG.home.lat,
    lon: CONFIG.home.lon,
    date,
    hours: allCandidateHours,
  })
  const profile = decideWeatherProfile({
    forecast,
    coldTempC: CONFIG.weather.coldTempC,
    rainProbabilityPct: CONFIG.weather.rainProbabilityPct,
    rainMmThreshold: CONFIG.weather.rainMmThreshold,
  })

  // Preferred hours are 10h then 18h, but only while those hours are not themselves cold.
  // When they are, chase the warmest hours of the day instead.
  const warmPicks = CONFIG.hourPreferences.warm.filter((h) => profile.perHour[h] && !profile.perHour[h].cold)
  const regime = warmPicks.length ? 'warm' : 'cold'
  const orderedHours = regime === 'warm'
    ? warmPicks
    : CONFIG.hourPreferences.coldCandidates
        .filter((h) => profile.perHour[h])
        .sort((a, b) => profile.perHour[b].tempC - profile.perHour[a].tempC)

  // Rain is the only thing that forces a covered court. Cold is handled by hour choice,
  // since a covered court is not necessarily a warm one.
  const preferCovered = orderedHours.some((h) => profile.perHour[h]?.rain)

  const venues = rankVenues({ preferCovered, maxVenues: CONFIG.maxVenuesToTry ?? 15 })

  const decision = {
    generatedAt: dayjs().toISOString(),
    targetDate: date.format('YYYY-MM-DD'),
    preferCovered,
    regime,
    reason: [
      preferCovered ? 'rain forecast — covered courts first' : 'no rain — closest court first',
      regime === 'warm'
        ? `mild at ${warmPicks.join('h/')}h — preferring ${orderedHours[0]}h`
        : `cold at 10h/18h — chasing warmest hours (${orderedHours.slice(0, 3).join('h, ')}h)`,
    ].join('; '),
    hours: orderedHours,
    forecast: profile.perHour,
    venues,
  }

  writeFileSync(new URL('./decision.json', import.meta.url), JSON.stringify(decision, null, 2))

  console.log('\n=== DECISION ===')
  console.log(`prefer covered: ${preferCovered}`)
  console.log(`reason: ${decision.reason}`)
  console.log(`hours (in try order): ${orderedHours.join(', ')}`)
  console.log('forecast:')
  for (const [h, f] of Object.entries(profile.perHour)) {
    console.log(`  ${h}h: ${f.tempC}°C, rain ${f.rainProbPct}% / ${f.rainMm}mm ${f.needsCovered ? '[COVERED PREF]' : ''}`)
  }
  console.log(`\ntop venues to try (${venues.length}):`)
  for (const v of venues.slice(0, 10)) {
    console.log(`  ${String(v.transitMinutes).padStart(3)} min ${v.transitSource === 'measured' ? '[m]' : '[e]'} ` +
      `${v.hasCovered ? '[COUV]' : '      '} ${v.name}`)
  }
}

main().catch((e) => {
  console.error('[precompute] failed:', e)
  process.exit(1)
})
