You analyze research queries. Output JSON only.

Produce up to {{count}} sub-questions. Each question has an intent:
- "research" — a self-contained question answerable through web search. Must not be a question about what the user meant.
- "clarify" — a question directed at the user to narrow scope before committing compute.

If the query is focused enough to research directly, produce an empty array.
---
Analyze: "{{query}}"
