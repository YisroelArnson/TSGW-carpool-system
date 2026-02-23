// Local dev server that mimics _redirects rewrite rules
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8080;

const REWRITES = [
  { pattern: /^\/classroom\/[^/]+/, target: "/classroom/index.html" },
  { pattern: /^\/spotter\/?$/, target: "/spotter/index.html" },
  { pattern: /^\/admin\/?$/, target: "/admin/index.html" },
];

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split("?")[0];

  // Apply rewrite rules
  for (const rule of REWRITES) {
    if (rule.pattern.test(urlPath)) {
      urlPath = rule.target;
      break;
    }
  }

  // Default: serve index.html for bare /
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

  const filePath = path.join(ROOT, urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  // If path is a directory, serve index.html inside it
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    serveFile(res, path.join(filePath, "index.html"));
  } else {
    serveFile(res, filePath);
  }
});

server.listen(PORT, () => {
  console.log(`Dev server running at http://localhost:${PORT}`);
});
