# AI Receptionist — Vapi + n8n

AI voice receptionist project built with **Vapi** for conversation handling and **n8n** for backend automation.

This repository is the **source of truth** for prompts, tool contracts, architecture notes, exported n8n workflows, and deployment documentation.

---

## Overview

The assistant answers phone calls, talks naturally with the caller, and performs business actions through backend tools.

### Responsibilities

- **Vapi**
  - voice conversation
  - assistant prompt
  - first message
  - tool calling
  - optional knowledge base
  - optional call workflow logic

- **n8n**
  - receives tool requests from Vapi
  - validates and normalizes input
  - talks to external services
  - checks appointment availability
  - creates calendar events
  - sends logs, notifications, summaries

- **Google Calendar / external systems**
  - appointment storage
  - internal availability source
  - optional CRM / Slack / email integrations

---

## Architecture

```text
Caller
  -> Vapi Assistant
      -> Tool: checkAvailability -> n8n webhook -> Google Calendar -> response
      -> Tool: createEvent       -> n8n webhook -> Google Calendar -> response
      -> optional later: Server URL -> n8n -> logging / analytics / routing
