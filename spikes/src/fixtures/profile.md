# Jordan Rivera — Senior Backend Engineer
(Fictional candidate used only for Phase 0 benchmarks.)

Location: Austin, TX · 10 years of professional experience

## Summary
Backend engineer focused on high-throughput, event-driven systems, reliability, and developer tooling. Tech lead for squads of 4–6 engineers. Strongest in TypeScript/Node.js, Go, PostgreSQL, Kafka, and AWS.

## Experience

### Quayside Logistics — Senior Software Engineer, Platform (Mar 2021 – present)
- Led the redesign of the shipment-event pipeline from a cron-based batch system to Kafka streaming on AWS MSK; cut tracking-update latency from about 15 minutes to under 5 seconds.
- The pipeline handles roughly 40,000 events per second at holiday peak and held 99.95% availability across 2023–2024.
- Introduced idempotent consumers and a transactional outbox in PostgreSQL; duplicate customer notifications dropped by 97%.
- Ran the incident review program; led the response to the November 2022 Black Friday consumer-lag incident (about 6 hours of delayed tracking updates).
- Tech lead for a 5-person squad; mentored 3 engineers to promotion.
- Built "Replay", an internal tool that replays production Kafka topics into staging for load tests.
- Stack: TypeScript (Node.js), Go, Kafka (AWS MSK), PostgreSQL, Redis, AWS ECS on Fargate, Terraform, Datadog.

### Tallgrass Health — Software Engineer II, promoted to Senior (Jun 2017 – Feb 2021)
- Built the appointment-scheduling API (Node.js, Express, PostgreSQL) used by 120 clinics; brought p95 latency from 900 ms to 180 ms through query tuning and caching.
- Implemented HIPAA audit logging; passed two external audits with zero findings in the logging scope.
- Moved monolith billing jobs to AWS Lambda and SQS, cutting that workload's infrastructure cost by about 30%.
- Led the on-call rotation and wrote the runbook template the team still uses.

### Pinecrest Labs — Junior Software Engineer (Jul 2015 – May 2017)
- Ruby on Rails and React for a B2B survey product; built a CSV importer that handled 1-million-row files.
- Moved deployments from manual scripts to Jenkins pipelines.

## Projects
- openslo-lint (open source, Go): a CLI that validates SLO definition files; about 600 GitHub stars.
- Replay (internal, Quayside): Kafka topic replay into staging for load and regression tests.

## Skills
- Languages: TypeScript, Go, SQL, Python (scripting), Ruby (not recent)
- Data and streaming: Kafka, PostgreSQL, Redis, SQS
- Cloud and infrastructure: AWS (ECS Fargate, MSK, Lambda, RDS), Terraform, Docker, GitHub Actions
- Observability: Datadog, OpenTelemetry, Prometheus, Grafana

## Education
B.S. Computer Science, University of Texas at Austin, 2015

## Certifications
AWS Certified Solutions Architect – Associate (2022)
