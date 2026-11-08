---
name: cv-review-rubric
description: Scoring rubric and report format for critiquing a CV against a specific job advert and the CV preferences. Use for every CV review so scores are consistent between reviews.
---

# CV review rubric

## Procedure
1. `readJob`: extract the must-have and nice-to-have requirements and key terms.
2. `readPreferences`: note `language`, `maxPages`, `tone`, `sectionOrder`, `emphasise`, `exclude`.
3. `readCV`: note the reported `pages` and `words`.
4. Score each criterion below from 0–10, then compute the weighted total with `evalMath`
   (e.g. `round((8*0.3 + 7*0.25 + 9*0.15 + 6*0.15 + 8*0.15), 1)`).

## Criteria and weights
| Criterion | Weight | 9–10 looks like |
|---|---|---|
| Relevance & keyword coverage | 30% | Every must-have requirement is visibly evidenced near the top, using the advert's terms |
| Impact & evidence | 25% | Bullets show action + scope + result; numbers where plausible; no duty lists |
| Clarity & concision | 15% | Scannable in 10 seconds; one-line bullets; no filler or clichés |
| Structure & ATS-friendliness | 15% | Standard headings, single column, consistent dates, real text, logical order |
| Preferences & polish | 15% | Within `maxPages`, spelling variant matches `language`, consistent tense/punctuation, tone fits |

Automatic flags (list under **High** regardless of score):
- Page count above `maxPages`, or an almost-empty last page.
- Claims that look fabricated, inconsistent (overlapping dates, changing titles) or unverifiable superlatives.
- Missing contact details or the candidate's name.
- Content listed in `exclude`, or sections ignoring `sectionOrder` without reason.

## Report format
```
Score: 7.4/10 — <one-line verdict>

High
- [Experience › Northwind, bullet 2] Problem → concrete fix (suggest wording when useful)

Medium
- …

Low
- …

Working well
- …
```
Rules: at most 10 issues in total, most impactful first; always point to a location; suggested wording must
not add facts that are not already in the CV.
