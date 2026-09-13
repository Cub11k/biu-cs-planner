# BIU data sources

Researched 2026-09-11 by a web research agent. **For the grid and detail pages, prefer
[`shoham-raw-shape.md`](shoham-raw-shape.md)**: it was read off a real crawl rather than
Wayback snapshots, and supersedes this file wherever the two disagree.

Researched 2026-09-11 by a web research agent. Most BIU hosts sat behind Radware bot protection that blocked automated fetches, so statements about Shoham's page structure come from Wayback Machine snapshots (2021–2023). Treat them as likely, not confirmed. `cs.biu.ac.il` fetched normally.

## Shoham course catalog (Catalog source)

- **URLs:** `https://shoham.biu.ac.il/BiuCoursesViewer/MainPage.aspx`, English version `ENMainPage.aspx`. Public, no login. It is the "קטלוג הקורסים" the CS department links to.
- **Technology:** classic ASP.NET WebForms. Searches and paging are form postbacks that carry hidden state fields, not clean URLs.
- **Search form:**
  - year: the value is the Gregorian year the Academic Year ends in (2023 = תשפ"ג)
  - department dropdown: CS = `84`, which does **not** match the `89-` course prefix
  - Hebrew name, English name, course code, lecturer, day checkboxes, from/to hour, language
- **Results page:** `CoursesView.aspx`, an HTML table with course, name, department, Group (קבוצה), lecturer, Lesson Type (הרצאה/תרגיל), Semester, day and hours.
  - It shows a count ("38 קורסים ברשימה") and pages by postback.
  - Course codes appear without a hyphen ("43062").
  - Some query parameters exist (`?dcode=43`, `?iyear=2022&fcode=…`); their meaning is inferred.
- **Detail page:** `CourseDetails.aspx?lid=<internal id>`, keyed by an internal id, not the course number. Shown as course plus Group ("99665-06"). Fields:
  - English name, department, faculty, Lesson Type, lecturer
  - Semester and weekly hours, credits (ניקוד), note, day, time
  - Exam dates and times for מועד א/ב/ג
  - syllabus link (`CourseSylabusView.aspx`)
  - Rooms are marked as not final. Prerequisites are **not** shown.
- **Consequence:** getting credits and Exams needs one extra request per Course's detail page.

## Inbar (personal portal)

`https://inbar.biu.ac.il/Live/Login.aspx` handles registration, personal timetable and grades. It requires login (username + mobile, or SSO), loads Google reCAPTCHA, and is also ASP.NET WebForms. It is not used as a source. It could later serve to import completed Courses from a logged-in session.

## CS department: requirements and Prerequisites

- **Index:** `https://cs.biu.ac.il/he/Yedion` lists only the current year's programs (תשפ"ז at research time):
  - single major `/he/node/575`
  - AI track `/he/node/576`
  - double majors `/he/node/577`–`581`

  Each program is an HTML table page plus a downloadable Excel file. Older years were PDFs, and the index no longer seems to link them.
- **Start tracks:** starting in Semester A is track 89101; starting in Semester B is 89103.
- **Prerequisites PDF:** `https://cs.biu.ac.il/sites/cs/files/shared/דרישות-קדם-תשפז_7.pdf`, columns course number, name, requirements. The wording a converter must handle:
  - "כל קורסי שנה א'" (all first-year Courses)
  - "במקביל:" (concurrent allowed)
  - "בציון 80" (minimum grade)
  - "באישור מרצה" (lecturer approval)
- **Department regulations:** `https://cs.biu.ac.il/sites/cs/files/shared/תקנון-תואר-ראשון-תשפו.pdf`
  - passing grade 60
  - only `89-` Courses count toward the degree
  - Prerequisites carry over indirectly (A→B→C means A is required for C)
  - no overlapping mandatory Courses, except up to 4 hours for double majors
  - progression deadlines
- **Single major structure, תשפ"ז (129 credits):**
  - **Year 1:** 89-110, 112, 113, 132, 133, 1195, 1200, 1262, 230
  - **Year 2:** 89-213, 220, 263, 1111, 2197, 2511, 231, 2226
  - **Year 3:** 89-2322, 89-385 (project workshop), a seminar (89-4XX)
  - **Cluster 1:** 3 of 3210, 3311, 3312, 5581
  - **Cluster 2:** 2 of 5509, 5570, 5656
  - **Completion cluster:** 10 hours
  - **AI track:** 14 hours from an AI cluster
- **General requirements:**
  - English: students scoring 134+ take 2 English-taught content Courses (89-390 counts)
  - Hebrew expression is required
  - Jewish studies (עולמות/יסוד): generally 20 credits for BA/BSc, but the exact CS figure is unconfirmed. `yesod.biu.ac.il` redirects to `olamot.biu.ac.il`, which blocked the agent.

The app stays data-agnostic; these facts inform the vocabulary and test fixtures, not code.

## Academic calendar and numbering

- **2026-27:** Semester A runs 11.10.2026–17.1.2027, Semester B 1.3–25.6.2027, Summer 15.8–24.9.2027. Exam periods fall between Semesters.
- **Numbering:** CS course numbers are `89-` plus 3 or 4 digits. Groups are two digits.

## Scraping risks

- **Radware:** it challenges non-browser clients. A console script running in a real browser tab, after a manual query, is the workable approach.
- **Postbacks:** the crawler must submit hidden form state or drive the page's own JavaScript.
- **Internal ids:** detail pages are keyed by internal ids, so collect them from result links.
- **Mismatched codes:** department dropdown values differ from course prefixes.
- **Prerequisites:** they exist only in the department PDF.
