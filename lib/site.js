import dayjs from 'dayjs'

// Paris Tennis Padel (tennispadel.paris.fr), live since 4 Nov 2026. Replaces tennis.paris.fr.
// Everything below was observed on the live site on 2026-11-05; see README "Site contract".
export const BASE = 'https://tennispadel.paris.fr/tennispadel/'

export const URLS = {
  home: `${BASE}jsp/site/Portal.jsp?page=paristennis&sport=1`, // sport=1 tennis, 2 padel
  centre: (id) => `${BASE}jsp/site/Portal.jsp?page=centre-sportif&id=${id}`,
  // Occupancy grid only (Libre / club names), no slot ids. Handy for a cheap horizon check.
  creneaux: (id, isoDate) => `${BASE}rest/paristennis/creneaux?idEquipement=${id}&date=${isoDate}`,
  // The real booking entry point. The site appends li-antibot-token and idCentre in page JS.
  reservationStep1: (slotId) => `${BASE}jsp/site/Portal.jsp?page=reservation-etape-1&id=${slotId}`,
  reservations: `${BASE}jsp/site/Portal.jsp?page=reservations`,
  infos: `${BASE}jsp/site/Portal.jsp?page=infos`,
  carnets: `${BASE}jsp/site/Portal.jsp?page=carnets`,
}

// Rules from the site's FAQ and règlement, read 2026-11-05.
export const RULES = {
  horizonDays: 14, // "ouverts à la réservation 14 jours à l'avance"; measured: D+14 open, D+15 empty
  releaseTime: '08:00', // UNVERIFIED on the new site. Was 08:00 on the old one. Run `node scan.js --horizon` around 08:00 to confirm.
  bookerHoursPerWeek: 2, // Mon-Sun, as réservataire
  oneActiveReservation: true, // can't book again until the current booking has been played
  maxBookerHoursPerDay: 1,
  cancelNoticeHours: 24, // later than that, the hour is billed and counts as absent if not played
  absencesBeforeBlock: 5, // 5 no-shows a year = account blocked 1 month
  partnerRequired: true, // can't enter the court alone; partner can be added until minutes before start
  openingHours: { weekday: [8, 22], sunday: [8, 18] },
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

export const fetchHtml = async (url, { tries = 5 } = {}) => {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9' } })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      return await res.text()
    } catch (e) {
      if (i >= tries) throw e
      await new Promise((r) => setTimeout(r, 2000 * i))
    }
  }
}

const decode = (s) => s
  .replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è').replace(/&agrave;/g, 'à').replace(/&ecirc;/g, 'ê')
  .replace(/&ccedil;/g, 'ç').replace(/&ocirc;/g, 'ô').replace(/&icirc;/g, 'î').replace(/&ucirc;/g, 'û')
  .replace(/&rsquo;/g, '’').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
const text = (s) => decode(s.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

// Home page carries every tennis venue as <li class="equipement-list-item" id data-lat data-lng data-status>.
export const parseVenueList = (html) =>
  [...html.matchAll(/<li class="equipement-list-item" id="(\d+)" data-lat="([^"]*)" data-lng="([^"]*)" data-status="([^"]*)"[^>]*>([^<]*)<\/li>/g)]
    .map(([, id, lat, lng, status, name]) => ({ id: Number(id), name: decode(name).trim(), lat: Number(lat), lon: Number(lng), status }))
    .filter((v, i, all) => all.findIndex((x) => x.id === v.id) === i) // desktop and mobile lists repeat venues

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

// "Vendredi 06 novembre" has no year: take the one that lands inside the booking window.
const resolveDate = (label, today = dayjs()) => {
  const m = label.toLowerCase().match(/(\d{1,2})\s+([a-zéû]+)/)
  if (!m) return null
  const month = MONTHS.indexOf(m[2])
  if (month < 0) return null
  for (const y of [today.year(), today.year() + 1]) {
    const d = dayjs(new Date(y, month, Number(m[1])))
    if (d.diff(today.startOf('day'), 'day') >= -1) return d.format('YYYY-MM-DD')
  }
  return null
}

// Centre page = every bookable slot for D+0..D+14, grouped <h3> day > <li> court > radio per hour.
// Only free slots are rendered as radios, so anything parsed here is bookable right now.
export const parseCentre = (html, today = dayjs()) => {
  const head = text(html.slice(html.indexOf('Centre sportif'), html.indexOf('courts dont') + 60))
  const counts = head.match(/(\d+) courts dont (\d+) couverts/)
  const addr = head.match(/Centre sportif (.+?) (\d{5}) ([A-Za-zéè' -]+?) \d+ courts/)

  const days = []
  const parts = html.split(/<h3 class="tc-center-list-court-date[^"]*">/).slice(1)
  for (const part of parts) {
    const date = resolveDate(text(part.slice(0, part.indexOf('</h3>'))), today)
    if (!date) continue
    const courts = []
    for (const c of part.split('data-js-center-slot-container').slice(1)) {
      const court = text((c.match(/<h4[^>]*>([\s\S]*?)<\/h4>/) || [, ''])[1])
      const info = text(c.slice(0, c.indexOf('role="radiogroup"')))
      const slots = [...c.matchAll(/name="creneauRadio"[^>]*value="(\d+)"[^>]*data-js-slot-annulable="(true|false)"[\s\S]*?radio-hour">(\d{2}):(\d{2})<\/p>\s*<p[^>]*radio-price[^>]*>([^<]*)</g)]
        .map(([, slotId, annulable, hh, mm, price]) => ({
          slotId: Number(slotId), hour: Number(hh), time: `${hh}:${mm}`,
          priceEur: Number((price.match(/[\d,.]+/) || ['NaN'])[0].replace(',', '.')),
          cancellable: annulable === 'true',
        }))
      courts.push({
        court,
        covered: /Court couvert|semi-couvert/i.test(info) && !/Court découvert/i.test(info),
        lit: /Eclairé/i.test(info),
        surface: (c.match(/badge-label">([^<]*)</) || [, ''])[1].trim(),
        slots,
      })
    }
    days.push({ date, courts })
  }

  return {
    address: addr ? `${addr[1].replace(/^.*?\s(?=\d)/, '')}` : null,
    cp: addr ? addr[2] : null,
    courtsTotal: counts ? Number(counts[1]) : null,
    coveredTotal: counts ? Number(counts[2]) : null,
    days,
  }
}
