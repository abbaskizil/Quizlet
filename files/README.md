# StudyForge

AI-powered study tool: upload a PDF, get flashcards and quizzes instantly, with Gemini calls handled by a small private backend.

## Features

- **PDF Upload** — drag & drop any PDF
- **AI Flashcards** — Gemini generates term/definition pairs
- **Page-Aware Flashcards** — quality mode targets roughly one strong card per substantive page, then adds extras to concept-dense pages
- **Turkish Toggle** — each generated flashcard can include both English and Turkish explanations, switchable from the card back
- **AI Quizzes** — MCQ and fill-in-the-blank, configurable answer choices (2–5)
- **Spaced Repetition** — SM-2 algorithm tracks which cards you know
- **User Profiles** — sign up with name, surname, username, optional nickname, and a chosen profile icon
- **Automatic Cross-Device Sync** — signed-in users automatically sync decks through their own account on every device
- **Persistent Decks** — decks are cached locally for fast reloads, and can sync through the backend database
- **Import / Export** — move a deck between laptop, tablet, or desktop as a JSON file
- **Private API Key** — your Gemini key lives on the server, not in the browser
- **Regenerate Anytime** — regenerate with new question counts without re-uploading
- **Multiple Decks** — manage as many PDFs as you want

## Setup

### 1. Create your environment file

```bash
cp .env.example .env
```

Then edit `.env` and set your real Gemini key:

```env
GEMINI_API_KEY=your-gemini-key-here
GEMINI_MODEL=gemini-2.5-flash
DATABASE_URL=
DATABASE_SSL=false
SYNC_DB_PATH=./data/studyforge.sqlite
PORT=3000
```

## Privacy Note

The Gemini key is stored on the server as an environment variable, so you enter it once during deployment instead of once per device. Decks are stored under the signed-in user account, so the same account can access the same study data across devices.

## Local Development

No build step is needed.

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

Local development uses the small SQLite database at `./data/studyforge.sqlite` for deck sync unless you set `DATABASE_URL`.

## Deploying

This project no longer fits GitHub Pages because it now includes a backend. The simplest path is: push it to GitHub, then deploy it as a Node web service on Render with a small Postgres database for deck sync.

### Render

1. Push this project to a GitHub repo.
2. Go to [Render](https://render.com/) and create a new **Blueprint** deployment.
3. Connect your GitHub repo.
4. Render will read the included `render.yaml` and create both the web service and the Postgres database.
5. In Render environment variables, set:
   - `GEMINI_API_KEY=your-real-gemini-key`
   - `GEMINI_MODEL=gemini-2.5-flash`
   - `DATABASE_URL` is wired automatically from the Render Postgres database in `render.yaml`
6. Deploy. Render will give you a public `onrender.com` URL.

Open that URL on your laptop, tablet, or phone, then sign in with the same account on each device. Decks sync automatically.

Important: the free Render Postgres plan is fine for testing, but free databases may have platform limits. If you want permanent long-term study storage, upgrade the database plan or move the same `DATABASE_URL` setup to another hosted Postgres provider.

## GitHub

To publish the code to GitHub:

```bash
git add .
git commit -m "Add cross-device deck sync"
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main
```

## Usage

1. Click **New Deck from PDF**
2. Upload a PDF
3. Configure:
   - Number of flashcards
   - Number of quiz questions
   - Answer choices per question (2–5)
   - Question types (MCQ, Fill-in-blank, or Mixed)
4. Click **Generate ✦**
   - Flashcards use page-aware quality mode: strong pages get at least one card when possible, weak pages can get zero, and extra cards go to denser pages
5. Study with flashcards → mark cards as "Got it" or "Missed"
6. Take the quiz → see your score → review missed questions
7. Click **↺ Regenerate** anytime to get fresh questions
8. Create an account and sign in to use the app
9. Open the same account on your other devices and your decks will appear automatically
10. Use **Export Active Deck** / **Import Deck JSON** as a manual backup when needed

## Tech

- Plain HTML + CSS + JS frontend
- Small Node.js server for static hosting and Gemini requests
- SQLite locally or Postgres in production for deck sync
- [pdf.js](https://github.com/mozilla/pdf.js) for PDF text extraction
- [Gemini API](https://ai.google.dev/gemini-api/docs/text-generation) (`gemini-2.5-flash`) for content generation
- SM-2 spaced repetition algorithm
- GitHub Actions CI for syntax checks
