# Web Document Finder — LangSearch Edition

A Windows-friendly Node.js application that uses the LangSearch Web Search API to discover public web pages and document links. It can also inspect a limited number of returned HTML pages and collect links to PDFs, Word files, PowerPoint files, spreadsheets, images, and archives.

## Requirements

- Windows 10/11 (no WSL or Docker required)
- Node.js 18 or newer (Node.js 20 LTS or newer is recommended)
- A LangSearch API key: https://langsearch.com/
- Internet connection

## 1. Configure your LangSearch key

1. Extract the ZIP to a folder, for example `C:\Users\YourName\Documents\web_document_finder_langsearch`.
2. In the extracted folder, copy `.env.example` and name the copy `.env`.
   - In File Explorer, enable **View → Show → File name extensions** if you need to check the filename.
   - The final filename must be `.env`, not `.env.txt`.
3. Open `.env` in Notepad and replace `replace_with_your_new_api_key` with your newly generated LangSearch API key:

   ```env
   LANGSEARCH_API_KEY=YOUR_NEW_KEY_HERE
   LANGSEARCH_API_URL=https://api.langsearch.com/v1/web-search
   PORT=3000
   MAX_CRAWL_PAGES=1000
MAX_DOCUMENTS=5000
   ```

4. Save the file. Do not share it, upload it, or commit it to Git. `.env` is excluded by `.gitignore`.

**Security:** If an API key has been pasted into a chat, screenshot, public repository, or shared document, revoke it in LangSearch and generate a replacement. Never place the key in `public/app.js` or any browser-side file. The backend reads it from the environment.

## 2. Install and run (Windows)

1. Open the extracted project folder in File Explorer.
2. Click the address bar, type `cmd`, and press Enter. Command Prompt opens in the project folder.
3. Run:

   ```cmd
   npm install
   ```

4. Start the app:

   ```cmd
   npm start
   ```

5. Open this address in your browser:

   http://localhost:3000

Keep the Command Prompt window open while using the application. Press `Ctrl+C` in that window to stop the server.

## 3. Search

- Enter a natural-language query, for example `Ethiopian university computer science lecture notes`.
- Select the document categories you want.
- LangSearch returns up to 50 results per request. Choose 1, 3, 5, or 10 related searches; the app combines and deduplicates the responses (up to 500 raw source entries before deduplication).
- Choose up to 1,000 source pages to inspect for direct file links and a maximum of 5,000 document links to return. More pages can take significantly longer.
- Related searches consume additional LangSearch requests and daily token allowance. Start with 3 searches and 100–250 pages, then increase if needed.
- Optionally set a date range or include/exclude domains.
- Click **Search web**. Open results in a new tab or export document links as CSV.

## How it works

1. The browser sends the search form to the local Express backend.
2. The backend calls `https://api.langsearch.com/v1/web-search` with the API key in the Authorization header.
3. LangSearch returns structured web results. The app keeps the source titles, URLs, snippets, and publication dates when available.
4. The backend filters source pages for overlap with the search terms, then inspects selected public HTML pages and extracts links whose extensions match the selected categories.
5. Discovered file links are checked against the query or the source page relevance; an extension alone is not treated as proof of relevance.
6. Results are deduplicated and returned to the browser. CSV export is performed locally in the browser.

## Limits and expectations

- LangSearch's documented maximum is **50 results per API request**. This app does not promise thousands of results from one search. Search coverage depends on LangSearch's index, query, date/domain filters, and available daily token allowance.
- LangSearch's free plan has a daily token allowance and request-rate limits; it is not unlimited. Check your LangSearch dashboard for current usage and reset time.
- The page inspector only examines the configured number of deduplicated returned result pages (up to 1,000). It cannot access private, login-only, blocked, or unavailable documents.
- Some websites block automated requests, require JavaScript, or expose files through scripts; those links may not be discovered.
- Only use this application to locate publicly accessible content you are authorized to access. Respect website terms, copyright, and robots policies.

## Troubleshooting

### `LangSearch API key is missing`
Check that `.env` is in the same folder as `server.js`, that its name is exactly `.env`, and that `LANGSEARCH_API_KEY=` contains your key. Restart `npm start` after editing it.

### `LangSearch rejected the API key`
Check that the key is active and copied completely. Revoke exposed keys and use a new key.

### HTTP 429 / usage limit
You may have reached LangSearch's request-rate or daily token allowance. Wait, reduce the requested result count, or inspect fewer pages, then try again.

### `Cannot find module ...`
Run `npm install` from the project folder, not from `C:\Windows\System32`.

### Port 3000 is already in use
Change `PORT=3000` to another available port such as `PORT=3001` in `.env`, restart, and visit `http://localhost:3001`.

## Project structure

```text
web_document_finder_langsearch/
├── public/
│   ├── app.js
│   ├── index.html
│   └── style.css
├── .env.example
├── .gitignore
├── package.json
├── README.md
└── server.js
```


## Null URL crash fix

Crawler tasks that fail now return empty arrays rather than null values. The final aggregation filters null and malformed entries before reading their `url` property. The browser also filters malformed result objects before rendering.


### Relevance filtering

This version applies a lightweight keyword-overlap filter to LangSearch source results and discovered file links. This is intended to reduce unrelated documents, but it is not semantic AI ranking: very short queries, synonyms, scanned filenames, and pages with generic download links can still produce false positives or false negatives. For better results, use specific phrases (for example, `Ethiopian university computer science database systems lecture notes`) and add an include-domain filter when you know the trusted source sites.


### Finding larger collections

For broad collection jobs, select 5 or 10 related searches, 250–1,000 pages to inspect, and a 2,500–5,000 document cap. Begin with a lower setting to check relevance and API usage. The result cap is a ceiling, not a promise: websites may block crawling, LangSearch may return overlapping results, and its free daily token allowance can be reached.


## Getting more results

The default is now 10 related LangSearch requests (up to 50 web pages per request), with filetype-focused query variations. This is broader discovery, not true pagination: LangSearch does not document an offset/page parameter here, so the tool cannot guarantee thousands of results. More variations consume more of your daily API allowance. The relevance filter is less restrictive to avoid discarding relevant pages with generic file names; review results before downloading.
