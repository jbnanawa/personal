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
    const { city, country, postal, nights, people, group, pace, hotel, rest } = req.body || {};

    const prompt = buildPrompt({ city, country, postal, nights, people, group, pace, hotel, rest });

    // Abort the upstream call before the serverless function's own limit is hit,
    // so a slow model returns a clean JSON error instead of a platform crash page.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 55000);

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
          max_tokens: 2600,
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
  return `You are an expert trip planner. Build a ${p.nights}-night itinerary for ${p.city}${p.country ? ", " + p.country : ""}.${p.postal ? ` Anchor the itinerary around postal/ZIP code ${p.postal}: favor neighborhoods, stops, and lodging in or near that area, and name the district/area it maps to so the traveler knows where to go.` : ""}

Travelers: ${p.people} (${p.group}). Pace: ${p.pace}. Hotel: ${p.hotel}. Rest days: ${p.rest}.

ITINERARY RULES:
- Each day = ONE geographic cluster. Never bounce across the city in a day.
- Use REAL, well-known named places for this destination (specific museums, markets, restaurants, viewpoints, neighborhoods).
- Density by pace: packed=4-5 stops/day, moderate=3, slow=1-2.
- Order within a day: crowd-sensitive landmarks early; flexible/late-hours places as buffer; a viewpoint at golden hour; dinner walkable from the last stop.
- For each day, add an "eat": one real, well-known place to eat INSIDE that day's cluster (walkable/near the stops) plus its standout dish. No chains, no generic "a local cafe".
- Rest days: "yes" => ~one per 4 days; "auto" => one only if nights>=4, placed late-middle (never day 1 or last); "no" => none. Rest day = light frame (neighborhood + 2-3 optional cafes + one backup), not a full schedule.
- Family with kids: fewer stops, more breaks even if pace says packed — note the adjustment.
- 5+ travelers: note everything needs reservations.

FOOD TO TRY:
- food: the 3 most iconic/worthwhile places to eat across the whole destination — each a REAL named spot with its signature dish and the area/neighborhood to find it. Not chains, not generic. These are destination highlights, distinct from the per-day "eat" picks.

HONESTY:
- honest_note: 1-2 sentences naming the plan's real weakness (overstuffed day, a stop not worth its time, or a deceptively long transit leg).

KEEP IT COMPACT (important — the whole reply must fit in one short JSON response):
- Each "tip" is one short phrase, max 12 words. No full sentences.
- "hotels": at most 2 entries. "logistics": at most 4 items. Each "tradeoff" and logistics item max 14 words.
- Each "dish" max 8 words. "food": exactly 3 entries. Each "area" max 4 words. Don't reuse a day's "eat" spot in "food".
- Do not repeat information across fields. Favor brevity over completeness.

Respond with ONLY valid JSON, no markdown fence, no preamble:
{"days":[{"title":"string","rest":boolean,"slots":[{"time":"HH:MM or —","place":"string","tip":"string"}],"eat":{"place":"string","dish":"string"}}],"food":[{"name":"string","dish":"string","area":"string"}],"hotels":[{"name":"string","tradeoff":"string"}],"logistics":["string"],"honest_note":"string"}`;
}
