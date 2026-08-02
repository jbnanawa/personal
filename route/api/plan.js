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
    const prompt = buildPrompt(req.body || {});

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
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") {
        return res.status(504).json({ error: "The planner took too long to respond. Try again, or shorten the trip." });
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

// ---- Prompt construction -------------------------------------------------

const PACE_DENSITY = {
  relaxed: "1-2 main activities per day",
  balanced: "2-3 activities per day",
  full: "as much as possible (4-5 stops/day)",
};

const DOWNTIME_RULE = {
  recommend: 'decide based on trip length + pace: include one lighter day only if the trip is 4+ days',
  include: "deliberately include a lighter day or free half-day",
  none: "no dedicated downtime; keep every day active",
};

const TRANSPORT_RULE = {
  rental: "traveler has a rental car — cluster by driving proximity, note parking, give driving times",
  public: "traveler uses public transportation — favor transit-accessible stops, note lines/passes, avoid car-only spots",
  walk_rideshare: "traveler walks + uses rideshare — keep each day walkable, minimize long transfers",
  not_sure: "transportation undecided — prefer walkable clusters and mention the easiest way to get around",
};

function labelDestination(d) {
  if (!d) return "the destination";
  if (typeof d === "string") return d;
  return d.displayName || [d.name, d.region, d.country].filter(Boolean).join(", ") || "the destination";
}

function buildPrompt(b) {
  // Accept both the new structured payload and older flat fields for safety.
  const dest = b.destination || { name: b.city, region: "", country: b.country };
  const destName = labelDestination(dest);
  const coords = (dest && dest.lat != null && dest.lon != null) ? ` (lat ${dest.lat}, lon ${dest.lon})` : "";

  const nights = Number(b.nights) || 3;
  const days = nights + 1;
  const travelers = Number(b.travelers || b.people) || 2;
  const group = b.group || "couple";
  const kids = (b.childrenAges || "").trim();
  const pace = b.pace || "balanced";
  const downtime = b.downtime || "recommend";
  const transport = b.transport || "not_sure";
  const interests = Array.isArray(b.interests) ? b.interests.filter(Boolean) : [];
  const mustDo = (b.mustDo || "").trim();

  // Optional "fine-tune" fields.
  const budget = (b.budget || "").trim();
  const foodPrefs = Array.isArray(b.foodPrefs) ? b.foodPrefs.filter(Boolean) : [];
  const foodOther = (b.foodOther || "").trim();
  const accessibility = Array.isArray(b.accessibility) ? b.accessibility.filter(Boolean) : [];
  const avoid = (b.avoid || "").trim();

  const datesLine = (b.datesKnown && b.startDate && b.endDate)
    ? `Travel dates: ${b.startDate} to ${b.endDate} (${nights} nights, ${days} days).`
    : `Trip length: ${nights} nights (${days} days). Exact dates flexible.`;

  const foodLine = [
    foodPrefs.length ? foodPrefs.join(", ") : "",
    foodOther,
  ].filter(Boolean).join(", ");

  const opt = [];
  if (budget) opt.push(`Budget comfort: ${budget}.`);
  if (foodLine) opt.push(`Food needs: ${foodLine} — every food suggestion must respect these.`);
  if (accessibility.length) opt.push(`Accessibility/comfort: ${accessibility.join(", ")} — respect these in every stop (avoid what conflicts, flag it in heads_up).`);
  if (avoid) opt.push(`Things to avoid: ${avoid} — do not include these.`);

  return `You are Gora, a practical travel planner. Your edge is reducing backtracking and catching problems before they disrupt a trip. Build a ${nights}-night itinerary for ${destName}${coords}.

${datesLine}
Travelers: ${travelers} (${group})${kids ? `, children ages: ${kids}` : ""}.
Pace: ${pace} — ${PACE_DENSITY[pace] || PACE_DENSITY.balanced}.
Downtime: ${DOWNTIME_RULE[downtime] || DOWNTIME_RULE.recommend}.
Getting around: ${TRANSPORT_RULE[transport] || TRANSPORT_RULE.not_sure}.
${interests.length ? `Interests to weave in (prioritize these): ${interests.join(", ")}.` : ""}
${mustDo ? `Must-do (fit these in, on suitable days): ${mustDo}.` : ""}
${opt.join("\n")}

PLANNING RULES:
- Each day = ONE geographic cluster to minimize backtracking. Never bounce across the region in a day.
- Use REAL, well-known named places for this destination — specific viewpoints, beaches, museums, markets, trails, restaurants. No chains, no generic "a local cafe".
- Order stops to flow geographically and by time of day: crowd-sensitive spots early, viewpoints near golden hour, dinner near the last stop.
- Group with children: fewer stops, more breaks, kid-appropriate; reflect the children's ages.
- ${travelers >= 5 ? "Party of 5+: note where reservations are essential." : "Note reservations only where genuinely needed."}

FOR EACH DAY, produce:
- title: short theme name (e.g. "North Kona Coast").
- theme: one phrase on the day's focus.
- activity_time and travel_time: rough estimates (e.g. "~5h", "~40m driving"). Use the traveler's transport mode.
- cluster_note: one short line quantifying the tightness (e.g. "main stops within ~15 min of each other").
- sections: ordered blocks with part = "Morning" | "Lunch" | "Afternoon" | "Evening" (include only the parts that apply). Each item has: place, why (short reason it fits THIS traveler), time (e.g. "9:00 AM"), cost ("free" | "$" | "$$" | "$$$"), travel_from_prev (e.g. "~10m", "—" for the first), note (one practical tip).
- heads_up: 0-3 warnings, ONLY from this exact set when they truly apply: "Reservation recommended", "Limited parking", "Weather-sensitive", "Early start recommended", "Long walking distance", "Closed on certain days", "Not stroller-friendly", "Long driving day". Do not invent others; do not claim anything is verified.
- backup: one short backup plan when weather/closure risk is real (e.g. swap a beach for an indoor market); omit if not needed.

ALSO produce:
- food: the 3 most iconic/worthwhile places to eat across the whole destination (real named spot, signature dish, area). Respect any food needs above.
- hotels: at most 2 areas/stays with a one-line tradeoff each.
- logistics: at most 4 short pre-trip items.
- honest_note: 1-2 sentences naming the plan's real weakness (an overstuffed day, a long transit leg, a stop that may not be worth it). Be candid, not alarming.

KEEP IT COMPACT (must fit one JSON response): "why" and "note" max ~12 words each; no full paragraphs; do not repeat info across fields; favor brevity.

Respond with ONLY valid JSON, no markdown fence, no preamble:
{"destination":"${destName}","days":[{"day":1,"title":"string","theme":"string","activity_time":"string","travel_time":"string","cluster_note":"string","sections":[{"part":"Morning","items":[{"place":"string","why":"string","time":"string","cost":"$","travel_from_prev":"string","note":"string"}]}],"heads_up":["string"],"backup":"string"}],"food":[{"name":"string","dish":"string","area":"string"}],"hotels":[{"name":"string","tradeoff":"string"}],"logistics":["string"],"honest_note":"string"}`;
}
