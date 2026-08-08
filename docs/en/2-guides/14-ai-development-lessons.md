# 14 - AI Development Lessons (Production Experience)

> Lessons distilled from authoritative internet sources (Anthropic official
> engineering blog/docs) and real project practice. Platform-neutral — no
> dependency on Trellis or any framework; Snow App built-in tools suffice.
> Every section cites its source for deeper reading.

---

## 1. Requirements Discovery

**Core lesson: let the AI interview you, instead of dumping everything at once.**

- **Interview mode** (Anthropic-recommended): give a one-line description and let
  the agent interview you with `user-interaction-askUserQuestion` — technical
  implementation, UI/UX, edge cases, tradeoffs — until everything is covered,
  then write a complete spec
- **Self-contained specs**: name the files and interfaces involved, state what is
  **out of scope**, and end with an end-to-end verification step — "time spent
  making the spec precise pays off more than time watching the implementation"
- **Acceptance criteria first**: define what "done" means before coding (a
  runnable verification command/test); otherwise the agent stops when work "looks
  done" and every mistake waits for you to notice
- **Vague prompts have a place**: during exploration, "what would you improve in
  this file?" surfaces things you didn't know to ask; but during implementation,
  be specific (name files, scenarios, testing preferences)

> Source: Anthropic "Best practices for Claude Code" → "Let Claude interview you";
> our experience: starting to code with unclear requirements is the biggest
> source of rework.

## 2. Development

**Core lesson: explore first, plan, then code — avoid solving the wrong problem.**

- **Four phases**: Explore (read-only) → Plan (detailed, editable plan) →
  Implement (code against the plan, verify) → Commit (descriptive message + PR)
- **Skip planning for small changes**: if you can describe the diff in one
  sentence (typo, log line, rename), just do it; plan when unsure about the
  approach, multi-file changes, or unfamiliar code
- **Be specific in prompts**:
  - Scope it: name the file, scenario, testing preferences ("avoid mocks")
  - Point to sources: "look through ExecutionFactory's git history and summarize
    how its API came to be"
  - Reference patterns: "look at how HotDogWidget is implemented, follow the
    pattern for a new widget"
  - Describe symptom + expectation: "login fails after session timeout, check
    src/auth token refresh, write a failing test first, then fix"
- **Context is the scarcest resource**: performance degrades as the window
  fills; `/clear` between unrelated tasks; delegate exploration to subagents
  (separate contexts); keep long-lived rules in CLAUDE.md/AGENTS.md (concise —
  bloated files get ignored)
- **CLAUDE.md/AGENTS.md writing**: only what the AI cannot guess (bash commands,
  style differences, testing preferences, repo etiquette, architecture
  decisions, environment quirks); "would removing this line make the AI
  mistake?" — if no, cut it; prune regularly

> Source: Anthropic "Best practices" → "Explore first, then plan, then code",
> "Provide specific context", "Write an effective CLAUDE.md".

## 3. Debugging / Fixing Bugs

**Core lesson: give the AI a check it can run, and the feedback loop closes
itself.**

- **Verification over everything**: "looks done" vs "check passed" is the
  difference between a session you watch and one you walk away from — give the
  agent tests, build exit codes, linters, diff scripts, screenshot comparisons
- **Fix root causes, not symptoms**: paste the error + require "fix the root
  cause, don't suppress the error"
- **The debugging recipe** (Anthropic Common Workflows):
  1. Share the error → 2. Ask for a few fix options → 3. Apply the fix →
     4. Re-run verification
  - Tell the AI the reproduce command and stack trace; say whether the error is
    intermittent or consistent
- **Show evidence, don't assert success**: require test output / command results
  / screenshots — reviewing evidence is faster than re-running, and works for
  unattended sessions
- **Multi-agent debugging** (Anthropic production): agents are non-deterministic
  between runs; "agent didn't find obvious info" requires **full tracing** to see
  the search queries, source choices, and tool failures — monitor decision
  patterns at a high level, not conversation contents
- **Errors compound**: in agentic systems a minor failure sends the agent down a
  completely different trajectory — design for recovery (checkpoints + resume
  from breakpoint, not restart from scratch)

> Source: Anthropic "Best practices" → "Give Claude a way to verify its work";
> "Common workflows" → "Fix bugs efficiently"; "Multi-agent research system" →
> "Debugging benefits from new approaches".

## 4. Testing Features

**Core lesson: testing is part of the verification loop, not an afterthought —
give acceptance criteria up front.**

- **Acceptance before implementation**: give example tests in the prompt
  ("user@example.com is true, user@.com is false; run the tests after
  implementing") — the agent writes and self-tests against them
- **Match existing test patterns**: the agent reads existing test files to match
  style/frameworks/assertions; ask for edge cases (error inputs, boundary
  values, unexpected inputs)
- **Three test workflows** (Anthropic Common Workflows): 1. find uncovered code
  → 2. scaffold tests → 3. add edge cases → 4. run and fix failures
- **Multi-agent evaluation lessons** (Anthropic):
  - **Start evaluating immediately, small**: ~20 real queries reveal prompt
    changes (early gains are huge: 30%→80%); don't wait for a "complete" eval
  - **LLM-as-judge scales**: one LLM call scores output against a rubric
    (factual accuracy / citations / completeness / source quality / tool
    efficiency) 0.0-1.0 + pass/fail
  - **Human testing is irreplaceable**: humans find edge cases evals miss
    (e.g. agents choosing SEO farms over authoritative sources → fixed by
    source-quality heuristics)
  - **End-state evaluation**: for agents mutating state over many turns, judge
    the final state, not each step (agents take different valid paths)

> Source: Anthropic "Best practices" → "Give Claude a way to verify its work";
> "Common workflows" → "Work with tests"; "Multi-agent" → "Effective
> evaluation".

## 5. Deployment

**Core lesson: agent systems are stateful, near-continuously-running webs —
you cannot swap them wholesale.**

- **Rainbow deployment**: agents may be anywhere in their process; don't update
  every instance at once — run old and new versions side by side, shift traffic
  gradually, so changes don't break running agents
- **State and recovery**: agents hold state across many tool calls — errors must
  not restart from the beginning (expensive and frustrating); resume from
  breakpoints; retry logic + regular checkpoints + let the agent know when a
  tool is failing and adapt
- **The prototype-to-production gap is wider than expected**: "works on a dev
  machine" ≠ "reliable production system" — the last mile is often most of the
  journey

> Source: Anthropic "Multi-agent research system" → "Deployment needs careful
> coordination", "Production reliability".

## 6. Operations

**Core lesson: observability is the first citizen of agent-system ops.**

- **Standard observability + agent decision monitoring**: besides logs/metrics,
  monitor decision patterns and interaction structures (search queries, source
  selection, tool usage) — without inspecting conversation contents, preserving
  privacy
- **Tracing is the prerequisite of debugging**: without full traces you cannot
  answer "why didn't the agent find the obvious info" (bad queries? poor
  sources? tool failures?)
- **Scheduled tasks need explicit success criteria**: unattended tasks cannot
  ask questions — "what success looks like and what to do with results" must be
  in the prompt
- **Tool description quality decides outcomes**: Anthropic's tool-testing agent
  rewrote flawed MCP tool descriptions after dozens of test runs, cutting
  downstream task time by 40% — bad descriptions send agents down wrong paths

> Source: Anthropic "Multi-agent" → "Production reliability and engineering
> challenges"; "Best practices" → "Run Claude on a schedule".

## 7. Multi-Agent Collaboration

**Core lesson: parallelism + isolated contexts scale big — but delegate
deliberately and control cost.**

- **Why it works**: token usage explains 80% of performance variance — multiple
  agents with separate contexts spend more tokens in parallel = stronger
  search/reasoning; internal evals: lead=Opus + subagent=Sonnet beat single
  Opus by 90.2%
- **The cost**: agents use ~4× chat tokens, multi-agent ~15× — only for
  high-value tasks (heavy parallelization, beyond single context windows, many
  complex tools)
- **Teach the orchestrator to delegate**: each subagent needs an objective, an
  output format, tool/source guidance, and clear boundaries — otherwise they
  duplicate work or leave gaps (example: 3 subagents re-researching the same
  topic)
- **Scale effort to complexity**: simple fact-finding = 1 agent, 3-10 calls;
  direct comparisons = 2-4 subagents, 10-15 calls each; complex research = 10+
  subagents with divided roles — prevents over-investment in simple queries
- **Start wide, then narrow**: search with short broad queries first, evaluate,
  then narrow (agents default to over-long specific queries)
- **Artifacts on disk to avoid "game of telephone"**: subagents write structured
  output to the filesystem and pass lightweight references to the coordinator —
  more faithful and cheaper than copying large outputs through conversation
- **Parallel tool calls**: lead spawns 3-5 subagents at once + subagents use 3+
  tools in parallel → up to 90% time reduction on complex queries
- **Fit boundaries**: tasks needing shared context or heavy inter-agent
  dependencies don't fit; most coding tasks parallelize less than research

> Source: Anthropic "Multi-agent research system" (full post).

## 8. OpenAI Lessons (Agents SDK / Orchestration / Guardrails / Evals)

**Core lesson: start single-agent, add specialists only when the contract
changes; place guardrails where the side effect happens; evaluation is a
continuous process.**

### 8.1 Orchestration: Handoffs vs Agents-as-tools

- **Decide who owns the final answer first**: at every branch — a specialist
  takes over the conversation (handoff), or the manager stays in control and
  calls specialists as bounded capabilities (agents-as-tools)
- **Handoffs fit** when that branch needs a specialist to fully own the response
  (different instructions / tools / policy)
- **Agents-as-tools fit** when the manager synthesizes the final answer, the
  specialist does a bounded task (summarize / classify), or you want one stable
  outer workflow with nested specialist calls
- **Keep the routing surface legible**: narrow jobs per specialist; short,
  concrete `handoffDescription`
- **Don't split too early**: start with one agent; add specialists only when
  capability isolation, policy isolation, prompt clarity, or trace legibility
  materially improve (splitting early = more prompts, more traces, more approval
  surfaces — not necessarily a better workflow)

### 8.2 Guardrails and human review

- **Three guardrail layers**: input (block disallowed requests before the main
  model runs), output (validate/redact before it leaves the system), tool
  (check arguments/results around a function tool call) — **placement matters**:
  input runs only for the first agent in the chain, output only for the agent
  producing the final output, tool only where attached; in manager-style
  workflows don't rely on agent-level guardrails — put validation next to the
  tool that creates the side effect
- **Human-in-the-loop approvals**: side-effecting actions (cancellations, edits,
  shell commands, sensitive MCP actions) use `needsApproval` — the model still
  decides the action is needed, but the run pauses until a person approves
- **Approval lifecycle**: record interruption + resumable state → app approves
  or rejects → resume the SAME run from state (not a new turn); if review takes
  long, serialize the state, store it, resume later — "it's still the same run"

### 8.3 Evals — the OpenAI view

- **Eval-driven development**: evaluate early and often; write scoped tests at
  every stage
- **Task-specific evals**: tests must reflect real production distributions
  (production data + domain experts + historical logs); cover typical, edge,
  and adversarial cases
- **Log everything**: log as you develop so you can mine logs for good eval
  cases later
- **Automate + calibrate**: structure evals for automated scoring; use human
  feedback to calibrate automated metrics (maintain agreement)
- **Anti-patterns**: only academic metrics (perplexity/BLEU); datasets that
  don't reproduce production traffic; vibe-based evals ("seems to work") or
  adding evals only before shipping; ignoring human feedback
- **LLMs discriminate better than they generate**: evals should focus on
  pairwise comparison, classification, or scoring against criteria — not
  open-ended generation
- **Add evals where nondeterminism enters**: single-turn → workflows →
  single-agent → multi-agent, complexity (and nondeterminism) increases

> Source: OpenAI "Agents SDK" → Orchestration and handoffs / Guardrails and
> human review / Evaluation best practices.

## 9. Cursor Lessons (Autonomy Control / Cloud Agents)

**Core lesson: autonomy is a dial, not a switch; the environment is the product;
persistent execution and decoupling.**

### 9.1 Autonomy control (Auto-review classifier)

- **Not on/off**: asking permission too often is itself a safety risk (people
  stop reading prompts, approvals become meaningless) — act freely at low risk,
  slow down when the next step crosses a critical boundary
- **Classifier pattern**: a small model with enough reasoning as a pre-execution
  reviewer (fast, accurate, cheap); lower-reasoning models aren't necessarily
  faster — when they can't understand the policy they burn more time/tokens
- **Risk is contextual**: the same command can be harmless in one workflow and
  unacceptable in another — judge the operation's relation to the user request
  and the consequence of being wrong
- **Classifiers can use tools**: `python script.py` safety depends on the file's
  content — check the workspace (ReadFile/Grep/Glob) before deciding
- **Intercept ≠ interrupt the user**: the classifier feeds the reason back to
  the parent agent, which usually finds a safer path (measured: ~4% of
  operations intercepted; only ~7% of conversations end in an interruption;
  versus ~40% interception at some enterprise customers before)
- **Evaluate the classifier**: internal session data (~12h → 6,122 labeled
  lines) + synthetic data (worst cases: reading secrets, touching production
  data, untrusted instructions, big side effects); when the policy changes,
  re-label the eval set (otherwise you test a stale problem definition); look
  for flip-flopping results (6 allows + 4 blocks = policy/prompt under-defined)

### 9.2 Cloud agents

- **The development environment IS the product**: the #1 factor in output
  quality is a complete dev environment (local inherits one; cloud must rebuild
  it); when missing, there's often no error — just a slight quality drop easily
  misattributed to the model — check the environment before blaming the model
- **Long-running agents need durable execution**: a work-stealing architecture
  gave only ~1 nine of reliability early; moving to Temporal (retries,
  cross-machine scheduling, fault persistence) got >2 nines, processing 50M+
  actions/day; shift from "forever" workflows to short workflows that exit after
  one task — easier upgrades
- **Decouple agent / machine / session state**: the agent may run across
  machines, sub-agents may outlive parents — keep the loop (orchestration),
  pod (machine), and session storage/streaming layers separate
- **Know when to step aside**: the harness doesn't disappear, its contents
  change — early: distrust, re-check every task, force commits; models got
  smarter → move logic into agent-controlled tools (give it the GitHub CLI,
  tell it the repo layout, let it decide); CI-fix flow moved from "harness
  captures logs into the VM" to "agent has CLI access + large outputs
  auto-written to searchable files"
- **Cloud prompts should encourage more autonomy**: being stuck is more
  expensive — a local agent stopping for permission is visible; a cloud agent
  may sit for hours until you check
- **Self-healing environments**: proactively report missing keys / blocked
  network and act to heal (the autoinstall direction)

> Source: Cursor "Controlling agent autonomy with Auto-review", "Lessons from
> building cloud agents".

---

## 10. Common Failure Patterns (recognize to save time)

| Pattern | Symptom | Fix |
| --- | --- | --- |
| **Kitchen sink session** | one task interrupted by unrelated asks, context polluted | `/clear` between unrelated tasks |
| **Over-correcting** | same issue corrected 2+ times, context full of failed attempts | after the 2nd failed correction, clear and write a better initial prompt |
| **Over-specified CLAUDE.md/AGENTS.md** | AI ignores half the rules (important ones lost in noise) | prune ruthlessly; rules the AI already follows → delete or convert to hooks |
| **Trust-then-verify gap** | plausible-looking implementation, edge cases missed | always provide verification (tests/scripts/screenshots); can't verify → don't ship |
| **Infinite exploration** | "investigate" without scope, hundreds of files read, context full | scope narrowly or use subagents so exploration stays out of the main context |
| **Hypothesizing too early** | guessing causes before a feedback loop exists, fixing symptoms | build the red-capable loop first (see 13-AI Development Collaboration) |
| **Runaway spawning** | 50 subagents for a simple query | embed "scale effort to complexity" rules in prompts (see §7) |

> Source: Anthropic "Best practices" → "Avoid common failure patterns";
> "Multi-agent" → "Scale effort to query complexity".

---

## Source Index

| Source | Topic | URL |
| --- | --- | --- |
| Anthropic — Best practices for Claude Code | verification/planning/context/CLAUDE.md/subagents/failure patterns | https://code.claude.com/docs/en/best-practices |
| Anthropic — Common workflows | explore/fix bugs/refactor/tests/PR/parallel sessions recipes | https://code.claude.com/docs/en/common-workflows |
| Anthropic — How we built our multi-agent research system | multi-agent architecture/eval/production reliability/deployment/ops | https://www.anthropic.com/engineering/multi-agent-research-system |
| OpenAI — Agents SDK: Orchestration and handoffs | multi-agent orchestration (handoff vs agents-as-tools) / when to split specialists | https://developers.openai.com/api/docs/guides/agents/orchestration |
| OpenAI — Agents SDK: Guardrails and human review | three guardrail layers / human-in-the-loop approvals / approval lifecycle | https://developers.openai.com/api/docs/guides/agents/guardrails-approvals |
| OpenAI — Evaluation best practices | eval-driven development / task-specific evals / anti-patterns | https://developers.openai.com/api/docs/guides/evaluation-best-practices |
| Cursor — Controlling agent autonomy with Auto-review | autonomy dial / classifier / evaluating the classifier | https://cursor.com/cn/blog/agent-autonomy-auto-review |
| Cursor — Lessons from building cloud agents | environment as product / durable execution / state decoupling / step aside | https://cursor.com/cn/blog/cloud-agent-lessons |
