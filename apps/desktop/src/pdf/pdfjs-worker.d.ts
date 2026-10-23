// pdf.js's worker module ships without types; extract.ts only hands it back to pdf.js.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
