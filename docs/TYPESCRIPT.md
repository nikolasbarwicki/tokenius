# TypeScript Conventions

- Strictest settings: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Use `import type` for type-only imports (`verbatimModuleSyntax` is enabled)
- No `any` — it is a lint error
- No default exports (warned by linter, except config files)
- No circular dependencies (`no-cycle` and `no-self-import` are enforced)
- Double quotes, trailing commas, semicolons, 100 char print width
