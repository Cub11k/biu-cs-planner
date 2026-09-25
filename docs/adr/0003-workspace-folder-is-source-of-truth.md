# A Workspace folder of JSON files is the source of truth

All data (Catalogs, Requirements Files, State Files) lives as JSON files in a Workspace folder on disk. The browser stores no data: only the Launch Token and Device Preferences, neither of which is data about a student's plan — [ADR-0014](0014-where-a-preference-is-kept.md) rules where a preference is kept. Importing a new year's data means putting a file into the Workspace, so the app works for any year without rebuilding or reinstalling, and the data survives browser resets and can be copied or synced like any folder.

## Consequences

- Every edit autosaves, so the app has to protect against lost work:
  - undo/redo within the session
  - rotating backups in `.backups/` inside the Workspace, so wiping the folder wipes everything
  - version-checked saves that refuse to overwrite a file changed externally (Dropbox, git, an editor)
- The server watches the Workspace folder rather than individual files, because editors save by writing a new file and renaming it, which breaks watches on single files.
