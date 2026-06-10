

  let currentReport = null;

  function showError(msg) {
    const el = document.getElementById("errorMsg");
    el.textContent = msg;
    el.style.display = "block";
  }

  function hideError() {
    document.getElementById("errorMsg").style.display = "none";
  }

  function setLoading(step) {
    document.getElementById("loadingStep").textContent = step;
  }

  async function startGrading() {
    hideError();
    let url = document.getElementById("urlInput").value.trim();
    if (!url) {
      showError("Enter a URL first.");
      return;
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    try { new URL(url); } catch {
      showError("That doesn't look like a valid URL.");
      return;
    }

    // UI state: show loading
    document.getElementById("inputCard").style.display = "none";
    document.getElementById("previewState").style.display = "none";
    document.getElementById("fullReport").style.display = "none";
    document.getElementById("loadingState").style.display = "block";

    const steps = [
      "Fetching page content",
      "Checking SEO structure",
      "Analyzing mobile setup",
      "Reviewing trust signals",
      "Generating your score",
    ];
    let stepIdx = 0;
    const stepTimer = setInterval(() => {
      stepIdx = (stepIdx + 1) % steps.length;
      setLoading(steps[stepIdx]);
    }, 1800);

    try {
      let res;
      try {
        res = await fetch("/api/grade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
      } catch {
        // First attempt failed — retry once silently
        res = await fetch("/api/grade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
      }

      clearInterval(stepTimer);
      const data = await res.json();

      if (!res.ok) {
        document.getElementById("inputCard").style.display = "block";
        document.getElementById("loadingState").style.display = "none";
        showError(data.error || "Something went wrong. Try again.");
        return;
      }

      currentReport = data;
      showPreview(data);

    } catch (err) {
      clearInterval(stepTimer);
      document.getElementById("inputCard").style.display = "block";
      document.getElementById("loadingState").style.display = "none";
      showError("This one took a little longer than expected. Hit Grade It one more time — it'll come right up.");
    }
  }

  function showPreview(report) {
    document.getElementById("loadingState").style.display = "none";
    document.getElementById("previewState").style.display = "block";

    document.getElementById("previewSummary").textContent = report.overallSummary;
    document.getElementById("teaserText").textContent = report.teaserFinding;

    const scoreEl = document.getElementById("previewScore");
    const denomEl = scoreEl.nextElementSibling;

    if (report.isSPA || report.overallScore === null) {
      // SPA detected — replace score circle with label
      scoreEl.style.fontSize = "18px";
      scoreEl.style.letterSpacing = "0.02em";
      scoreEl.textContent = "JS";
      denomEl.textContent = "Rendered";
      scoreEl.style.cssText += "color: #8899AA; -webkit-text-fill-color: #8899AA; font-size: 18px;";
    } else {
      scoreEl.textContent = report.overallScore;
      const score = report.overallScore;
      if (score >= 7) scoreEl.style.cssText = "background: linear-gradient(135deg, #14B8A6, #0EA5E9); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;";
      else if (score >= 4) scoreEl.style.cssText = "background: linear-gradient(135deg, #0EA5E9, #F472B6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;";
      else scoreEl.style.cssText = "color: #F472B6; -webkit-text-fill-color: #F472B6;";
    }

    // Wix caveat banner
    const caveat = document.getElementById("wixCaveat");
    caveat.style.display = report.isWix ? "block" : "none";
  }

  function getScoreClass(score) {
    if (score >= 7) return "high";
    if (score >= 4) return "mid";
    return "low";
  }

  function renderSections(report) {
    const grid = document.getElementById("sectionGrid");
    grid.innerHTML = "";

    // SPA report — no sections, show manual review message instead
    if (report.isSPA || !report.sections || report.sections.length === 0) {
      grid.innerHTML = `
        <div class="section-card" style="text-align:center;padding:32px 24px;">
          <p style="font-size:32px;margin-bottom:16px;">🔍</p>
          <p style="font-family:var(--font-display);font-size:20px;font-weight:700;margin-bottom:12px;">Manual Review Required</p>
          <p style="color:var(--muted);font-size:15px;line-height:1.6;">This site builds its pages in the browser after load. Our scanner confirmed it's live and secure, but scoring requires a human eye. Book a free call and we'll walk through it with you.</p>
        </div>
      `;
      return;
    }

    report.sections.forEach(section => {
      const cls = getScoreClass(section.score);
      const barWidth = (section.score / 10) * 100;
      const card = document.createElement("div");
      card.className = "section-card";
      card.innerHTML = `
        <div class="section-header">
          <span class="section-name">${section.label}</span>
          <div class="section-score-badge">
            <span class="score-pill ${cls}">${section.score}</span>
            <span style="color:var(--muted);font-size:13px;">/10</span>
          </div>
        </div>
        <div class="score-bar-wrap">
          <div class="score-bar ${cls}" style="width: 0%" data-width="${barWidth}%"></div>
        </div>
        <ul class="findings-list">
          ${section.findings.map(f => `<li>${f}</li>`).join("")}
        </ul>
        <div class="fix-block">
          <p class="fix-label">Fix This First</p>
          <p class="fix-text">${section.fix}</p>
        </div>
      `;
      grid.appendChild(card);
    });

    // Animate bars after brief delay
    setTimeout(() => {
      document.querySelectorAll(".score-bar").forEach(bar => {
        bar.style.width = bar.dataset.width;
      });
    }, 100);
  }

  async function unlockReport() {
    const email = document.getElementById("gateEmail").value.trim();
    if (!email || !email.includes("@")) {
      document.getElementById("gateEmail").focus();
      document.getElementById("gateEmail").style.borderColor = "rgba(244,114,182,0.5)";
      return;
    }
    document.getElementById("gateEmail").style.borderColor = "";

    const btn = document.getElementById("unlockBtn");
    btn.disabled = true;
    btn.textContent = "Sending...";

    // Send report via Resend (server-side Netlify function)
    if (currentReport) {
      try {
        const res = await fetch("/api/send-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, report: currentReport }),
        });
        if (res.ok) {
          document.getElementById("emailSentMsg").style.display = "block";
        }
      } catch (err) {
        console.error("Send report error:", err);
        // Still show report even if email fails
      }
    }

    // Show full report
    document.getElementById("gateCard").style.display = "none";
    document.getElementById("fullReport").style.display = "block";
    document.getElementById("reportUrl").textContent = currentReport.url;
    renderSections(currentReport);

    // Scroll to report
    document.getElementById("fullReport").scrollIntoView({ behavior: "smooth" });
  }

  function resetGrader() {
    currentReport = null;
    document.getElementById("urlInput").value = "";
    document.getElementById("gateEmail").value = "";
    document.getElementById("gateCard").style.display = "block";
    document.getElementById("emailSentMsg").style.display = "none";
    document.getElementById("fullReport").style.display = "none";
    document.getElementById("previewState").style.display = "none";
    document.getElementById("wixCaveat").style.display = "none";
    document.getElementById("inputCard").style.display = "block";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Enter key on URL input
  document.getElementById("urlInput").addEventListener("keydown", e => {
    if (e.key === "Enter") startGrading();
  });

  // Enter key on email input
  document.getElementById("gateEmail").addEventListener("keydown", e => {
    if (e.key === "Enter") unlockReport();
  });
