# Decision records

Each record (S1–S19) settles one question: a spike, a plan, what was built. They're references: read the section
AGENTS.md's table points to, not the whole file.

## From S20 on: a folder, not one growing file

S15, S17 and S18 grew to 150–190 KB each, as every slice added its plan, its review findings and its *as built*
notes to the same file. A new record is a small folder instead:

```
docs/decisions/S20-<name>/
  plan.md               the question, the options, the decision and the slices
  threat-checklist.md   what could go wrong, before the design (when the record touches agents, passwords, IPC,
                        sessions, or anything web content can reach)
  as-built.md           what each slice built and found, newest first
```

Add a file when a record needs one (`open-questions.md`, a spike's `evidence.md`), and keep each one short enough to
read whole. The records up to S19 stay as they are.
