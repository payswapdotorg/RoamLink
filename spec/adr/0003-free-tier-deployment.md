# ADR-0003: Early Free-Tier Deployment Stack

**Status:** Accepted
**Date:** 2026-09-18

## Decision

For development, demo and early validation deployment, use:

- Vercel for the hosted web/runtime surface;
- Neon Postgres for relational persistence;
- Upstash Redis for bounded ephemeral coordination;
- Upstash QStash for retryable asynchronous delivery;
- Cloudflare R2 for object storage.

These providers are adapters, not architecture authorities.

## Constraints

Vercel Hobby is explicitly treated as a non-commercial/demo environment under current Vercel terms.

Neon is the durable relational authority.

Redis is never the durable source of truth.

QStash is a delivery mechanism, not the source of business state.

R2 is object storage, not relational state.

## Migration rule

Each provider is accessed through a RoamLink port.

A later provider replacement must preserve the same contract tests.

## Operational rule

Free-tier limits must never compromise correctness. High-frequency work must be event-driven where scheduled-job limits are too coarse, and any commercial launch must move off plans whose terms do not permit the intended use.
