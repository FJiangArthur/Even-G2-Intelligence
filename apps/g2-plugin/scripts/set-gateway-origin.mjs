import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const requested = process.argv[2];
if (!requested) {
  throw new Error("Usage: npm run configure:gateway -- wss://gateway.example.com");
}

const gateway = new URL(requested);
if (gateway.protocol !== "ws:" && gateway.protocol !== "wss:") {
  throw new Error("Gateway origin must use ws:// or wss://");
}
if (gateway.username || gateway.password || gateway.search || gateway.hash) {
  throw new Error("Gateway origin must not include credentials, query parameters, or a fragment");
}

const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const permission = manifest.permissions?.find((item) => item.name === "network");
if (!permission) throw new Error("app.json is missing its network permission");

permission.whitelist = [gateway.origin];
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Updated app.json network whitelist to ${gateway.origin}`);
