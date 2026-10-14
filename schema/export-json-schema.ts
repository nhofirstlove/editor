// Writes schema/timeline.schema.json from the zod schema in schema/timeline.ts.
// Run with `npm run schema` after changing the zod schema.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildJsonSchema } from "./json-schema.ts";

const target = fileURLToPath(new URL("./timeline.schema.json", import.meta.url));
writeFileSync(target, JSON.stringify(buildJsonSchema(), null, 2) + "\n");
console.log(`Wrote ${target}`);
