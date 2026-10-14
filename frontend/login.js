(() => {
  const $ = selector => document.querySelector(selector);
  const API_BASE_URL = (window.API_BASE_URL || "").replace(/\/+$/, "");
  const nameForm = $("#name-form");
  const emailForm = $("#email-form");
  const codeForm = $("#code-form");
  const message = $("#login-message");
  let firstName = "";
  let lastName = "";
  let email = "";
  let challengeId = "";
  let resendTimer;

  function showMessage(text, error = false) {
    message.textContent = text;
    message.classList.toggle("error", error);
    message.hidden = !text;
  }

  function setStep(step) {
    nameForm.hidden = step !== "name";
    emailForm.hidden = step !== "email";
    codeForm.hidden = step !== "code";
    document.querySelectorAll("[data-progress]").forEach(node => {
      node.classList.toggle("current", node.dataset.progress === ({ name: "1", email: "2", code: "3" }[step]));
      node.classList.toggle("complete", Number(node.dataset.progress) < Number(({ name: "1", email: "2", code: "3" }[step])));
    });
    showMessage("");
  }

  function startResendTimer() {
    const button = $("#resend-code");
    let remaining = 60;
    clearInterval(resendTimer);
    button.disabled = true;
    button.textContent = `Resend code in ${remaining}s`;
    resendTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(resendTimer);
        button.disabled = false;
        button.textContent = "Resend code";
      } else button.textContent = `Resend code in ${remaining}s`;
    }, 1000);
  }

  async function requestCode() {
    if (!API_BASE_URL) {
      throw new Error("Email sign-in is not connected yet. The site needs its secure API and email service configured.");
    }
    const response = await fetch(`${API_BASE_URL}/api/auth/request-code`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ first_name: firstName, last_name: lastName, email }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || `Could not send the code (HTTP ${response.status}).`);
    challengeId = data.challenge_id;
    $("#email-summary").textContent = email;
    $("#email-code").value = "";
    setStep("code");
    showMessage("Check your inbox for a six-digit sign-in code.");
    startResendTimer();
    $("#email-code").focus();
  }

  nameForm.addEventListener("submit", event => {
    event.preventDefault();
    firstName = $("#first-name").value.trim();
    lastName = $("#last-name").value.trim();
    if (!firstName || !lastName) return;
    $("#name-summary").textContent = `${firstName} ${lastName}`;
    setStep("email");
    $("#email-address").focus();
  });

  emailForm.addEventListener("submit", async event => {
    event.preventDefault();
    const nextEmail = $("#email-address").value.trim().toLowerCase();
    if (challengeId && nextEmail === email) {
      setStep("code");
      return;
    }
    email = nextEmail;
    const submit = emailForm.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.textContent = "Sending…";
    try { await requestCode(); }
    catch (error) { showMessage(error.message, true); }
    finally { submit.disabled = false; submit.textContent = "Send code"; }
  });

  codeForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!API_BASE_URL || !challengeId) {
      showMessage("Request a new code before verifying.", true);
      return;
    }
    const submit = codeForm.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.textContent = "Checking…";
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/verify-code`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_id: challengeId, code: $("#email-code").value.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || `Could not verify the code (HTTP ${response.status}).`);
      localStorage.setItem("c4c-auth-session", data.session_token);
      localStorage.setItem("c4c-auth-user", JSON.stringify(data.user));
      showMessage("Email verified. You’re signed in.");
      $("#email-code").disabled = true;
      setTimeout(() => { location.href = "/"; }, 900);
    } catch (error) { showMessage(error.message, true); }
    finally { submit.disabled = false; submit.textContent = "Verify and sign in"; }
  });

  document.querySelectorAll("[data-back]").forEach(button => button.addEventListener("click", () => {
    setStep(button.dataset.back);
  }));

  $("#resend-code").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await requestCode(); }
    catch (error) { showMessage(error.message, true); button.disabled = false; }
  });

  $("#email-code").addEventListener("input", event => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
  });

  try {
    const storedUser = JSON.parse(localStorage.getItem("c4c-auth-user") || "null");
    if (localStorage.getItem("c4c-auth-session") && storedUser?.first_name) {
      nameForm.hidden = emailForm.hidden = codeForm.hidden = true;
      document.querySelector(".login-progress").hidden = true;
      $(".login-intro").hidden = true;
      $("#signed-in-panel").hidden = false;
      $("#signed-in-name").textContent = `${storedUser.first_name} ${storedUser.last_name}`;
      $("#login-title").textContent = "You’re already signed in";
    }
  } catch { /* Start a new sign-in if local browser data is invalid. */ }

  $("#sign-out").addEventListener("click", () => {
    localStorage.removeItem("c4c-auth-session");
    localStorage.removeItem("c4c-auth-user");
    location.reload();
  });
})();
