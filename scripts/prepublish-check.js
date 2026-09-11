import fs from "node:fs";

// The setup wizard patches the real D1 database_id into wrangler.jsonc on the
// user's machine. A patched file must never reach the npm package.
if (/"database_id"/.test(fs.readFileSync("wrangler.jsonc", "utf8"))) {
  console.error("refusing to publish: wrangler.jsonc contains a patched database_id");
  process.exit(1);
}
