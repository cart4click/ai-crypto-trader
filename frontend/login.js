(() => {
  const $ = selector => document.querySelector(selector);

  const emailForm = $("#email-form");
  const codeForm = $("#code-form");
  const message = $("#login-message");

  let email = "";
  let resendTimer;

  function safeReturnTo(value) {
    return typeof value === "string" && /^\/(?!\/)/.test(value)
      ? value
      : "/";
  }

  function showMessage(text, error = false) {
    message.textContent = text;
    message.classList.toggle("error", error);
    message.hidden = !text;
  }

  function friendlyError(error, fallback) {
    const text = error?.message || fallback;

    if (/rate limit|too many requests|security purposes/i.test(text)) {
      return "Too many requests. Please wait before trying again.";
    }

    if (/expired/i.test(text)) {
      return "That code expired. Request a new code and try again.";
    }

    if (/invalid|incorrect|token/i.test(text)) {
      return "That code is incorrect or no longer valid. Check it and try again, or request a new code.";
    }

    return text;
  }

  function setStep(step) {
    const code = step === "code";

    emailForm.hidden = code;
    codeForm.hidden = !code;

    $("#login-title").textContent = code
      ? "Check your email"
      : "Sign in or create an account";

    $("#login-intro").textContent = code
      ? "Enter the six-digit code to continue securely."
      : "Enter your email and we’ll send a six-digit verification code.";

    $("#step-one").classList.toggle("complete", code);
    $("#step-one").classList.toggle("current", !code);
    $("#step-two").classList.toggle("current", code);

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
      } else {
        button.textContent = `Resend code in ${remaining}s`;
      }
    }, 1000);
  }

  function getCaptchaToken() {
    const captchaInput = document.querySelector(
      'input[name="cf-turnstile-response"]'
    );

    const token = captchaInput?.value?.trim();

    if (!token) {
      throw new Error("Please complete the security check.");
    }

    return token;
  }

  function resetCaptcha() {
    if (typeof window.turnstile === "undefined") {
      return;
    }

    const captchaWidget = document.querySelector(".cf-turnstile");

    if (captchaWidget) {
      try {
        window.turnstile.reset(captchaWidget);
      } catch (error) {
        console.warn("Could not reset Turnstile:", error);
      }
    }
  }

  async function sendOtp() {
    const captchaToken = getCaptchaToken();

    try {
      const { error } =
        await window.C4CAuth.getClient().auth.signInWithOtp({
          email,
          options: {
            shouldCreateUser: true,
            captchaToken: captchaToken
          }
        });

      if (error) {
        throw error;
      }

      $("#email-summary").textContent = email;
      $("#email-code").value = "";

      setStep("code");

      showMessage("Check your inbox for your verification code.");

      startResendTimer();

      $("#email-code").focus();
    } finally {
      resetCaptcha();
    }
  }

  emailForm.addEventListener("submit", async event => {
    event.preventDefault();

    email = $("#email-address").value.trim().toLowerCase();

    if (!emailForm.reportValidity()) {
      return;
    }

    const submit = emailForm.querySelector("button[type=submit]");

    submit.disabled = true;
    submit.textContent = "Sending…";

    try {
      await sendOtp();
    } catch (error) {
      showMessage(
        friendlyError(
          error,
          "Could not send a code. Please try again."
        ),
        true
      );
    } finally {
      submit.disabled = false;
      submit.textContent = "Send OTP";
    }
  });

  codeForm.addEventListener("submit", async event => {
    event.preventDefault();

    const token = $("#email-code").value.trim();

    if (!/^\d{6}$/.test(token)) {
      showMessage(
        "Enter the six-digit code from your email.",
        true
      );
      return;
    }

    const submit = $("#verify-code");

    submit.disabled = true;
    submit.textContent = "Verifying…";

    try {
      const {
        data,
        error
      } = await window.C4CAuth.getClient().auth.verifyOtp({
        email,
        token,
        type: "email"
      });

      if (error || !data.session) {
        throw (
          error ||
          new Error(
            "Supabase did not create a session. Request a new code."
          )
        );
      }

      location.replace(
        safeReturnTo(
          new URLSearchParams(location.search).get("returnTo")
        )
      );
    } catch (error) {
      showMessage(
        friendlyError(
          error,
          "Could not verify that code. Please try again."
        ),
        true
      );
    } finally {
      submit.disabled = false;
      submit.textContent = "Verify";
    }
  });

  $("#resend-code").addEventListener("click", async () => {
    try {
      await sendOtp();

      showMessage("A new verification code has been sent.");
    } catch (error) {
      showMessage(
        friendlyError(
          error,
          "Could not resend the code."
        ),
        true
      );
    }
  });

  $("#back-to-email").addEventListener("click", () => {
    setStep("email");
  });

  $("#email-code").addEventListener("input", event => {
    event.target.value = event.target.value
      .replace(/\D/g, "")
      .slice(0, 6);
  });

  (async () => {
    const configuredMessage =
      new URLSearchParams(location.search).get("message");

    if (configuredMessage) {
      showMessage(
        configuredMessage,
        /not configured/i.test(configuredMessage)
      );
    }

    if (!window.C4CAuth.configured()) {
      showMessage(
        "Sign-in is not configured yet. Please contact the site administrator.",
        true
      );

      emailForm.querySelector(
        "button[type=submit]"
      ).disabled = true;

      return;
    }

    const user = await window.C4CAuth.getVerifiedUser();

    if (user) {
      location.replace(
        safeReturnTo(
          new URLSearchParams(location.search).get("returnTo")
        )
      );
    }
  })().catch(() => {
    showMessage(
      "Unable to check your sign-in session. Please try again.",
      true
    );
  });
})();
