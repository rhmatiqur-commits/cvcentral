# CV Central — Product & Business TODO

---

## 🌍 International Expansion

### Spanish-speaking markets (Priority: HIGH — do this first)
- Translate UI strings into Spanish
- Detect browser locale (`es-*`) and switch AI prompts to Spanish automatically
- Add EUR / USD pricing options in Stripe (alongside GBP)
- Adjust LATAM pricing (~$2–3 USD/month via Stripe's country-based pricing)
- Target: Spain first, then Mexico / Colombia / Argentina / Chile
- Low competition, CV culture similar to UK, Claude handles Spanish natively
- Estimated effort: 2–3 weeks

### US market (Priority: LOW — revisit after Spanish launch)
- Rebrand to "Resume Builder" for US pages (separate subdomain or domain)
- Rewrite AI prompts: American English, 1-page resume format, no photo/DOB
- New template designs suited to US resume conventions
- Heavy SEO investment needed — highly competitive market
- Estimated effort: 2–3 months (essentially a separate product)

---

## 📧 Email Infrastructure

### Set up transactional email via Resend (Priority: HIGH — do before scaling)
- Sign up at resend.com (free up to 3,000 emails/month)
- Add cvcentral.io domain and verify DNS records
- Configure Supabase SMTP: host `smtp.resend.com`, port 465, user `resend`, password = Resend API key
- Enable email confirmation back on in Supabase Auth settings
- Also covers: password reset emails, any future notification emails
- Estimated effort: 30 minutes

---

## 💡 Other Ideas
<!-- Add more ideas here -->

