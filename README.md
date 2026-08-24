# BriskCSV ⚡

**The brisk, privacy-first, local CSV viewer powered by WebAssembly and OPFS.**

BriskCSV is a client-side web application designed to open and explore massive CSV files directly in your browser with zero friction. By leveraging SQLite compiled to WebAssembly (WASM) and the Origin Private File System (OPFS), it provides native-like performance and fluidity without ever sending your data to a server.

## 🚀 Key Features

* **100% Client-Side & Private:** Your files never leave your machine. Processing happens entirely in your local browser.
* **Massive File Support:** Seamlessly handles millions of rows by streaming and batching data into a local, high-performance database.
* **Smart Detection:** Automatically infers column data types, detects headers, and identifies delimiters (supports `,`, `;`, `\t`, `|`, and `¦`).
* **Robust Parsing:** Built-in CRM-grade parser that correctly handles commas and special characters inside quotes.
* **Dynamic UI:** Includes instant sorting, exact/partial filtering, and state-persisted pagination without blocking the main thread.

## 🏗️ Tech Stack

* **SQLite WASM:** The official SQLite WebAssembly build provides the SQL engine for lightning-fast querying.
* **OPFS (Origin Private File System):** Provides highly optimized, raw disk access within the browser to store data beyond RAM limits.
* **Web Workers:** Offloads all parsing, database creation, and querying to background threads, keeping the UI perfectly smooth and brisk.

## 🛠️ Quick Start (Local Development)

Because OPFS requires strict security headers to function at full speed, you cannot simply double-click the `index.html` file. You must serve it through a local server that provides `COOP` and `COEP` headers.

1. **Clone the repository** and ensure you have `index.html`, `worker.js`, `sqlite3.js`, and `sqlite3.wasm` in the same directory.
2. **Start the secure local server** using the included Python script:
```bash
python -c "from http.server import HTTPServer, SimpleHTTPRequestHandler; type('H', (SimpleHTTPRequestHandler,), {'end_headers': lambda s: (s.send_header('Cross-Origin-Opener-Policy', 'same-origin'), s.send_header('Cross-Origin-Embedder-Policy', 'require-corp'), super(type(s), s).end_headers())}); HTTPServer(('localhost', 8000), type('H')).serve_forever()"

```

3. **Open your browser** and navigate to `http://localhost:8000`.

## 📖 How It Works

Simply select a CSV file from your computer. BriskCSV streams the file chunk by chunk, identifies the structure, and batches the data into a temporary OPFS database. You can monitor the progress directly in the integrated terminal console. Once imported, you can instantly sort, filter, and paginate through massive datasets with zero lag.
