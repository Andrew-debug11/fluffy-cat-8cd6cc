const Anthropic = require("@anthropic-ai/sdk");

// Simple in-memory cache (survives warm function instances, resets on cold starts)
// For production, swap to KV store or Redis. Fine for v1.
const reportCache = new Map();
const ipRateLimits = new Map();

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_REQUESTS_PER_IP = 10;
const IP_WINDOW_MS = 24 * 60 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = ipRateLimits.get(ip);
  if (!record || now - record.windowStart > IP_WINDOW_MS) {
    ipRateLimits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= MAX_REQUESTS_PER_IP) return false;
  record.count++;
  return true;
}

function getCachedReport(url) {
  const entry = reportCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    reportCache.delete(url);
    return null;
  }
  return entry.report;
}

async function fetchSiteContent(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; PeninsulasAI-Grader/1.0; +https://peninsulasai.com/grader)",
      },
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Trim to ~15k chars to keep prompt cost reasonable
    return html.substring(0, 15000);
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

const ANALYSIS_PROMPT = `You are a plain-talking website grader for small businesses. Analyze the HTML below and return a JSON report. No jargon. Write like you're talking to a plumber or HVAC tech who doesn't have time for tech speak.

Score each section 1-10. Be honest — a 6 should feel like a 6. Don't pad scores.

Return ONLY valid JSON in this exact shape:

{
  "url": "<the url>",
  "overallScore": <number 1-10>,
  "overallSummary": "<2-3 sentences. Plain talk. What's working, what's holding them back.>",
  "teaserFinding": "<One sentence. The single most impactful thing they could fix today. This is shown before the email gate.>",
  "sections": [
    {
      "id": "seo",
      "label": "SEO Basics",
      "score": <number>,
      "findings": ["<specific finding 1>", "<specific finding 2>"],
      "fix": "<one specific, actionable fix>"
    },
    {
      "id": "mobile",
      "label": "Mobile Experience",
      "score": <number>,
      "findings": ["<finding 1>", "<finding 2>"],
      "fix": "<one fix>"
    },
    {
      "id": "ai",
      "label": "AI Readiness",
      "score": <number>,
      "findings": ["<finding 1>", "<finding 2>"],
      "fix": "<one fix>"
    },
    {
      "id": "conversion",
      "label": "Conversion & Trust",
      "score": <number>,
      "findings": ["<finding 1>", "<finding 2>"],
      "fix": "<one fix>"
    },
    {
      "id": "gbp",
      "label": "Google Business Alignment",
      "score": <number>,
      "findings": ["<finding 1>", "<finding 2>"],
      "fix": "<one fix>"
    }
  ]
}

Scoring guide:
- SEO: title tag, meta description, H1/H2 structure, alt text on images, any schema markup
- Mobile: viewport meta tag, text size, tap target spacing, signs of responsive layout
- AI Readiness: structured data presence, clear business name/address/phone, content written in natural Q&A language, FAQ sections, clear service descriptions that an AI could cite
- Conversion: visible phone number above fold, clear CTA buttons, testimonials or reviews visible, trust signals (license, years in business, certifications)
- Google Business: NAP (name/address/phone) consistency, matching service area, matching business name

HTML to analyze:
---
SITE_URL_PLACEHOLDER
---
SITE_HTML_PLACEHOLDER`;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // Rate limit by IP
  const ip =
    event.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    event.headers["client-ip"] ||
    "unknown";

  if (!checkRateLimit(ip)) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({
        error: "You've hit the daily limit of 10 reports. Try again tomorrow.",
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  let { url } = body;
  if (!url) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "URL is required" }),
    };
  }

  // Normalize URL
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  try {
    new URL(url);
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "That doesn't look like a valid URL." }),
    };
  }

  // Check cache
  const cached = getCachedReport(url);
  if (cached) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...cached, cached: true }),
    };
  }

  // Fetch site HTML
  let siteHtml;
  try {
    siteHtml = await fetchSiteContent(url);
  } catch (err) {
    let userMessage = "Could not reach that site.";
    if (err.name === "AbortError") {
      userMessage = "That site took too long to respond. Try again or check the URL.";
    } else if (err.message?.includes("4") || err.message?.includes("5")) {
      userMessage = `Site returned an error (${err.message}). It might be blocking automated requests.`;
    }
    return {
      statusCode: 422,
      headers,
      body: JSON.stringify({ error: userMessage }),
    };
  }

  // Build prompt
  const prompt = ANALYSIS_PROMPT.replace("SITE_URL_PLACEHOLDER", url).replace(
    "SITE_HTML_PLACEHOLDER",
    siteHtml
  );

  // Call Claude
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let report;
  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = message.content[0].text;
    // Strip any markdown code fences if present
    const cleaned = rawText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    report = JSON.parse(cleaned);
    report.url = url;
    report.generatedAt = new Date().toISOString();
  } catch (err) {
    console.error("Claude API error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Analysis failed. This site may have content we couldn't parse.",
      }),
    };
  }

  // Cache the result
  reportCache.set(url, { report, timestamp: Date.now() });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(report),
  };
};
