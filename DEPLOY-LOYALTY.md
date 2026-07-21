# OneShetland Loyalty — Deployment Runbook

Everything needed to take the loyalty programme (points, reward ladders, nudges,
reminders, referrals, Apple Wallet, Google Wallet) live on the **app** and **web**.

Run all commands from `~/Claude/oneshetland-delivers` unless noted. The Supabase
CLI authenticates with your Supabase login — it **never** needs your Mac password.

**Suggested order:** Part 0 → Part 1 (whole scheme live) → Part 4 (app build) →
Parts 2–3 whenever you want the "Add to Wallet" buttons.

---

## Part 0 · One-time CLI setup
```bash
cd ~/Claude/oneshetland-delivers
supabase login          # opens the browser once
supabase link --project-ref nkrtmakxygkvxuxriiil
```

---

## Part 1 · Make the whole scheme work (do this first)
Lights up points earn/redeem, reward ladders, "almost there" nudges, referrals,
reminder pushes, and staff-verified redemption.
```bash
# database changes (idempotent — safe to re-run)
supabase db push

# edge functions
supabase functions deploy local-redeem-start local-redeem-verify \
  local-stamp-collect local-nfc-stamp reminder-runner
```
✅ After this, everything works **except** the two "Add to Wallet" buttons.

---

## Part 2 · Apple Wallet

### 2a · Register the Pass Type ID *(skip if already registered)*
1. developer.apple.com → **Certificates, Identifiers & Profiles** → **Identifiers** → **＋**
2. **Pass Type IDs** → Identifier `pass.com.oneshetland.app`, any description → **Register**.

### 2b · Create the signing certificate
1. On your Mac: **Keychain Access → Certificate Assistant → Request a Certificate
   From a Certificate Authority** → your email + a name → **Saved to disk** →
   save `OneShetland.certSigningRequest`.
2. Portal: **Identifiers** → `pass.com.oneshetland.app` → **Pass Type ID Certificate**
   → **Create Certificate** → upload the CSR → **Download** → `pass.cer`.

### 2c · Export the `.p12`
1. Double-click `pass.cer` (imports into Keychain, paired with your CSR's private key).
2. Keychain Access → **login** keychain → **My Certificates** → expand the
   "Pass Type ID: pass.com.oneshetland.app" entry so the **certificate + private key**
   both show.
3. Select **both** → right-click → **Export 2 items…** → save `pass_certificate.p12`
   → set an **export password** (this becomes `APPLE_PASS_CERT_PASSWORD`).

### 2d · Get the WWDR G4 cert
```bash
# download it first: https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer
openssl x509 -inform der -in ~/Downloads/AppleWWDRCAG4.cer -out wwdr.pem
head -1 wwdr.pem     # expect: -----BEGIN CERTIFICATE-----
```

### 2e · Set secrets + deploy
```bash
base64 -i pass_certificate.p12 -o pass_cert.b64

supabase secrets set APPLE_PASS_CERT_P12_BASE64="$(cat pass_cert.b64)"
supabase secrets set APPLE_PASS_CERT_PASSWORD="<the export password from 2c>"
supabase secrets set APPLE_WWDR_PEM="$(cat wwdr.pem)"

supabase functions deploy apple-wallet-pass
```

Reference values (public, already baked into the code):
- Pass Type ID: `pass.com.oneshetland.app`
- Team ID: `4D33WNWW9F`

---

## Part 3 · Google Wallet
```bash
supabase secrets set GOOGLE_WALLET_SA_JSON="$(cat your-service-account.json)"
supabase functions deploy google-wallet-pass
```
Then two one-time Console steps at https://pay.google.com/business/console:
1. Your issuer → **Users** → add the service-account **email** (`client_email` in the
   JSON) so it can issue passes. *(Missing this = permission error.)*
2. Add a **program logo** to the class (needed before passes can go public).

Reference value (public, already in the code): Issuer ID `338800000023174515`.

---

## Part 4 · Ship the app
Web auto-deploys from git pushes; the app needs a new build for testers:
```bash
eas update            # OTA to existing installs (fastest)
# or a full build if native deps changed:
# eas build --profile preview --platform all
```

## Part 5 · Web
Nothing to do — built automatically from `main`. Verify:
- https://oneshetland.netlify.app/loyalty
- https://oneshetland.netlify.app/account/referrals
- https://oneshetland.netlify.app/account/loyalty  (Wallet buttons)

---

## Part 6 · Test checklist
| Test | Where |
|---|---|
| Points earn on a wallet spend; "Redeem £X off" appears | app + web business page |
| Reward ladder shows claimed / ready / to-go rungs | business page (multi-tier card) |
| "Just N more stamps" nudge | loyalty card near completion |
| Referral: enter a code → both get £5 after first spend | `/account/referrals` + app Me → Invite friends |
| Reward-ready / expiry / one-more-stamp push | phone w/ notifications (after cron, ~15 min) |
| Apple Wallet — Add to Apple Wallet | iPhone → My Cards |
| Google Wallet — Add to Google Wallet | Android / desktop → `/account/loyalty` |

**Debugging a Wallet pass:**
```bash
supabase functions logs apple-wallet-pass
supabase functions logs google-wallet-pass
# or open …/functions/v1/apple-wallet-pass?card_id=<id>&debug=1
```

---

## Secrets summary
| Secret | Part | What |
|---|---|---|
| `APPLE_PASS_CERT_P12_BASE64` | 2e | base64 of `pass_certificate.p12` |
| `APPLE_PASS_CERT_PASSWORD` | 2e | the .p12 export password |
| `APPLE_WWDR_PEM` | 2e | Apple WWDR G4 cert, PEM |
| `GOOGLE_WALLET_SA_JSON` | 3 | full service-account JSON key |
