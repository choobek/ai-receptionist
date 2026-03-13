# Knowledge Base

This proof-of-concept knowledge base is derived from the following source files provided outside the repo:

- `/home/choobek/Downloads/konsultacja.odt`
- `/home/choobek/Downloads/implanty.odt`
- `/home/choobek/Downloads/all-on-4.odt`
- `/home/choobek/Downloads/protetyka.odt`

## What is stored in the repo

- Curated knowledge entries: [`knowledge-base/clinic-knowledge.json`](../knowledge-base/clinic-knowledge.json)
- Search tool workflow: [`n8n/workflows/tool_search-knowledge-base.json`](../n8n/workflows/tool_search-knowledge-base.json)
- Tool schemas:
  - [`schemas/searchKnowledgeBase.request.json`](../schemas/searchKnowledgeBase.request.json)
  - [`schemas/searchKnowledgeBase.response.json`](../schemas/searchKnowledgeBase.response.json)

## Scope

The current KB covers:

- consultation flow and diagnostics
- implant types and treatment paths
- All-on-4 overview
- veneers versus bonding

It does not replace medical judgment and should be used only for:

- general non-diagnostic clinic questions
- organizational explanations of treatments
- high-level explanations already present in the provided source material

## Current limitations

- Retrieval is keyword-based, not embedding-based.
- The search tool only knows the curated entries committed in this repo.
- If the question is outside the curated scope, the assistant should say it does not have a reliable KB answer and, when appropriate, create a receptionist follow-up task.

## Updating the KB

When new clinic materials arrive:

1. Extract and review the source text.
2. Add or revise curated entries in [`knowledge-base/clinic-knowledge.json`](../knowledge-base/clinic-knowledge.json).
3. Mirror the dataset in the `Search KB` Code node inside [`n8n/workflows/tool_search-knowledge-base.json`](../n8n/workflows/tool_search-knowledge-base.json).
4. Re-test the direct KB webhook and the assistant prompt behavior.
