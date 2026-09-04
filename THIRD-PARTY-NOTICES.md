# Third-party notices

AgentHydra is MIT-licensed (see `LICENSE`). Some parts of it are adapted from other MIT-licensed
projects. The MIT licence requires that the original copyright and permission notice travel with
any substantial copy, so they are reproduced here, and each adapted file names its source in a
header comment.

## NousResearch/hermes-agent

Source: <https://github.com/NousResearch/hermes-agent>. Adapted 2026-09-04. Hermes is an agent
runtime; AgentHydra is a dashboard over agent runtimes, so nothing of its core was taken. What
was adapted is a handful of small, self-contained mechanisms - each named in the file it landed
in:

<!-- FILES: filled in at integration; one line per adapted file, "path - what it derives from" -->

```
MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## kenn-io/agentsview

The agent catalog (`server/src/agent-catalog.ts`) re-expresses the on-disk paths from the agent
registry in <https://github.com/kenn-io/agentsview> (MIT, Kenn Software LLC), as its header
states. Facts, not code, were taken; no source was copied.
