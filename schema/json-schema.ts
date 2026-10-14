import { z } from "zod";
import { timelineSchema } from "./timeline.ts";

/** The JSON Schema for timeline.json, generated from the zod schema. */
export function buildJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(timelineSchema, { target: "draft-7" }) as Record<string, unknown>;
  return {
    $schema: generated.$schema,
    $id: "timeline.schema.json",
    $comment:
      "Generated from schema/timeline.ts by `npm run schema`; do not edit by hand. " +
      "Rules JSON Schema can't express (in < out, out within the source duration, sourceId matches a source, " +
      "unique ids, 3-decimal rounding) are checked by the app and by `npm run tl -- validate`.",
    ...generated,
  };
}
