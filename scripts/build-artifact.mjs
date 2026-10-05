// Builds a single-page copy of public/ for hosting as a claude.ai artifact:
// title + inlined CSS + page markup + inlined app script, with the model files beside it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
const out = path.join(root, "dist", "artifact");
fs.mkdirSync(out, { recursive: true });

const html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
const title = html.match(/<title>(.*?)<\/title>/)[1];
const page = html.split("<!-- page:start -->")[1].split("<!-- page:end -->")[0];
const css = fs.readFileSync(path.join(pub, "style.css"), "utf8");
const js = fs.readFileSync(path.join(pub, "app.js"), "utf8");

fs.writeFileSync(
  path.join(out, "index.html"),
  `<title>${title}</title>\n<style>\n${css}</style>\n${page}\n<script>\n${js}</script>\n`,
);
for (const f of ["worker.js", "tokenizer.json", "buddo-model.bin"]) {
  fs.copyFileSync(path.join(pub, f), path.join(out, f));
}
console.log(`Built ${out}`);
