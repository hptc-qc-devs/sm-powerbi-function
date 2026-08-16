## What does this change?

<!-- A short description of the change and the reasoning behind it. -->

## Why?

<!-- The problem being solved. Link any related issue: "Fixes #123". -->

## How was it tested?

<!--
`npm test` output, plus anything you exercised manually. If this touches
flattening, note which SurveyMonkey question types you checked.
-->

## Checklist

- [ ] `npm test` passes
- [ ] Tests added or updated for the change (a flattening fix should include a
      fixture that fails before and passes after)
- [ ] No survey content, tokens, or keys in the diff, fixtures, or tests
- [ ] Logging changes keep to the allowlist in `src/lib/logger.js`
- [ ] Documentation updated if behavior or setup changed
- [ ] `CHANGELOG.md` updated under `[Unreleased]` for user-visible changes
