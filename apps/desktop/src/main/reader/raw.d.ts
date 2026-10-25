/** A file's text, put into the bundle at build time (Vite's `?raw`): reader view injects Readability this way. */
declare module '*?raw' {
  const source: string;
  export default source;
}
