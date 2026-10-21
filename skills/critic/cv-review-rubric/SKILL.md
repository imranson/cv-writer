---
name: cv-review-rubric
description: Weighted rubric for scoring a CV against a specific job posting, with severity rules and an output format. Use whenever asked to review, score or critique a CV.
---

# CV review rubric

Score the CV out of 10 using the weighted criteria below, then report issues ranked by severity. Always read both the CV (`readCV`) and the job (`readJob` with the jobId) first.

## Step 1: fact-check against the profile

The user's profile is in your brief. Before scoring, go through the CV line by line (header, summary, every bullet, skills) and find the profile text that supports each claim. Extra detail attached to a true fact is unsupported too: a method ("through pair programming"), an outcome ("ensuring 99% uptime"), a tool or data source not listed for that role, or a duration the dates do not prove.

List every unsupported phrase under "Unsupported claims" and as a **high** issue. A CV with unsupported claims scores at most 5/10, however well written.

## Criteria and weights

| Criterion | Weight | What good looks like |
|---|---|---|
| Relevance to the posting | 3 | The top third of page one speaks directly to the posting's main requirements. |
| Evidence and impact | 2 | Bullets show outcomes, with numbers where the profile has them. |
| Keyword coverage (ATS) | 2 | Must-have terms from the posting appear verbatim where truthful. |
| Structure and scannability | 1 | Standard headings, reverse chronology, consistent dates, no layout tables. |
| Length vs preference | 1 | Within `maxPages` (≈450-550 words per A4 page with the default CSS). |
| Language and tone | 1 | Matches `tone` and `language` preferences; consistent tense; no typos. |

Score each criterion 0-10, compute the weighted average with `evalMath`, and round to one decimal.

## Extracting keywords

From the job description, list must-have skills, tools, certifications and domain terms (usually in "Requirements"/"You will have"). A keyword is covered only if it appears in the CV text or as a clear synonym.

## Severity

- **high**: would likely cause rejection or mislead — any claim not supported by the profile, missing must-have keyword the profile supports, wrong or missing contact details, over the page limit, factual inconsistency (dates overlap, title mismatch).
- **medium**: weakens the case — vague bullets without outcomes, relevant experience buried below less relevant content, inconsistent tense.
- **low**: polish — wording, punctuation, minor formatting.

## Rules

- Quote the exact CV text each fix applies to, so the writer can use `editCV` edits.
- Never suggest adding facts that are not evidenced; instead write "Ask the user: …".
- Keep the whole critique under ~350 words.
