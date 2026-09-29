// CAPTCHA handling, behind a single pluggable interface.
//
// tennis.paris.fr interposes a LiveIdentity image/audio CAPTCHA between the slot POST and the
// reservation wizard. No solver ships with this repo: the default strategy asks a human, which
// means an unattended cron run stops here and exits cleanly rather than pretending to succeed.
//
// Selecting a strategy: CAPTCHA_PROVIDER=manual (default) | none | api

export class CaptchaUnsolvedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CaptchaUnsolvedError'
  }
}

const FORM = '#formCaptcha'

// Waits for a human to clear the widget in a visible browser window. This is the only strategy
// that actually works today, and it requires --headed.
class ManualSolver {
  constructor({ timeoutMs = 600000 } = {}) {
    this.timeoutMs = timeoutMs
  }

  get name() {
    return 'manual'
  }

  async solve(page, { headed, log }) {
    if (!headed) {
      throw new CaptchaUnsolvedError('CAPTCHA requires a human; rerun with --headed')
    }
    log('CAPTCHA — solve it in the browser window, the run continues once it clears')
    await page.waitForSelector(FORM, { state: 'detached', timeout: this.timeoutMs })
    await page.waitForLoadState('domcontentloaded')
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
// consequences that belong to whoever deploys this, not to the library: tennis.paris.fr has not
// granted permission for automated CAPTCHA solving. The interface exists so that decision stays
// a one-file change instead of a rewrite of the booking flow.
//
// A conforming implementation needs to:
//   1. extract the challenge (image bytes or audio) from the FORM element
//   2. hand it to the provider and poll until a token comes back
//   3. write the token into the form input and submit
//   4. resolve once FORM detaches, or throw CaptchaUnsolvedError
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
      'CAPTCHA_PROVIDER=api is a placeholder — no provider client is implemented. See lib/captcha.js',
    )
  }
}

export const loadSolver = (env = process.env) => {
  switch ((env.CAPTCHA_PROVIDER || 'manual').toLowerCase()) {
    case 'none':
      return new NoopSolver()
    case 'api':
      return new ApiSolver({ provider: env.CAPTCHA_API_PROVIDER, apiKey: env.CAPTCHA_API_KEY })
    default:
      return new ManualSolver()
  }
}

export const isCaptchaPresent = async (page) => (await page.locator(FORM).count()) > 0
