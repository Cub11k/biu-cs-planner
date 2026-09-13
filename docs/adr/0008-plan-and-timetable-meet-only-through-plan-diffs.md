# Plan and Timetable are independent and meet only through Plan Diffs

The Plan spans years with no Catalog yet, so it is checked only against Requirements Files and their Offering Patterns. A Timetable covers the current year, so it is checked only against that year's Catalog. Catalogs often contradict the Plan: a Course moves Semester, disappears, or every Group combination Clashes.

We therefore never sync the two automatically. Divergences show as Plan Diffs, each with an explicit "apply to Plan", and a Timetable works with no Plan at all.

## Considered Options

- **Two-way live sync:** would silently rewrite the Plan while the student experiments with Variants.
- **Deriving the current year's Plan from the Timetable:** would make the Plan depend on Catalog data it was meant to be independent of.
