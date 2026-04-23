# Setup

## 1. Install Ollama

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows
# Download from https://ollama.com/download
```

Start the server (leave it running):

```bash
ollama serve
```

On macOS/Linux this blocks the terminal. Open another one, or use `ollama serve &`,
or (on macOS) install as a service with `brew services start ollama`.

## 2. Pull a model

Pick one. Bigger = better evaluations, more RAM:

```bash
ollama pull llama3.1:8b         # fast, ~5GB
ollama pull qwen2.5:14b         # recommended balance, ~9GB
ollama pull deepseek-r1:14b     # strongest reasoning, ~9GB
ollama pull qwen2.5:32b         # only if you have 32GB+ RAM / a good GPU
```

Verify:

```bash
ollama list
```

## 3. Install this project

```bash
git clone <wherever you put this fork>
cd career-ops-ollama
npm install
npx playwright install chromium
```

## 4. Configure

```bash
cp .env.example .env
cp config/profile.example.yml config/profile.yml
cp examples/cv.example.md cv.md
cp templates/portals.example.yml portals.yml
```

Now open each in your editor:

- `.env` — set `OLLAMA_MODEL` to whatever you pulled
- `config/profile.yml` — **fill in honestly**, especially `work_authorization`
- `cv.md` — replace the example with your real CV
- `portals.yml` — add the companies you want to scan (optional)

## 5. Smoke test

```bash
npm run doctor
```

You should see all green checkmarks. If anything fails, the error message
tells you what to fix.

Then try a real evaluation against the sample JD:

```bash
npm run evaluate -- --file ./jds/sample.txt
```

Give it 30-90 seconds (longer on CPU-only). You should see:

- A score in the terminal
- A new `reports/*.md` file
- A new row in `data/tracker.tsv`

View the tracker:

```bash
npm run tracker
```

## 6. Generate a PDF

```bash
npm run pdf -- --report reports/<whatever-just-got-created>.md
```

Output goes to `output/`.

## 7. When you're ready to apply

Read `docs/AUTO_APPLY.md` first. Then:

```bash
npm run apply -- --url https://boards.greenhouse.io/acme/jobs/123
```

A browser opens. Review, fix anything wrong, submit.

## Common problems

**"Cannot reach Ollama at http://localhost:11434"**
`ollama serve` isn't running. Start it.

**"Not pulled. Run: ollama pull ..."**
The model in your `.env` doesn't exist locally. Pull it, or change `OLLAMA_MODEL`
to match what you have.

**"Ollama request timed out"**
Big model on weak hardware. Either use a smaller model or raise
`OLLAMA_TIMEOUT_MS` in `.env` (e.g. to 300000 for 5 minutes).

**Evaluations are garbage / generic**
You're probably using an 8B model. Try `qwen2.5:14b` or `deepseek-r1:14b`.
Also: the more context in `cv.md` and `profile.yml`, the better the output.
Upstream's author calls it "onboarding a new recruiter" — same advice here.

**"fill failed" on many apply fields**
The site uses non-standard form elements (shadow DOM, custom components).
Playwright selectors can't reach them. You'll have to fill those manually.
