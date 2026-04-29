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

    // Notify andrew@ of new lead (fire and forget, don't block)
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Veronica at Peninsulas AI <veronica@peninsulasai.com>",
        to: ["andrew@peninsulasai.com"],
        subject: `New Grader Lead: ${email} — ${report.url} scored ${report.overallScore}/10`,
        html: `<p><strong>Email:</strong> ${email}</p><p><strong>Site:</strong> ${report.url}</p><p><strong>Score:</strong> ${report.overallScore}/10</p><p><strong>Summary:</strong> ${report.overallSummary}</p>`,
      }),
    }).catch(err => console.error("Lead notify error:", err));

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error("send-report error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Email delivery failed" }) };
  }
};

function buildReportHtml(report) {
  const sectionRows = report.sections.map(s => {
    const color = s.score >= 7 ? "#14B8A6" : s.score >= 4 ? "#0EA5E9" : "#F472B6";
    return `
      <div style="background:#0e0e1a;border:1px solid #1a1a2e;border-radius:8px;padding:16px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong style="color:#F0EDE8;font-size:16px;">${s.label}</strong>
          <span style="color:${color};font-weight:bold;font-size:18px;">${s.score}/10</span>
        </div>
        <p style="color:#8899AA;font-size:14px;margin-bottom:8px;">${s.findings.join(" · ")}</p>
        <div style="background:rgba(20,184,166,0.08);border:1px solid rgba(20,184,166,0.2);border-radius:6px;padding:10px;">
          <p style="color:#14B8A6;font-size:11px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:4px;">Fix This First</p>
          <p style="color:#F0EDE8;font-size:14px;margin:0;">${s.fix}</p>
        </div>
      </div>
    `;
  }).join("");

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="background:#080810;color:#F0EDE8;font-family:sans-serif;margin:0;padding:0;">
      <div style="max-width:600px;margin:0 auto;padding:32px 24px;">

        <div style="text-align:center;margin-bottom:32px;">
          <p style="color:#8899AA;font-size:13px;margin-bottom:4px;">Peninsulas AI · Website Grader</p>
          <h1 style="font-size:28px;margin-bottom:4px;">Your Score: ${report.overallScore}/10</h1>
          <p style="color:#8899AA;font-size:13px;word-break:break-all;">${report.url}</p>
        </div>

        <div style="background:#0e0e1a;border:1px solid rgba(14,165,233,0.2);border-radius:10px;padding:20px;margin-bottom:24px;">
          <p style="font-size:16px;line-height:1.6;margin:0;">${report.overallSummary}</p>
        </div>

        ${sectionRows}

        <div style="background:linear-gradient(135deg,rgba(14,165,233,0.1),rgba(20,184,166,0.1));border:1px solid rgba(14,165,233,0.2);border-radius:10px;padding:24px;text-align:center;margin-top:32px;">
          <h2 style="font-size:22px;margin-bottom:8px;">Want a human walkthrough?</h2>
          <p style="color:#8899AA;font-size:15px;margin-bottom:20px;">30 minutes. We go through this together and tell you exactly what to fix first.</p>
          <a href="https://peninsulasai.com/#contact" style="background:linear-gradient(135deg,#0EA5E9,#14B8A6);color:#080810;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:bold;font-size:16px;display:inline-block;">Book a Free Call</a>
          <p style="color:#8899AA;font-size:13px;margin-top:16px;">Or upgrade to the <strong style="color:#F0EDE8;">$300 Full Audit</strong> — recorded walkthrough, prioritized fix list, 30-day follow-up.</p>
        </div>

        <p style="color:#8899AA;font-size:12px;text-align:center;margin-top:24px;">
          Peninsulas AI · Downriver + Metro Detroit · <a href="https://peninsulasai.com" style="color:#8899AA;">peninsulasai.com</a>
        </p>

      </div>
    </body>
    </html>
  `;
}
