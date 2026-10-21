# Profile JSON shapes

The profile is free-form JSON, but keep to these shapes so the writer and critic can rely on them.

```json
{
  "name": "Alex Doe",
  "headline": "Senior Data Engineer",
  "contact": {
    "email": "alex@example.com",
    "phone": "+44 7700 900000",
    "location": "London, UK",
    "links": [{ "label": "LinkedIn", "url": "https://linkedin.com/in/alexdoe" }]
  },
  "summary": "Two or three sentences in the user's own words.",
  "experience": [
    {
      "title": "Data Engineer",
      "company": "Acme Ltd",
      "location": "London",
      "start": "2021-03",
      "end": "present",
      "highlights": [
        "Cut nightly pipeline runtime from 6h to 50m by moving to incremental loads",
        "Mentored 3 junior engineers"
      ],
      "technologies": ["Python", "Airflow", "BigQuery"]
    }
  ],
  "education": [
    { "degree": "BSc Computer Science", "institution": "University of Leeds", "start": "2014", "end": "2017", "grade": "First" }
  ],
  "skills": [{ "group": "Languages", "items": ["Python", "SQL"] }],
  "certifications": [{ "name": "Google Professional Data Engineer", "year": "2023" }],
  "projects": [{ "name": "OpenMeter", "description": "…", "url": "https://…" }],
  "languages": [{ "language": "Spanish", "level": "B2" }],
  "achievements": [],
  "interests": [],
  "notes": ["Anything useful that does not fit elsewhere, e.g. visa status, notice period"]
}
```

Dates use `YYYY-MM` (or `YYYY`), and `"present"` for current roles.
