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
  let signupMode = false;

  function showMessage(text, error = false) {
    message.textContent = text;
    message.classList.toggle("error", error);
    message.hidden = !text;
  }

  function setStep(step) {
    nameForm.hidden = step !== "name";
    emailForm.hidden = step !== "email";
    codeForm.hidden = step !== "code";
    document.querySelector(".login-progress").hidden = step === "signed-in";
    $("#signed-in-panel").hidden = step !== "signed-in";
    $("#signup-prompt").hidden = step === "signed-in" || step === "code";
    $("#name-summary-wrap").hidden = !signupMode || step !== "email";
    $("#cancel-signup").hidden = !signupMode || step !== "email";
    $("#login-title").textContent = step === "name" ? "Create your account" : step === "signed-in" ? "You’re already signed in" : step === "code" ? "Check your email" : signupMode ? "Create your account" : "Already have an account? Log in";
    $(".login-intro").hidden = step === "signed-in";
    $(".login-intro").textContent = signupMode
      ? "Create your account with your name and email. We’ll send a code to verify your email."
      : "Enter your email and we’ll send you a one-time code to log in.";
    const progress = signupMode ? { name: "1", email: "2", code: "2" }[step] : { name: "1", email: "1", code: "2" }[step];
    document.querySelectorAll("[data-progress]").forEach(node => {
      node.classList.toggle("current", node.dataset.progress === progress);
      node.classList.toggle("complete", Number(node.dataset.progress) < Number(progress));
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
      body: JSON.stringify({ first_name: signupMode ? firstName : "", last_name: signupMode ? lastName : "", email }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || `Could not send the code (HTTP ${response.status}).`);
    challengeId = data.challenge_id;
    $("#email-summary").textContent = email;
    $("#email-code").value = "";
    setStep("code");
    showMessage("Check your inbox for a six-digit code to continue.");
    startResendTimer();
    $("#email-code").focus();
  }

  nameForm.addEventListener("submit", event => {
    event.preventDefault();
    firstName = $("#first-name").value.trim();
    lastName = $("#last-name").value.trim();
    if (!firstName || !lastName) return;
    $("#name-summary").textContent = `${firstName} ${lastName}`;
    signupMode = true;
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
    finally { submit.disabled = false; submit.textContent = signupMode ? "Send code" : "Email me a login code"; }
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
      showMessage("Email verified. You’re logged in.");
      $("#email-code").disabled = true;
      setTimeout(() => { location.href = "/"; }, 900);
    } catch (error) { showMessage(error.message, true); }
    finally { submit.disabled = false; submit.textContent = "Verify and log in"; }
  });

  document.querySelectorAll("[data-back]").forEach(button => button.addEventListener("click", () => {
    setStep(button.dataset.back);
  }));

  $("#show-login").addEventListener("click", () => {
    signupMode = false;
    challengeId = "";
    $("#email-address").value = "";
    setStep("email");
    $("#email-address").focus();
  });

  $("#show-signup").addEventListener("click", () => {
    signupMode = true;
    setStep("name");
    $("#first-name").focus();
  });

  $("#cancel-signup").addEventListener("click", () => {
    signupMode = false;
    setStep("email");
  });

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
      $("#signed-in-name").textContent = storedUser.first_name === "there"
        ? storedUser.email
        : `${storedUser.first_name} ${storedUser.last_name}`.trim();
      setStep("signed-in");
    }
  } catch { /* Start a new sign-in if local browser data is invalid. */ }

  $("#sign-out").addEventListener("click", () => {
    localStorage.removeItem("c4c-auth-session");
    localStorage.removeItem("c4c-auth-user");
    location.reload();
  });
})();
