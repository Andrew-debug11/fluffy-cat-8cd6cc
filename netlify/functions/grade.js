const Anthropic = require("@anthropic-ai/sdk");

// Simple in-memory cache (survives warm function instances, resets on cold starts)
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

// SPA detection — runs signals in priority order, returns on first match
function detectSPA(html) {
  // Signal 1: Body text under 500 characters after stripping tags
  const stripped = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (stripped.length < 500) {
    return { isSPA: true, reason: "empty-body" };
  }

  // Signal 2: Known SPA root containers
  if (/<div[^>]+id=["'](root|app|__next|___gatsby)["']/i.test(html)) {
    return { isSPA: true, reason: "spa-container" };
  }

  // Signal 3: Wix markers
  if (
    /static\.parastorage\.com/i.test(html) ||
    /wix\.com/i.test(html) ||
    /X-Wix-/i.test(html)
  ) {
    return { isSPA: true, reason: "wix" };
  }

  // Signal 4: Squarespace markers
  if (
    /Static\.SQUARESPACE_CONTEXT/i.test(html) ||
    /squarespace-cdn\.com/i.test(html)
  ) {
    return { isSPA: true, reason: "squarespace" };
  }

  // Signal 5: Webflow markers
  if (/data-wf-page/i.test(html) || /webflow\.com/i.test(html)) {
    return { isSPA: true, reason: "webflow" };
  }

  // Signal 6: Generic SPA fallback — small HTML, many scripts, no semantic content
  const scriptCount = (html.match(/<script/gi) || []).length;
  const hasSemanticContent = /<(main|article)[^>]*>/i.test(html);
  if (html.length < 5000 && scriptCount >= 3 && !hasSemanticContent) {
    return { isSPA: true, reason: "generic-spa" };
  }

  return { isSPA: false };
}

function buildSPAReport(url, reason) {
  const platformNames = {
    wix: "Wix",
    squarespace: "Squarespace",
    webflow: "Webflow",
    "spa-container": "a JavaScript framework",
    "empty-body": "a JavaScript framework",
    "generic-spa": "a JavaScript framework",
  };
  const platform = platformNames[reason] || "a JavaScript framework";

  return {
    url,
    isSPA: true,
    spaReason: reason,
    overallScore: null,
    overallSummary: `This site loads its content dynamically — it's built on ${platform}. Our scanner reads the raw page code, and on sites like this, that code is mostly empty until a browser runs it. We can confirm the site is live and the connection is secure, but we can't score what we can't see.`,
    teaserFinding: `This site is built on ${platform}. Our scanner can confirm it's live and secure, but can't read the content until a browser renders it. A manual review is the right next step.`,
    sections: [],
    generatedAt: new Date().toISOString(),
  };
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
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }
    const html = await res.text();
    return html.substring(0, 30000);
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// Headless fetch via ScrapingBee — used only when SPA guard fires
async function fetchSiteContentHeadless(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(
      `https://app.scrapingbee.com/api/v1/?api_key=${process.env.SCRAPINGBEE_API_KEY}&url=${encodeURIComponent(url)}&render_js=true&wait=5000&premium_proxy=true`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) {
      const err = new Error(`ScrapingBee HTTP ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }
    const html = await res.text();
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

  // Fetch site HTML — raw fetch first (fast, no API cost)
  let siteHtml;
  try {
    siteHtml = await fetchSiteContent(url);
  } catch (err) {
    // Raw fetch failed — do NOT fall through to headless, return immediately
    let userMessage = "We couldn't reach this site. Double-check the URL or try again in a few minutes.";

    if (err.name === "AbortError") {
      userMessage = "That site took too long to respond. It may be down or blocking automated requests.";
    } else if (err.statusCode === 403) {
      userMessage = "That site blocked our request. Some sites don't allow automated access.";
    } else if (err.statusCode === 404) {
      userMessage = "That page doesn't exist. Check the URL and try again.";
    } else if (err.statusCode >= 500) {
      userMessage = "That site is having server issues right now. Try again later.";
    } else if (err.message?.toLowerCase().includes("failed to fetch") || err.code === "ENOTFOUND") {
      userMessage = "We couldn't find that site. Double-check the URL — there may be a typo.";
    }

    return {
      statusCode: 422,
      headers,
      body: JSON.stringify({ error: userMessage }),
    };
  }

  // SPA detection — runs before Claude, no API cost on match
  const spaCheck = detectSPA(siteHtml);
  if (spaCheck.isSPA) {
    // Raw HTML confirmed SPA — attempt headless render via ScrapingBee
    try {
      siteHtml = await fetchSiteContentHeadless(url);
      // Headless succeeded — fall through to scoring with rendered HTML
    } catch (err) {
      // Headless failed — return graceful error with Calendly CTA, never a false score
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          error: "This site uses a JavaScript framework we couldn't fully render. Book a free call and we'll audit it manually.",
          calendly: true,
        }),
      };
    }
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
