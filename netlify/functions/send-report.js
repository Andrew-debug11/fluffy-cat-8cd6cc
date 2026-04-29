exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { email, report } = body;
  if (!email || !report) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing email or report" }) };
  }

  const reportHtml = buildReportHtml(report);

  try {
    // Send report to user
    const userRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Veronica at Peninsulas AI <veronica@peninsulasai.com>",
        to: [email],
        subject: `Your Website Grade: ${report.overallScore}/10 — ${report.url}`,
        html: reportHtml,
      }),
    });

    if (!userRes.ok) {
      const err = await userRes.json();
      console.error("Resend error (user):", err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to send report email" }) };
    }

    // Notify of new lead
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Veronica at Peninsulas AI <veronica@peninsulasai.com>",
          to: ["amjerni@gmail.com"],
          subject: `New Grader Lead: ${email} — ${report.url} scored ${report.overallScore}/10`,
          html: `<p><strong>Email:</strong> ${email}</p><p><strong>Site:</strong> ${report.url}</p><p><strong>Score:</strong> ${report.overallScore}/10</p><p><strong>Summary:</strong> ${report.overallSummary}</p>`,
        }),
      });
    } catch (err) {
      console.error("Lead notify error:", err);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error("send-report error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Email delivery failed" }) };
  }
};
