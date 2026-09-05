# Test suites

`npm test` is the **routine** suite. Everything it does against the linked
production project is either read-only or wrapped in a transaction that is
never committed, so running it does not create, alter or remove a single real
application row.

`npm run test:fixtures` is the **committed-fixture** suite. Its tests build real
rows in production and remove them again in `after()`, because what they prove
cannot be proved any other way:

| Suite | Why it must commit |
|---|---|
| `wallet-attempts` | two independent connections have to contend over the same wallet, and a rolled-back transaction is invisible to the other connection |
| `wallet-integrity` | same: concurrent debits against one balance |
| `booking-metering` | two workers must race for the same booking, and the monthly cap must hold across them |
| `stripe-idempotency` | webhook replay is only meaningful against committed event rows |
| `ticket-redemption` | concurrent scans of one ticket must yield one check-in |
| `ai-route-security` | the quota is counted from committed `ai_usage` rows |

`npm run test:all` runs both.

`npm run test:isolated` is the **isolated-database** suite. It provisions a
throwaway PostgreSQL 17 cluster in the OS temp directory, listening on a unix
socket inside its own data directory — no TCP port, nothing shared, destroyed in
a `finally`. It exists for invariants that only two competing connections can
prove, where a rolled-back transaction is invisible to the other side and a
committed fixture would mean writing to production.

| Suite | Why it needs its own database |
|---|---|
| `pass-redemption-concurrency` | two tills spending one pass; the loser must block on a real row lock, and proving a lost update means committing |
| `hub-column-privacy` | a privilege boundary can only be proved by running as anon and being refused; it also installs the OLD grants first and demonstrates the leak, so the fix is measured against the defect |
| `hub-member-number-concurrency` | two first-time joins must contend for one allocation; it installs the CURRENT function first and reproduces two member 1s, so the fix is measured against the defect rather than an assumption |

It needs `postgresql@17` installed locally, so it is deliberately **not** part of
`test:all` — the routine gate must not depend on a local database server. Run it
when redemption, locking or `redeem_pass_atomic` changes, and before a launch
gate.

The schema is not hand-written. Table definitions come out of the real
migrations at run time, and every migration that defines `redeem_pass_atomic` is
replayed in order, exactly as production got its current definition — so the
proof cannot drift away from the function it claims to test. That matters: the
function is defined twice, and pinning the first file would have proved a
version that could never match a token.

`booking-capacity-concurrency` is the other isolated-database suite. It is not
in this lane yet because it expects the full schema rather than building its
own, and still runs via `BOOKING_PROOF_DSN` against a database you supply.

## Why the split exists

The fixture suite creates rows in `local_businesses`, `book_bookings`,
`events`, `event_tickets`, `local_wallet_balances` and others. During Step 12 a
wallet holding £100 appeared, dropped to £50 and vanished mid-audit — real
transient production state produced by `wallet-attempts` seeding a spare
profile. It was diagnosed as a possible live customer incident before the test
suite was identified as the cause, and fixture cleanup had already gone wrong
twice in earlier steps, leaving stray rows behind.

None of that is a reason to weaken the concurrency tests — they catch real
bugs, including a cap breach in Step 11 and a double-claim in Step 6B. It is a
reason not to run them by reflex. Routine work runs `npm test`; the fixture
suite is run deliberately, when its guarantees are what you are checking.

Each fixture suite asserts its own teardown, so a leak fails the test rather
than being left for somebody to find.
