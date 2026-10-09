// A refused tool call (a bad parameter, a missing one): answered as a 400, not a 500.

export class ToolInputError extends Error {}
