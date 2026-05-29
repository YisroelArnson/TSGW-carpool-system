(function initHelpForm() {
  const form = document.getElementById("help-request-form");
  if (!form) return;

  const config = window.CARPOOL_CONFIG || {};
  const officeEmail = config.officeEmail || "info@tsgw.org";
  const endpoint =
    config.helpRequestEndpoint ||
    (config.supabaseUrl ? `${String(config.supabaseUrl).replace(/\/+$/, "")}/functions/v1/send-office-help-request` : "");

  const emailLinks = document.querySelectorAll("[data-office-email]");
  emailLinks.forEach((link) => {
    link.textContent = officeEmail;
    link.setAttribute("href", `mailto:${officeEmail}`);
  });

  const status = document.getElementById("help-form-status");
  const submitButton = form.querySelector("button[type='submit']");

  function setStatus(message, type) {
    if (!status) return;
    status.textContent = message;
    status.className = `help-form-status ${type || ""}`.trim();
  }

  function formValue(name) {
    const input = form.elements[name];
    return input ? String(input.value || "").trim() : "";
  }

  function mailtoUrl(payload) {
    const subject = `TSGW Carpool help question${payload.name ? ` from ${payload.name}` : ""}`;
    const body = [
      "A parent submitted a carpool help question.",
      "",
      `Name: ${payload.name || "Not provided"}`,
      `Family Number: ${payload.familyNumber || "Not provided"}`,
      `Contact: ${payload.contact || "Not provided"}`,
      "",
      "Question:",
      payload.question,
      "",
      `Page: ${window.location.href}`
    ].join("\n");

    return `mailto:${encodeURIComponent(officeEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  async function sendToOffice(payload) {
    if (!endpoint) throw new Error("No help request endpoint configured");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || "Unable to send your question");
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const payload = {
      name: formValue("name"),
      familyNumber: formValue("familyNumber"),
      contact: formValue("contact"),
      question: formValue("question"),
      website: formValue("website"),
      pageUrl: window.location.href,
      userAgent: navigator.userAgent
    };

    if (!payload.question) {
      setStatus("Please type your question before sending.", "error");
      form.elements.question?.focus();
      return;
    }

    submitButton.disabled = true;
    setStatus("Sending your question...", "");

    try {
      await sendToOffice(payload);
      form.reset();
      setStatus("Your question was sent to the office.", "success");
    } catch (error) {
      window.location.href = mailtoUrl(payload);
      setStatus("Your email app should open with the message addressed to the office. Send it from there.", "success");
    } finally {
      submitButton.disabled = false;
    }
  });
})();
