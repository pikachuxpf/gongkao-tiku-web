# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Vite + vanilla JavaScript, with build-time Markdown parsing and browser localStorage for portability and low maintenance overhead.

## Users

The primary user is an individual civil-service or public-institution exam candidate who practices essay and integrated-ability questions repeatedly on a desktop or mobile browser.

## Product Purpose

Turn the repository's Markdown question bank into a focused practice workspace. The product must make it easy to discover questions, write answers, reveal reference materials, track mistakes and favorites, and optionally use an OpenAI-compatible model for scoring and coaching.

## Positioning

The product keeps the source question files as the canonical content layer and derives a small browser-ready index from them. New Markdown questions can be added without changing UI code.

## Operating Context

The user practices in short sessions, switches between question types, revisits weak questions, and reads reference answers and worked solutions after submitting. Personal practice state is stored locally in the browser. Model keys are user-provided and remain in local storage.

## Capabilities and Constraints

- Support the existing 4,886-question 申论/综应 Markdown bank and future incremental additions.
- Support subjective answers with local quick scoring and optional OpenAI-compatible model scoring, feedback and rewrite suggestions.
- Support multiple-choice data when it is added to the source bank, including answer reveal and optional model explanation.
- Avoid a mandatory backend or database for the portable first version.
- Treat the original source files and their rights/usage constraints as preserved content.

## Brand Commitments

The user requested a hand-drawn study-desk style. The interface uses Chinese copy, ink-like rules, paper surfaces and annotation accents while keeping controls readable and exam-work focused.

## Evidence on Hand

- `申论题库/` and `综应题库/` contain the source Markdown questions.
- `智能系统/` contains question-type patterns, a vocabulary bank, topic notes, a JSONL index, scoring criteria and LLM prompt templates.
- No existing runnable web UI was present at the start of this build.

## Product Principles

1. Practice first: the next useful action is always visible.
2. Source truth: reference materials come from the repository, not fabricated UI copy.
3. Local by default: progress works without an account or server.
4. Feedback over decoration: model features should return an actionable score or edit suggestion.
5. Portable data: adding a Markdown question is the smallest sustainable content workflow.
