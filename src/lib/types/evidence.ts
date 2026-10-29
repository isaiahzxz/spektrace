export type ValidationEvidenceItem = {
  jsonPointer: string;
  keyword: string;
  schemaPath: string;
  message: string;
  expected?: string;
  observedType?: string;
};

/**
 * Draft citations must be derived from stored spec source text.
 * Never invent line numbers; leave draftCitations null until generation exists.
 */
export type DraftCitation = {
  apiSpecId: string;
  sourceFilename: string;
  startLine: number;
  endLine: number;
};

/**
 * Editing an approved draft must increment draftVersion and clear approval fields.
 * Sending (future) must require approval of the current draftVersion.
 */
