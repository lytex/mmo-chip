export const ANNOTATION_KIND_VALUES = [
  "net",
  "cell",
  "via",
  "roi",
  "pin",
  "ignore",
  "floorplan"
] as const;

export type AnnotationKind = (typeof ANNOTATION_KIND_VALUES)[number];
