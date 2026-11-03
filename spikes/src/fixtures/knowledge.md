# Application Knowledge (fictional, for Phase 0 benchmarks)

## Answer instructions
- Sound calm and confident, not salesy. Keep it conversational.
- Weakness: I used to over-own incidents and not delegate. Since 2023 I rotate the incident-commander role and coach others through it.
- Salary: try not to give a number first; ask about their range. If pushed, my target base is $185k–$205k, so say "around 195 base, flexible depending on equity."
- Don't bring up the 2020 Tallgrass layoffs unless asked directly.

## Facts not in the resume
- Why I'm leaving Quayside: the platform work is now mostly maintenance. I want to work on payments infrastructure where correctness really matters, and Kestrel Pay's ledger work is exactly that.
- Kafka vs RabbitMQ at Quayside: we needed replay for reprocessing, per-shipment ordering via partition keys, 7-day retention, and several downstream teams reading the same stream through separate consumer groups. RabbitMQ was simpler to operate but didn't give us replay. We chose MSK so we didn't have to run brokers ourselves.
- Black Friday 2022 incident: a consumer deploy added a synchronous call to the address-validation service inside the hot loop. When that service slowed down, consumer lag grew to about 2 hours. We rolled back and scaled consumers. Afterward: lag alerts at 2 minutes, enrichment made asynchronous behind a circuit breaker, and a Replay load test added to the release checklist.
- Disagreement story: a staff engineer wanted the notifications service to read the shared database; I argued for consuming events. We ran a one-week spike of both and wrote a short decision doc with the numbers. We went with events, the relationship stayed good, and that engineer later sponsored my promotion case.
- Kubernetes: I have NOT run Kubernetes in production. Only local experiments with kind. I'm comfortable with containers through ECS and expect to ramp up quickly.
- Memory leak debugging: at Tallgrass I found a leak in the scheduling API caused by an unbounded in-memory cache. I used heap snapshots (node --inspect with Chrome DevTools) and clinic.js, fixed it with a size-bounded LRU cache with TTL, and added memory-growth alerts.
- Five-year goal: staff-level engineer owning reliability for a core money-movement system, and mentoring.
- Questions I want to ask them: how they handle ledger reconciliation, what on-call load looks like, and how they'd measure success in my first six months.

## Target company
- Kestrel Pay: Series C fintech offering a B2B payouts API. Go and TypeScript. About 12 engineers in two squads.
- Role: Senior Backend Engineer, Ledger team.
