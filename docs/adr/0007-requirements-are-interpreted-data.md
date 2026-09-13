# Requirements are data, interpreted by a fixed vocabulary

Degree rules change per Program and Cohort, so they live in Requirements Files that a fixed engine interprets, never in engine code.

- **Vocabulary:** all-of, N-of, credits from a Pool, cap, exclusive, Equivalence, Prerequisite, Offering Pattern, policies. Anything it cannot express becomes a Manual Requirement carrying its original text, so data never blocks the engine.
- **Safety:** the engine executes nothing from data, including regular expressions (Pools match by prefix or range). This keeps files from other people safe to import.
- **Authoring:** a maintainer writes Requirements Files by hand, with JSON Schema support, from the department's PDF and Excel publications.

## Considered Options

- **PDF and Excel importers in the app:** extracting text from Hebrew PDFs often reverses word order and breaks tables apart, and the Prerequisite wording ("all first-year Courses", "with lecturer approval") would need natural-language parsing on top.
- **Form-based Requirement editor:** deferred until the vocabulary has proven itself on real data.
