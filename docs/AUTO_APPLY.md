# Auto-apply: what it does, what it doesn't, and how to use it safely

## TL;DR

`npm run apply -- --url <application-page-url>` opens a visible browser,
reads the form, asks your local LLM what to put in each field (grounded in
your `cv.md` and `config/profile.yml`), fills the fields, and **stops**. You
review and click submit yourself.

That's it. It is not a submission bot.

## The safety model, in plain English

1. **The submit button is never clicked by the script.** Not in any config,
   not with any flag. The code that would click submit simply doesn't exist
   in `scripts/apply.mjs`. If you want that behavior, you have to write it.

2. **Browser is visible by default.** `AUTO_APPLY_HEADLESS=false` in
   `.env.example`. Watch it fill fields in real time. If it does something
   wrong, you see it happen.

3. **Unknown answers stay blank.** The prompt in `scripts/apply.mjs` tells
   the LLM: if the answer isn't in the profile, leave it null and flag it.
   This is the single most important line of defense against hallucination.
   The script prints a ⚠ for every flagged field in the review summary.

4. **Sensitive fields are extra-flagged.** Salary, work authorization, visa
   status, EEO questions — the LLM is told to treat these as needs-human
   unless the profile has an explicit, non-null answer.

## What you need to fill in before using apply

The apply script reads `config/profile.yml`. The fields that matter most:

- `email`, `phone`, `location`, `linkedin`, `github`
- `work_authorization.us.*` — **fill these honestly; they end up on real
  applications**
- `target_base_usd`, `minimum_base_usd` — if null, salary questions get
  flagged for manual entry
- `eeo.*` — leave null if you prefer to answer those yourself in the browser

## Workflow

```bash
# 1. Evaluate first — don't bother applying to stuff scoring below 4.0
npm run evaluate -- --url https://boards.greenhouse.io/acme/jobs/123

# 2. If the score is good, apply
npm run apply -- --url https://boards.greenhouse.io/acme/jobs/123

# 3. Watch the browser fill the form.
# 4. Read the review summary in the terminal — pay attention to ⚠ rows.
# 5. Fix anything wrong in the browser.
# 6. You click submit.
```

## Known limitations

- **File uploads (resume/CV PDFs).** The script never attaches files. Upload
  your PDF (from `npm run pdf`) manually. This is deliberate — fake resumes
  would be a disaster.
- **Multi-step wizards.** Greenhouse and Lever apps are usually single-page.
  Workday and iCIMS apps are multi-page wizards. The current script only
  handles whatever form is visible on the landing URL. For wizards, run it
  once per step.
- **CAPTCHA / bot detection.** If a site is rate-limiting or showing a
  CAPTCHA, the script won't bypass it — solve it in the visible browser.
- **Small local models fill worse than big ones.** An 8B model can get
  confused on long dropdowns. Bump to 14B+ if your hardware allows.

## Things you should not do

- Don't set `AUTO_APPLY_HEADLESS=true` on real applications. Watch the
  browser. It takes 30 seconds per application to review; that 30 seconds
  is what makes this defensible.
- Don't loop `apply` over a directory of URLs. If you want scale, the
  evaluator is the scalable part; applying should stay manual.
- Don't lie in the profile. If you say you're authorized to work when you
  aren't, that's now on a real application form with your name on it. The
  script is a secretary; it'll transcribe whatever you tell it.

## ToS status — be honest about this

Greenhouse, Lever, Ashby, Wellfound: no explicit prohibition on assistive
auto-fill; full automated submission is clearly against their ToS.

Workday, iCIMS, Taleo: broader prohibitions on automated interaction; use
with extra caution and assume per-employer rules may vary.

LinkedIn Easy Apply: LinkedIn actively detects and suspends accounts for
any automation. **Do not point this script at LinkedIn.**

If you're on an employment visa (F-1 OPT, H-1B, etc.), account suspensions
or being flagged as a spammer with employers is a disproportionately bad
outcome relative to the time savings. Take it slow.
