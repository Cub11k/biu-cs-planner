# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: single-context.** One `CONTEXT.md` and one `docs/adr/` at the repo root. There is no
`CONTEXT-MAP.md` and no per-package context; this is a single-package repo.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the domain glossary.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.
- **`docs/design.md`**: the agreed design, the next step, the build order, deferred items and open facts.
- **`docs/research/`**: existing findings on BIU data sources, distribution options and shortcuts. Check here before researching those again.

The last two are specific to this repo; `CLAUDE.md` already treats them as required reading, so a
skill that reads only the glossary and the ADRs would miss the agreed design.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CLAUDE.md
├── CONTEXT.md
├── docs/
│   ├── design.md
│   ├── adr/
│   │   ├── 0001-npm-package-served-on-localhost.md
│   │   └── …
│   ├── agents/
│   └── research/
└── prototypes/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids — it records an _Avoid_ list per term, and those are the near-misses to stay off.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (requirements are interpreted data), but worth reopening because…_
