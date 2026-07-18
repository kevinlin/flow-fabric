# JUnit CI Reporting Design

## Goal

Make Vitest results visible in the GitHub Actions job summary and as failed-test
annotations, while retaining the XML files as a downloadable artifact.

## Scope

Change only `.github/workflows/ci.yml`. Keep the existing install, build, and test
sequence. Do not change package scripts or Vitest configuration.

## Design

Pass Vitest's `default` and `junit` reporters through the existing root
`pnpm test` command. Each tested workspace writes its report to
`test-results/junit.xml`, producing:

- `packages/server/test-results/junit.xml`
- `packages/shared/test-results/junit.xml`

The web workspace has no Vitest suite and continues to run its placeholder test
script.

After the test step:

1. Run `mikepenz/action-junit-report@v6` with `annotate_only: true` against
   `packages/*/test-results/junit.xml`. This produces the job summary and failure
   annotations without requiring write access to GitHub Checks, so it also works
   for pull requests from forks.
2. Run `actions/upload-artifact` against the same files and name the artifact
   `junit-test-results`.

Both reporting steps use `if: ${{ !cancelled() }}` so they still run after test
failures. Artifact upload treats missing files as a warning because a build
failure can prevent tests from starting; the build failure should remain the
primary error.

## Verification

Run the exact test command used by CI and verify:

- the command retains normal terminal output;
- both expected XML files exist;
- both XML files are well-formed and contain test cases;
- the full test suite passes.

Validate the workflow YAML with a YAML parser and inspect the final diff to
confirm only the approved workflow behavior changes.
