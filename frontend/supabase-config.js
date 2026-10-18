// This file is deliberately safe to commit. GitHub Actions replaces these empty
// values with the Supabase project URL and publishable key at deploy time.
// A publishable key is designed for browser use; do not put a service-role key
// or any SMTP credential in this file.
window.SUPABASE_URL = window.SUPABASE_URL || "";
window.SUPABASE_PUBLISHABLE_KEY = window.SUPABASE_PUBLISHABLE_KEY || "";
