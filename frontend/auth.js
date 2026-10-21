/* Shared Supabase Auth helpers for the static Cart4Click frontend. */
(() => {
  let client;
  let idleTimer;
  let idleWarningTimer;
  const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
  const IDLE_WARNING_MS = IDLE_TIMEOUT_MS - 30 * 1000;
  const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "scroll", "mousemove"];

  function configured() {
    return Boolean(window.SUPABASE_URL && window.SUPABASE_PUBLISHABLE_KEY && window.supabase?.createClient);
  }

  function getClient() {
    if (!configured()) throw new Error("Sign-in is not configured yet. Please contact the site administrator.");
    if (!client) {
      client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      });
    }
    return client;
  }

  async function getVerifiedUser() {
    const supabase = getClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return data.user;
  }

  async function getAccessToken() {
    const supabase = getClient();
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token || null;
  }

  function loginUrl(message) {
    const target = `${location.pathname}${location.search}${location.hash}`;
    const query = new URLSearchParams({ returnTo: target });
    if (message) query.set("message", message);
    return `/login.html?${query.toString()}`;
  }

  async function requireDashboardSession() {
    try {
      const user = await getVerifiedUser();
      if (!user) {
        const isPublicEntry = location.pathname === "/" || location.pathname === "/index.html";
        location.replace(isPublicEntry ? "/landing.html" : loginUrl());
        return null;
      }
      document.documentElement.classList.remove("auth-pending");
      document.dispatchEvent(new CustomEvent("c4c:authenticated", { detail: { user } }));
      return user;
    } catch (error) {
      location.replace(loginUrl(error.message));
      return null;
    }
  }

  async function logout() {
    if (configured()) await getClient().auth.signOut();
    location.replace("/login.html?message=You%20have%20been%20signed%20out.");
  }

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    clearTimeout(idleWarningTimer);
    const warning = document.getElementById("idle-warning");
    if (warning) warning.hidden = true;
    idleWarningTimer = setTimeout(() => {
      if (warning) warning.hidden = false;
    }, IDLE_WARNING_MS);
    idleTimer = setTimeout(() => {
      void logout();
    }, IDLE_TIMEOUT_MS);
  }

  function startIdleLogout() {
    ACTIVITY_EVENTS.forEach(eventName => {
      window.addEventListener(eventName, resetIdleTimer, { passive: true });
    });
    resetIdleTimer();
  }

  window.C4CAuth = { configured, getClient, getVerifiedUser, getAccessToken, requireDashboardSession, logout };
  if (document.documentElement.dataset.protectedPage === "true") {
    void requireDashboardSession().then(user => {
      if (user) startIdleLogout();
    });
  }
})();
