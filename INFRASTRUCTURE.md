# FlowForge — Production Infrastructure (AWS)

```
                 ┌──────────────┐
   Internet ───▶│ CloudFront +  │ (static SPA + edge caching)
                 │ S3 (web)     │
                 └──────┬───────┘
                        │ /api/*
                 ┌──────▼───────┐
                 │     ALB      │ (TLS, WAF, rate limit)
                 └──────┬───────┘
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
  ┌──────────┐   ┌──────────┐    ┌─────────────┐
  │  API ECS │   │ API ECS  │ …  │ Worker ECS  │ (autoscaled, separate ASG)
  │ Fargate  │   │ Fargate  │    │   Fargate   │
  └────┬─────┘   └────┬─────┘    └──────┬──────┘
       │              │                  │
       └──────┬───────┴──────────────────┘
              ▼
        ┌───────────────┐    ┌──────────────────┐
        │ RDS Postgres  │◀──▶│ ElastiCache Redis │ (queue + rate limit)
        │ Multi-AZ +    │    └──────────────────┘
        │ read replica  │
        └───────┬───────┘
                ▼
        ┌───────────────┐
        │ S3 (logs)     │ ← long-term run_logs + step output overflow
        │ + Athena      │
        └───────────────┘
```

## Choices and why

- **Fargate, not EC2.** Stateless API + worker. No SSH, no patching, scales per task.
- **Two services, one image.** `api` and `worker` share the container image; entrypoint differs (`server.js` vs `worker.js`). Independent autoscaling: API on RPS, worker on queue depth.
- **RDS Multi-AZ.** Failover < 60s. A read replica serves the dashboard's heavy `runs` queries — write traffic hits the primary only.
- **Redis as queue, not Postgres.** `LISTEN/NOTIFY` works at small scale but doesn't survive worker restarts. BullMQ on ElastiCache gives delayed jobs (cron + retries) and ack semantics.
- **S3 + Athena for logs.** Hot logs in Postgres for 7 days, then a scheduled job tiers to S3 partitioned by `tenant_id/date/`. Athena lets ops query terabytes without paying RDS prices.
- **CloudFront in front of S3** for the SPA. Single global edge cache, automatic gzip/brotli.
- **Secrets** in AWS Secrets Manager, injected at task start via Fargate task role — never in the image.
- **Observability**: OTel SDK in API + worker → AWS Distro for OpenTelemetry → CloudWatch + X-Ray. One trace ID flows: ALB → API → worker → DB.
- **CI/CD**: GitHub Actions builds the image, pushes to ECR, then `aws ecs update-service` with blue/green via CodeDeploy. DB migrations run as a one-shot Fargate task before the new revision is promoted.

## What scales how

| Bottleneck         | Scaling lever                                    |
|--------------------|--------------------------------------------------|
| Dashboard QPS      | API ECS target tracking on CPU + ALB RPS         |
| Workflow throughput| Worker ECS target tracking on Redis queue depth  |
| DB read load       | RDS read replicas; route `SELECT runs ...` there |
| Log volume         | S3 tiering job; Athena for ad-hoc                |
| Realtime fanout    | API hosts a WS layer with Redis pub/sub backplane|

## Cost ballpark (us-east-1, small tenant)

- 2× Fargate API (0.5 vCPU / 1 GB) ≈ $30/mo
- 2× Fargate worker ≈ $30/mo
- RDS db.t4g.medium Multi-AZ ≈ $90/mo
- ElastiCache cache.t4g.small ≈ $25/mo
- S3 + CloudFront ≈ $5/mo
- **Total ≈ $180/mo** before traffic
