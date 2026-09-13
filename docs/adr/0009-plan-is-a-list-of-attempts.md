# The Plan is a list of Attempts

There is no separate plan object. The State File holds Attempts, each placing a Course in a Semester with a status (planned, registered, passed, failed, exempt, credited) and an optional grade. The Plan is simply those Attempts laid out across Semesters, so history and future live in one structure. Progress, Prerequisite checks and the Plan screen all read the same data, and planned Attempts become real ones by changing status. A retake is another Attempt. An exemption is an Attempt with the `exempt` status rather than its own concept.

## Consequences

Minimum-grade Prerequisites must choose between the best and the latest passing Attempt. This is a policy in the Requirements File rather than hard-coded, because the actual BIU rule is not yet confirmed.
