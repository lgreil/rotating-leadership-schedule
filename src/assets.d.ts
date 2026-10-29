// Files bundled by wrangler as text/binary (see [[rules]] in wrangler.toml).
// public/sw.js is typed by public/sw.d.ts next to it.
declare module "*.html" {
  const content: string;
  export default content;
}
declare module "*.webmanifest" {
  const content: string;
  export default content;
}
declare module "*.png" {
  const content: ArrayBuffer;
  export default content;
}
declare module "*.woff2" {
  const content: ArrayBuffer;
  export default content;
}
