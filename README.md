# Portfolio + blog

Personal site with resume, experience and a blog. It's built with [Astro](https://astro.build) and hosted free on GitHub Pages.

## Pages
- `/`: intro, selected work, latest posts, skills
- `/experience`: full experience, education, awards
- `/blog`: posts; `/rss.xml`: RSS feed
- `/resume.pdf`: public resume (no phone number)

## Writing a blog post
1. Copy `POST_TEMPLATE.md` to `src/content/blog/<short-name>.md`. The file name becomes the URL (`/blog/<short-name>/`).
2. Fill in the title, description, date and tags, write the post in Markdown, and set `draft: false`.
3. Commit and push. GitHub Actions rebuilds and publishes the site in about a minute.

## Updating the resume and experience
The resume and experience come from the local ResumeCraft app (`~/resume-builder`). After saving a new version there:
```bash
npm run sync-resume   # needs the resume app backend running on :8000
```
This updates `src/data/resume.json` and `public/resume.pdf` (with the phone number removed). Then commit and push.

## Local preview
```bash
PATH="$HOME/resume-builder/.tools/node/bin:$PATH" npm run dev   # http://localhost:4321
```

## Hosting
`.github/workflows/deploy.yml` builds and deploys to GitHub Pages on every push to `main`.
In the repo: Settings → Pages → Source: **GitHub Actions**.
