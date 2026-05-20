# OneShetland Delivers

> Community-powered collections and deliveries across Shetland.

A real Expo React Native app (TypeScript + Expo Router + Supabase). This is the MVP foundation — not a mockup.

---

## What's built

| Area | Status |
|------|--------|
| Public landing page with sample runs | ✅ |
| Sign in / Sign up (Supabase Auth) | ✅ |
| Customer dashboard | ✅ |
| Create delivery request (4-step flow) | ✅ |
| Driver dashboard | ✅ |
| Create run flow | ✅ |
| Admin dashboard (placeholder cards) | ✅ |
| Account screen | ✅ |
| Supabase schema + RLS policies | ✅ |
| Seed data (17 regions, 6 categories) | ✅ |

**Not yet built:** Stripe payments, realtime matching, push notifications, saved addresses, driver application form, chat.

---

## Prerequisites

- Node.js 18+
- Expo CLI: `npm install -g expo-cli`
- Expo Go app on your phone (iOS or Android)
- A Supabase project (free tier is fine)

---

## 1. Install dependencies

```bash
cd oneshetland-delivers
npm install
```

---

## 2. Set environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your Supabase credentials:

```
EXPO_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

Find these in your Supabase project:
**Settings → API → Project URL** and **anon public key**.

> The app will run without Supabase configured, but auth and database features will show clear error messages.

---

## 3. Run in Expo Go

```bash
npx expo start
```

Scan the QR code with:
- **iOS:** Camera app
- **Android:** Expo Go app

---

## 4. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → New project
2. Choose a region closest to Shetland (London is fine)
3. Set a strong database password and save it
4. Wait for the project to provision (~1 minute)

---

## 5. Run the SQL migration

In your Supabase project:

1. Go to **SQL Editor** → **New query**
2. Paste the contents of `supabase/migrations/001_initial_schema.sql`
3. Click **Run**
4. Run `supabase/seed.sql` the same way

This creates:
- `profiles` — one per auth user (auto-created on sign-up)
- `driver_profiles` — extended driver data
- `regions` — 17 Shetland regions
- `delivery_categories` — 6 delivery categories
- `runs` — driver runs
- `delivery_requests` — customer requests
- All RLS policies

---

## 6. Create your first admin user

1. Sign up in the app normally
2. In Supabase: **Table Editor → profiles**
3. Find your row and set `role = 'admin'`
4. Sign out and sign back in — you'll land on the admin dashboard

---

## 7. Approve a driver

1. Have the driver sign up normally (they'll land on the driver dashboard)
2. In Supabase: **Table Editor → profiles** → set their `role = 'driver'`
3. **Table Editor → driver_profiles** → insert a row with `id = their profile id` and `driver_status = 'approved'`

> A proper driver application flow (with the in-app apply button) is the next recommended build step.

---

## Project structure

```
app/
  _layout.tsx          Root layout + auth-based redirect
  index.tsx            Public landing page
  account.tsx          Account / profile settings
  (auth)/
    sign-in.tsx
    sign-up.tsx
  (customer)/
    dashboard.tsx
    request/
      step-1.tsx       Category selection
      step-2.tsx       Pickup details
      step-3.tsx       Destination
      step-4.tsx       Review + submit
  (driver)/
    dashboard.tsx
    create-run.tsx
  (admin)/
    dashboard.tsx

lib/
  supabase.ts          Supabase client

types/
  database.ts          TypeScript types for all tables

constants/
  theme.ts             Colours, spacing, typography
  regions.ts           17 Shetland regions
  categories.ts        6 delivery categories

context/
  AuthContext.tsx      Auth state + sign in/up/out
  RequestContext.tsx   4-step request form state

components/ui/
  Button.tsx
  Card.tsx
  Input.tsx
  StatusBadge.tsx      Driver status badge
  ScreenHeader.tsx

supabase/
  migrations/001_initial_schema.sql
  seed.sql
```

---

## Prepare for EAS Build / TestFlight

1. Install EAS CLI: `npm install -g eas-cli`
2. Log in: `eas login`
3. Initialise: `eas build:configure`
4. Build for iOS: `eas build --platform ios`
5. Submit to TestFlight: `eas submit --platform ios`

You'll need an Apple Developer account ($99/year) and your Supabase env vars set as EAS secrets:

```bash
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value "https://..."
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "..."
```

---

## Design

| Token | Value |
|-------|-------|
| Primary navy | `#032F4C` |
| Delivery accent | `#12B3D6` |
| Background | `#F5F7FA` |
| Error | `#EF4444` |
| Success | `#10B981` |

---

## Recommended next build steps

1. **Driver application flow** — in-app form that creates a `driver_profiles` row with `status = 'pending'`
2. **Admin driver approvals screen** — list pending applications, approve/reject with a button
3. **Run matching** — when a customer submits a request, auto-match to available open runs by region
4. **Date/time picker** — replace text inputs in create-run with a proper `@react-native-community/datetimepicker`
5. **Push notifications** — Expo Notifications when a run is matched or a request is picked up
6. **Stripe payments** — pricing model, customer payment, driver payout
7. **Saved addresses** — customer address book for repeat deliveries
8. **Real-time run list** — Supabase Realtime subscription on the landing page

---

## What we do NOT carry

- Alcohol, tobacco, or vapes
- Cash or cheques
- Passengers or taxi services
- Live animals
- Anything requiring a courier licence

---

*Built with Expo, Expo Router, TypeScript, and Supabase.*
