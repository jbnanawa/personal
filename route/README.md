# Manifest — standalone trip planner & budget ledger

A trip planner you own. Fill in six fields, get a clustered day-by-day itinerary with real places, a budget ledger, and an honest note on what's likely to go wrong. Runs as a static page plus one small serverless function that holds your API key.

Share it with anyone by sending the URL. Add it to a phone home screen (it's installable) and it opens like an app.

---

## What's in here

```
route/
├── public/
│   ├── index.html            the whole front-end (no build step)
│   └── manifest.webmanifest  makes it installable on phones
├── api/
│   └── plan.js               serverless function — holds your key, calls Anthropic
├── vercel.json               routing + function config
├── package.json
└── README.md
```

There is **no build step** and **no framework**. It's plain HTML/CSS/JS plus one function. That's deliberate — the least thing that can possibly work standalone.

---

## Why the function exists (read this)

Your Anthropic API key **cannot live in the webpage**. Anyone could view source, copy it, and run up your bill. So the app is split:

- `public/index.html` — runs in the browser, has no key, calls `/api/plan`
- `api/plan.js` — runs on the server, reads the key from an environment variable, talks to Anthropic

This split is the entire reason "standalone" needs a host like Vercel rather than just a file on your laptop.

---

## Deploy in ~15 minutes

You need: a free [GitHub](https://github.com) account, a free [Vercel](https://vercel.com) account, and an [Anthropic API key](https://console.anthropic.com) with a few dollars of credit.

> The API key bills through the Anthropic **Console**, separate from any Claude.ai subscription. A personal planner costs pennies per plan.

### 1. Put this folder on GitHub
- Create a new repository (e.g. `manifest`).
- Upload the contents of the `route/` folder (drag-and-drop works in GitHub's web UI: **Add file → Upload files**).

### 2. Import into Vercel
- In Vercel: **Add New → Project → Import** your repo.
- Framework preset: **Other** (it's static + functions; no preset needed).
- Don't deploy yet — set the key first (next step). If you already deployed, just redeploy after step 3.

### 3. Add your API key
- Vercel project → **Settings → Environment Variables**.
- Name: `ANTHROPIC_API_KEY` — Value: your key (starts with `sk-ant-`).
- Save, then **Deployments → ⋯ → Redeploy** so the key takes effect.

### 4. Open it
- Vercel gives you a URL like `manifest-xxxx.vercel.app`. That's your app.
- On a phone: open the URL, **Share → Add to Home Screen**. It installs.

---

## Running it locally (optional)

```bash
npm i -g vercel
cd route
vercel dev
```
`vercel dev` runs the function locally. It will prompt for `ANTHROPIC_API_KEY`, or read a `.env` file you create (never commit it — `.gitignore` already excludes it).

Opening `index.html` directly as a file will **not** work — the `/api/plan` call needs the function running.

---

## The honest limits

- **Places and prices come from the model's training, not a live source.** Hours, closures, current rates, and whether a place still exists are not verified. It's a strong first draft — confirm before you book.
- **The budget is an estimate.** Giving it your own daily-spend and flight numbers sharpens it a lot; leaving them blank makes it guess.
- **It only plans and budgets.** It does not read your email, touch your calendar, or track bookings — that half runs through Claude with your connectors, on demand.

## Closing the verification gap later

The one seam worth extending is live place data. Drop a Google Places call into `api/plan.js` after the model returns, look up each `place` name, and replace unverified stops with real coordinates, current hours, and a "permanently closed" check. That turns the draft into something bookable. It needs a Google Cloud key and a billing card (there's a large free monthly tier). Everything else can stay exactly as it is.

---

## Changing the look or rules

- **Design** lives entirely in the `<style>` block of `index.html`.
- **Planning and budget rules** live in the `buildPrompt()` function in `api/plan.js` — edit the prompt to change density, add categories, change the JSON shape (update the render in `index.html` to match).
- **Model** is set in `api/plan.js` (`model: "claude-sonnet-4-6"`).
