// Markdown files are imported as their text (turbopack rule in next.config.ts).
declare module "*.md" {
  const text: string;
  export default text;
}
