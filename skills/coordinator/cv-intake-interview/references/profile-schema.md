# Profile JSON conventions

All fields are optional; use these names so every agent can find facts. Dates as `YYYY-MM` (`"present"` for current roles).

```json
{
  "name": "Alex Morgan",
  "headline": "Senior Data Engineer",
  "contact": {
    "email": "alex@example.com",
    "phone": "+44 7700 900123",
    "location": "Manchester, UK",
    "links": [{ "label": "LinkedIn", "url": "https://linkedin.com/in/alexmorgan" }]
  },
  "summary": "Optional user-provided summary or notes for one",
  "targets": [{ "role": "Lead Data Engineer", "sector": "Fintech", "location": "Remote UK" }],
  "experience": [
    {
      "title": "Senior Data Engineer",
      "company": "Northwind Payments",
      "location": "Manchester, UK",
      "start": "2021-03",
      "end": "present",
      "scope": "Team of 6; 40 TB warehouse",
      "highlights": [
        "Cut nightly pipeline runtime from 6h to 50min by moving to incremental models",
        "Led migration of 120 dashboards to dbt + Snowflake"
      ],
      "technologies": ["Python", "dbt", "Snowflake", "Airflow"]
    }
  ],
  "education": [{ "institution": "University of Leeds", "qualification": "BSc Computer Science", "grade": "First", "end": "2016" }],
  "certifications": [{ "name": "AWS Certified Data Engineer", "issuer": "AWS", "year": "2024" }],
  "skills": { "technical": ["Python", "SQL"], "tools": ["dbt", "Airflow"], "domain": ["Payments"], "soft": ["Mentoring"] },
  "languages": [{ "language": "Spanish", "level": "Professional" }],
  "projects": [{ "name": "Open-source dbt package", "description": "…", "url": "…" }],
  "awards": [],
  "volunteering": [],
  "notes": ["Prefers not to list graduation year"]
}
```
