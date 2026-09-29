import dayjs from 'dayjs'

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast'

export const forecastForSlot = async ({ lat, lon, date, hours }) => {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: 'temperature_2m,precipitation_probability,precipitation',
    timezone: 'Europe/Paris',
    start_date: date.format('YYYY-MM-DD'),
    end_date: date.format('YYYY-MM-DD'),
  })
  const res = await fetch(`${OPEN_METEO}?${params}`)
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`)
  const data = await res.json()
  const out = {}
  for (const h of hours) {
    const iso = `${date.format('YYYY-MM-DD')}T${String(h).padStart(2, '0')}:00`
    const idx = data.hourly.time.indexOf(iso)
    if (idx === -1) continue
    out[h] = {
      tempC: data.hourly.temperature_2m[idx],
      rainMm: data.hourly.precipitation[idx],
      rainProbPct: data.hourly.precipitation_probability[idx],
    }
  }
  return out
}

export const decideWeatherProfile = ({ forecast, coldTempC, rainProbabilityPct, rainMmThreshold }) => {
  const perHour = {}
  let anyRainOrCold = false
  for (const [hour, f] of Object.entries(forecast)) {
    const rain = (f.rainProbPct ?? 0) >= rainProbabilityPct || (f.rainMm ?? 0) >= rainMmThreshold
    const cold = (f.tempC ?? 20) < coldTempC
    perHour[hour] = { ...f, rain, cold, needsCovered: rain || cold }
    if (rain || cold) anyRainOrCold = true
  }
  return { perHour, anyRainOrCold }
}
