export const ANNOTATION_KIND_VALUES = [
  "net",
  "cell",
  "via",
  "roi",
  "pin",
  "ignore",
  "traceRegion",
  "traceBlockage",
  "floorplan",
  // Comment pins (CommentOverlay, DOM — not in the annotation layer).
  "comment"
] as const;

export type AnnotationKind = (typeof ANNOTATION_KIND_VALUES)[number];
