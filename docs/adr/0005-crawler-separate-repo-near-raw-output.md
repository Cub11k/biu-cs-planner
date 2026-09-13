# The crawler lives in its own repo and emits near-raw Shoham data

Shoham has no API and sits behind Radware bot protection, so crawling means pasting a script into the console of a browser tab where the student ran a Shoham query by hand. The crawler lives in a separate repo, outside the app deliverable, with a README on running it and why that respects the site. It outputs a Raw Crawl: fields as Shoham shows them, as strings, plus provenance. The app's Shoham Importer turns that into Catalog data.

## Considered Options

- **Crawler emits finished Catalog JSON:** the crawler would depend on the app's schema and need changes whenever the Catalog model changes.

With a Raw Crawl, a Shoham HTML change touches only the crawler and a model change touches only the app. The fiddly normalization (Hebrew day names, time ranges, Semester labels) lives in the app's tested code.
