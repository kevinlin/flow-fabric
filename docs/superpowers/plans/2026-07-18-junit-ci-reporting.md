# JUnit CI Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Vitest JUnit results as a GitHub Actions job summary, failed-test annotations, and a downloadable artifact.

**Architecture:** Keep reporting inside the existing `build-test` job. Pass Vitest reporter flags through the root test command, then consume the package-local XML files with a fork-safe annotation action and GitHub's artifact uploader.

**Tech Stack:** GitHub Actions, pnpm 10, Vitest 3, JUnit XML, `mikepenz/action-junit-report@v6`, `actions/upload-artifact@v7`

## Global Constraints

- Change only `.github/workflows/ci.yml`.
- Keep the existing install, build, and test sequence.
- Preserve Vitest's normal terminal output.
- Reporting steps must run after test failures unless the workflow is cancelled.
- Pull requests from forks must not require write access to GitHub Checks.
- A build failure before test execution must not be hidden by a missing-report error.

---

### Task 1: Generate and publish JUnit reports

**Files:**
- Modify: `.github/workflows/ci.yml`
- Test output: `packages/server/test-results/junit.xml`
- Test output: `packages/shared/test-results/junit.xml`

**Interfaces:**
- Consumes: the existing root `pnpm test` script, which recursively runs workspace test scripts
- Produces: package-local JUnit XML files, a GitHub Actions job summary with annotations, and the `junit-test-results` artifact

- [ ] **Step 1: Verify the desired workflow contract is initially absent**

Run:

```bash
ruby -e 'text = File.read(".github/workflows/ci.yml"); required = ["--reporter=junit", "mikepenz/action-junit-report@v6", "actions/upload-artifact@v7"]; missing = required.reject { |item| text.include?(item) }; abort("missing: #{missing.join(", ")}") unless missing.empty?'
```

Expected: exit 1 with all three required strings listed as missing.

- [ ] **Step 2: Add JUnit generation, UI reporting, and artifact upload**

Replace the final test step:

```yaml
      - run: pnpm test
```

with:

```yaml
      - name: Test
        run: pnpm test -- --reporter=default --reporter=junit --outputFile.junit=test-results/junit.xml

      - name: Publish JUnit report
        if: ${{ !cancelled() }}
        uses: mikepenz/action-junit-report@v6
        with:
          report_paths: packages/*/test-results/junit.xml
          annotate_only: true
          detailed_summary: true

      - name: Upload JUnit results
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@v7
        with:
          name: junit-test-results
          path: packages/*/test-results/junit.xml
          if-no-files-found: warn
```

- [ ] **Step 3: Verify the workflow contract is now present**

Run:

```bash
ruby -e 'text = File.read(".github/workflows/ci.yml"); required = ["--reporter=junit", "mikepenz/action-junit-report@v6", "actions/upload-artifact@v7"]; missing = required.reject { |item| text.include?(item) }; abort("missing: #{missing.join(", ")}") unless missing.empty?'
```

Expected: exit 0 with no output.

- [ ] **Step 4: Run the exact CI test command**

Run:

```bash
pnpm test -- --reporter=default --reporter=junit --outputFile.junit=test-results/junit.xml
```

Expected: exit 0, normal Vitest output remains visible, and all server and shared tests pass.

- [ ] **Step 5: Parse both JUnit files and require test cases**

Run:

```bash
ruby -r rexml/document -e 'ARGV.each { |path| document = REXML::Document.new(File.read(path)); abort("#{path}: no test cases") if REXML::XPath.match(document, "//testcase").empty?; puts "#{path}: valid" }' packages/server/test-results/junit.xml packages/shared/test-results/junit.xml
```

Expected:

```text
packages/server/test-results/junit.xml: valid
packages/shared/test-results/junit.xml: valid
```

- [ ] **Step 6: Remove the generated local reports**

Run:

```bash
rm packages/server/test-results/junit.xml packages/shared/test-results/junit.xml
rmdir packages/server/test-results packages/shared/test-results
```

Expected: exit 0 and no `test-results` paths remain in `git status --short`.

- [ ] **Step 7: Validate the workflow YAML**

Run:

```bash
yq eval '.' .github/workflows/ci.yml >/dev/null
```

Expected: exit 0.

- [ ] **Step 8: Run the repository build and inspect the final patch**

Run:

```bash
pnpm build
git diff --check
git diff -- .github/workflows/ci.yml
git status --short
```

Expected: the build exits 0, `git diff --check` reports no errors, the diff contains only the approved CI workflow changes, and the unrelated untracked `docs/specs/plan_m3-intake.md` remains untouched.

- [ ] **Step 9: Commit the workflow change**

Run:

```bash
git add .github/workflows/ci.yml
git commit -m "ci: publish JUnit test reports"
```

Expected: one commit containing only `.github/workflows/ci.yml`.
