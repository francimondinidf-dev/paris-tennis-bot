import dayjs from 'dayjs'
import { RULES } from './site.js'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Nov-Mar covered, Apr-Oct outdoor.
export const courtTypeFor = (date, config) =>
  config.season.coveredMonths.includes(date.month() + 1) ? 'covered' : 'outdoor'

// Sunday courts close at 18h, so drop hours that can't start there.
const openHours = (date, hours) => {
  const [open, close] = date.day() === 0 ? RULES.openingHours.sunday : RULES.openingHours.weekday
  return hours.filter((h) => h >= open && h < close)
}

// Season decides the hours too, no forecast: covered season (Nov-Mar) is the cold one, so
// chase the warmest hours of the day; outdoor season (Apr-Oct) starts at 10h or the closest.
export const hoursFor = (date, config) => {
  const cold = courtTypeFor(date, config) === 'covered'
  return {
    regime: cold ? 'cold' : 'warm',
    hours: openHours(date, cold ? config.hours.coldOrder : config.hours.warmOrder),
  }
}

// Weekend days in the bookable window. snipe = only the day that opens today (D+14);
// nearest = every allowed day from tomorrow on, closest first.
export const targetDates = (config, { mode, today = dayjs() }) => {
  const allowed = (d) => config.days.includes(DAY_NAMES[d.day()])
  if (mode === 'snipe') {
    const d = today.add(RULES.horizonDays, 'day').startOf('day')
    return allowed(d) ? [d] : []
  }
  const out = []
  for (let i = 1; i <= RULES.horizonDays; i++) {
    const d = today.add(i, 'day').startOf('day')
    if (allowed(d)) out.push(d)
  }
  return out
}

export const buildPlan = async (config, opts) => {
  const dates = targetDates(config, opts)
  const days = []
  for (const date of dates) {
    const h = hoursFor(date, config)
    days.push({ date: date.format('YYYY-MM-DD'), weekday: DAY_NAMES[date.day()], courtType: courtTypeFor(date, config), ...h })
  }
  return { generatedAt: new Date().toISOString(), mode: opts.mode, days }
}
