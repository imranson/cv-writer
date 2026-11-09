---
name: cv-review-rubric
description: Weighted scoring rubric and checklist for reviewing a CV against a specific job and its preferences, producing a calibrated score out of 10 and prioritised, concrete fixes. Use whenever asked to review, score or critique a CV.
---

# CV review rubric

## Procedure
1. `readJob` — extract the top requirements and keywords.
2. `readPreferences` — note maxPages, tone, language, sections, emphasis, avoid.
3. `readCV` — note `pages` and `words`, then read the HTML.
4. Score each criterion 0–10, compute the weighted total with `evalMath`, round to one decimal.

## Criteria and weights
| # | Criterion | Weight | 10 looks like |
|---|-----------|--------|---------------|
| 1 | Job relevance | 0.30 | Top requirements evidenced in the top third of page 1; keywords mirrored truthfully |
| 2 | Impact & evidence | 0.20 | Most bullets show outcomes with numbers or clear scope |
| 3 | Clarity & concision | 0.15 | Scannable in 10 seconds; no filler, clichés or walls of text |
| 4 | ATS compatibility | 0.10 | Standard headings, single column, real text, consistent dates |
| 5 | Preference compliance | 0.15 | Within maxPages (use `pages`), requested tone, language, section order, emphasis honoured, "avoid" items absent |
| 6 | Correctness | 0.10 | No typos, consistent tense and formatting, no date overlaps/gaps unexplained |

Example: `evalMath { "expression": "round(0.30*7 + 0.20*6 + 0.15*8 + 0.10*9 + 0.15*10 + 0.10*8, 1)" }`.

Calibration: 9–10 ready to send; 7–8 good with minor fixes; 5–6 needs a revision round; below 5 needs a rewrite.

## Automatic must-fix triggers
- Over `maxPages`, or the last page less than ~25% filled.
- A top-3 job requirement with no visible evidence (flag as missing info if the CV can't show it).
- Placeholder text, empty sections, broken structure, or contact details missing.
- Wrong language/spelling variant for `preferences.language`.

## Writing the critique
- Quote the exact phrase, then give the rewrite: `"Responsible for reports" → "Built weekly KPI reports used by 4 regional directors (Power BI)"`.
- Order must-fix items by impact on the score.
- Keep it under ~350 words. Use the output shape from your system prompt.
