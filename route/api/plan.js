// Serverless function — runs on Vercel, holds your API key server-side.
// The browser never sees the key; it only calls /api/plan.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY. Set it in Vercel project settings." });
  }

  try {
    const { city, country, nights, people, group, pace, budget, hotel, rest, currency, dailyRate, flightEst } = req.body || {};

    const prompt = buildPrompt({ city, country, nights, people, group, pace, budget, hotel, rest, currency, dailyRate, flightEst });

    // Abort the upstream call before the serverless function's own limit is hit,
    // so a slow model returns a clean JSON error instead of a platform crash page.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);

    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1800,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") {
        return res.status(504).json({ error: "The planner took too long to respond. Try again, or reduce the number of nights." });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (!r.ok) {
      const detail = await r.text();
      return res.status(r.status).json({ error: "Anthropic API error", detail });
    }

    const data = await r.json();
    let txt = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();

    // Strip code fences anywhere, then isolate the JSON object by braces.
    txt = txt.replace(/```json/gi, "").replace(/```/g, "").trim();
    const first = txt.indexOf("{");
    const last = txt.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      txt = txt.slice(first, last + 1);
    }

    let plan;
    try {
      plan = JSON.parse(txt);
    } catch (e) {
      // Return a JSON error (not plain text) so the page can show something useful.
      return res.status(502).json({
        error: "The model's reply wasn't valid JSON. This is usually a truncated response — try again, and if it repeats, the plan may be too long for the token limit.",
        detail: String(e),
      });
    }

    return res.status(200).json(plan);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

function buildPrompt(p) {
  const cur = p.currency || "USD";
  return `You are an expert trip planner AND budget estimator. Build a ${p.nights}-night itinerary for ${p.city}${p.country ? ", " + p.country : ""}.

Travelers: ${p.people} (${p.group}). Pace: ${p.pace}. Budget tier: ${p.budget}. Hotel: ${p.hotel}. Rest days: ${p.rest}.
Currency: ${cur}. User's rough daily spend guess per person: ${p.dailyRate || "unspecified"}. Flights estimate (total, all travelers): ${p.flightEst || "unspecified"}.

ITINERARY RULES:
- Each day = ONE geographic cluster. Never bounce across the city in a day.
- Use REAL, well-known named places for this destination (specific museums, markets, restaurants, viewpoints, neighborhoods).
- Density by pace: packed=5-7 stops/day, moderate=3-4, slow=1-2.
- Order within a day: crowd-sensitive landmarks early; flexible/late-hours places as buffer; a viewpoint at golden hour; dinner walkable from the last stop.
- Rest days: "yes" => ~one per 4 days; "auto" => one only if nights>=4, placed late-middle (never day 1 or last); "no" => none. Rest day = light frame (neighborhood + 2-3 optional cafes + one backup), not a full schedule.
- Family with kids: fewer stops, more breaks even if pace says packed — note the adjustment.
- 5+ travelers: note everything needs reservations.

BUDGET RULES (estimate in ${cur}, be realistic for the destination and budget tier):
- lodging: per-night estimate x ${p.nights} nights. If hotel is "booked", still estimate a typical rate but label it as reference.
- food: per-person-per-day estimate x ${p.people} x ${p.nights}.
- activities: rough total for paid attractions across the trip.
- localTransport: metro/taxi/rental estimate for the whole trip.
- flights: use the user's estimate if given, else estimate for ${p.people} travelers.
- Give each as a single number (no ranges, no currency symbol in the number field).
- total = sum of all five.
- Add one budget_note: the single biggest cost risk or the line most likely to blow the budget.

HONESTY:
- honest_note: 1-2 sentences naming the plan's real weakness (overstuffed day, a stop not worth its time, a deceptively long transit leg, or a budget line that's optimistic).

Respond with ONLY valid JSON, no markdown fence, no preamble:
{"days":[{"title":"string","rest":boolean,"slots":[{"time":"HH:MM or —","place":"string","tip":"string"}]}],"hotels":[{"name":"string","tradeoff":"string"}],"budget":{"currency":"${cur}","lodging":0,"food":0,"activities":0,"localTransport":0,"flights":0,"total":0,"budget_note":"string"},"logistics":["string"],"honest_note":"string"}`;
}
