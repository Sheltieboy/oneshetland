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
| `wallet-launch-reconciliation` | two concurrent reconciliations must produce one adjustment |
| `booking-metering` | two workers must race for the same booking, and the monthly cap must hold across them |
| `stripe-idempotency` | webhook replay is only meaningful against committed event rows |
| `ticket-redemption` | concurrent scans of one ticket must yield one check-in |
| `ai-route-security` | the quota is counted from committed `ai_usage` rows |

`npm run test:all` runs both.

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
