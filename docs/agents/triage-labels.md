# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## All five exist on GitHub

`gh label list` shows all five in this repo's label set, and every ticket in the tracker carries
one of them. Nothing here is a setup step, and the vocabulary is settled: the strings in the table
are the ones already applied to live issues, so editing this column alone would leave the file
naming a label no issue carries.

The four that do not ship with a new GitHub repo were created with the commands below, kept only as
the record of the description and colour each label carries. Do not run them — `gh label create`
fails on a name that already exists, which reads as a broken setup rather than as a label that is
already there.

```sh
gh label create needs-triage    --description "Maintainer needs to evaluate this issue"  --color FBCA04
gh label create needs-info      --description "Waiting on reporter for more information" --color D4C5F9
gh label create ready-for-agent --description "Fully specified, ready for an AFK agent"  --color 0E8A16
gh label create ready-for-human --description "Requires human implementation"            --color 1D76DB
```
