# ADR-0002: Customer Experience Shell and Hosted Application

**Status:** Accepted
**Date:** 2026-09-18

## Context

RoamLink's implemented customer/admin/mobile surfaces are currently workspace packages. The customer web package explicitly requires a host. The product therefore has domain capability without a single entry point that lets a normal person discover and navigate the complete experience.

ShareNet demonstrates a useful separation between a quiet consumer shell and an engineering diagnostics surface.

## Decision

Create a hosted RoamLink application shell that:

- wraps the existing presentation packages;
- uses warm-light, low-noise consumer styling;
- exposes persistent connectivity state;
- uses desktop sidebar plus mobile bottom navigation;
- provides lightweight first-run onboarding;
- presents Goals rather than exposing ExperienceIntent as the primary novice concept;
- provides Connectivity and Activity as the primary trust/explanation surfaces;
- keeps admin/diagnostics separate;
- preserves all domain state and evidence distinctions.

The shell is a presentation boundary. It does not acquire domain authority.

## Consequences

Positive:

- a normal user has an actual product entry point;
- the architecture becomes discoverable;
- mobile and desktop navigation become coherent;
- customer UX remains separate from diagnostics.

Constraint:

- the host must not duplicate command semantics already owned by app-kit and domain packages.
