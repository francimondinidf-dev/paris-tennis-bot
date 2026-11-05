// CAPTCHA handling, behind a single pluggable interface.
//
// Paris Tennis Padel runs LiveIdentity's antibot (LI_ANTIBOT) when "Réserver ce créneau" is
// clicked on a centre page. If its invisible check passes, the page goes straight to
// reservation-etape-1. Otherwise #tc-centre-sportif-modal-captchaModal opens with an icon/audio
// challenge. No solver ships with this repo: the default strategy asks a human.
//
// Selecting a strategy: CAPTCHA_PROVIDER=manual (default) | none | api
// Every strategy resolves once the page is on reservation-etape-1, or throws CaptchaUnsolvedError.

export class CaptchaUnsolvedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CaptchaUnsolvedError'
  }
}

const MODAL = '#tc-centre-sportif-modal-captchaModal'
const STEP1 = /page=reservation-etape-1/

const reachedStep1 = async (page, timeout) => {
  try {
    await page.waitForURL(STEP1, { timeout })
    return true
  } catch {
    return false
  }
}

// Waits for a human to clear the challenge in the visible browser window, after a push
// notification. This is the only strategy that actually works today.
class ManualSolver {
  constructor({ timeoutMs = 600000 } = {}) {
    this.timeoutMs = timeoutMs
  }

  get name() {
    return 'manual'
  }

  async solve(page, { log, notify }) {
    log('CAPTCHA: solve it in the browser window, the run continues once it clears')
    await notify?.('Captcha: open the bot browser window and solve it now to finish the booking')
    if (!(await reachedStep1(page, this.timeoutMs))) throw new CaptchaUnsolvedError('CAPTCHA not solved in time')
  }
}

// Fails fast. Use for CI and dry runs, where a booking that needs a human is simply a miss.
class NoopSolver {
  get name() {
    return 'none'
  }

  async solve() {
    throw new CaptchaUnsolvedError('CAPTCHA encountered and no solver is configured')
  }
}

// Placeholder for a third-party solving service.
//
// Intentionally unimplemented. Wiring one up is a decision with legal and terms-of-service
// consequences that belong to whoever deploys this, not to the library: Paris Tennis Padel has
// not granted permission for automated CAPTCHA solving. The interface exists so that decision
// stays a one-file change instead of a rewrite of the booking flow.
class ApiSolver {
  constructor({ provider, apiKey } = {}) {
    this.provider = provider
    this.apiKey = apiKey
  }

  get name() {
    return `api:${this.provider ?? 'unconfigured'}`
  }

  async solve() {
    throw new CaptchaUnsolvedError(
      'CAPTCHA_PROVIDER=api is a placeholder, no provider client is implemented. See lib/captcha.js',
    )
  }
}

export const loadSolver = (env = process.env, { timeoutMs } = {}) => {
  switch ((env.CAPTCHA_PROVIDER || 'manual').toLowerCase()) {
    case 'none':
      return new NoopSolver()
    case 'api':
      return new ApiSolver({ provider: env.CAPTCHA_API_PROVIDER, apiKey: env.CAPTCHA_API_KEY })
    default:
      return new ManualSolver({ timeoutMs })
  }
}

// Call right after clicking "Réserver ce créneau". Returns without a solver when the invisible
// check let the page through on its own.
export const passCaptcha = async (page, solver, ctx) => {
  if (await reachedStep1(page, 8000)) {
    ctx.log('CAPTCHA: invisible check passed, no challenge shown')
    return
  }
  const shown = await page.locator(MODAL).isVisible().catch(() => false)
  ctx.log(`CAPTCHA: ${shown ? 'challenge shown' : 'still on the centre page'}, using solver "${solver.name}"`)
  await solver.solve(page, ctx)
}
