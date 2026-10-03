---
description: Whether the tests pin the change - missing coverage for new branches, tests weakened, assertions that cannot fail.
axis: code
priority: 60
paths: **/test*/**, **/*test*, **/*spec.*, **/conftest.py, **/*.feature
---
Lens: TESTING. Look for: a new branch or error path with no test, an existing assertion loosened or deleted, a test skipped, a test that cannot fail (asserts a mock returns what it was told to), a fixture that hides the behaviour under test, a test that needs the network or a real key. Use category "testing". Never demand a test for a trivial change.
