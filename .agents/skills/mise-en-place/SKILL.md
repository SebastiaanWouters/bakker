---
name: mise-en-place
description: "Create prd.json from an initial spec/idea via interview + web research. Triggers on: mise-en-place:, prep my idea, spec this out."
---

# Mise-en-Place

Turn a raw idea or existing spec into a detailed, implementation-ready `prd.json` for ratatouille.

## Trigger Formats

- `mise-en-place: <short idea>`
- `mise-en-place: <file path>` (e.g., `mise-en-place: SPEC.md`)

## Inputs

- **Idea prompt** OR **spec file**
- Optional: existing codebase to inspect for stack + constraints

## Outputs

- `prd.json` (root)

## Workflow

### 1) Intake

1. If user provides a file path, read it. If missing, ask for the correct path.
2. If user provides a prompt, treat it as the seed spec.
3. If a codebase exists, do a **quick scan** for stack + constraints (configs, lockfiles) to avoid redundant questions.

### 2) Interview + Brainstorm

Ask focused questions to fill gaps. Keep it fast and structured. If the user prefers brevity, batch 3-5 questions at a time.

Minimum areas to cover:
- Problem + target users
- Core user flow (start → success)
- Features (must-have vs nice-to-have)
- Non-goals/out of scope
- Tech stack expectations (or confirm detected stack)
- Data model + APIs/integrations
- Security/privacy requirements
- Design direction (if UI)
- Constraints (deadline, budget, compliance)

### 3) Research (Web)

Run targeted web research for:
- Domain-specific standards or best practices
- Chosen stack + library gotchas
- Security/compliance requirements (if applicable)
- Competitive benchmarks or common UX patterns

Summarize key findings (short bullets) and capture sources in `prd.json`.

### 4) Generate `prd.json`

Create a **single, canonical** JSON file in the repo root:

```json
{
  "meta": {
    "title": "",
    "created": "YYYY-MM-DD",
    "updated": "YYYY-MM-DD",
    "source": "mise-en-place",
    "seed": "prompt|file"
  },
  "vision": {
    "problem": "",
    "audience": "",
    "success": ""
  },
  "scope": {
    "in": [""],
    "out": [""]
  },
  "user_flow": [
    "Discovery",
    "Onboarding",
    "Core loop",
    "Exit/return"
  ],
  "features": [
    {
      "id": "F-001",
      "name": "",
      "description": "",
      "inputs": [""],
      "outputs": [""],
      "edge_cases": [""]
    }
  ],
  "requirements": {
    "functional": [""],
    "non_functional": [""]
  },
  "data_model": [
    {
      "entity": "",
      "fields": [""],
      "relationships": [""]
    }
  ],
  "integrations": [
    {
      "name": "",
      "purpose": "",
      "constraints": ""
    }
  ],
  "design": {
    "style": "",
    "references": [""]
  },
  "tech_stack": {
    "frontend": "",
    "backend": "",
    "db": "",
    "auth": "",
    "hosting": "",
    "realtime": "",
    "other": [""]
  },
  "risks": [""],
  "research": [
    {
      "topic": "",
      "summary": "",
      "sources": [""]
    }
  ],
  "tasks": [
    {
      "id": "T-001",
      "title": "",
      "goal": "",
      "scope": "one iteration",
      "acceptance_criteria": [""],
      "tracer_bullet": "thin end-to-end slice",
      "dependencies": [""],
      "status": "todo",
      "notes": ""
    }
  ]
}
```

### 5) Task Decomposition Rules

- Each task must be **one ratatouille iteration**.
- Provide a tracer-bullet path for each task.
- Keep tasks independent where possible.
- Include explicit acceptance criteria.

### 6) Handoff Hint

Finish by telling the user to run ratatouille:
- `ratatouille: prd.json`

## Rules

- Be concise and precise.
- Do not implement code.
- Store everything in `prd.json`.
