// Bun text imports: `import doc from './x.md' with { type: 'text' }` resolves to the file's
// contents as a string, and `bun build --compile` embeds it in the binary — which is how the
// shipped /orchestrate command survives into packaged builds that carry no docs/ directory.
declare module '*.md' {
  const text: string
  export default text
}
