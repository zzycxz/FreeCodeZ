---
description: Design and launch a dynamic workflow for a task.
argument-hint: "[what the workflow should accomplish]"
skills: dynamic-workflows
---

Load the `dynamic-workflows` skill first (this command declares it; the Skill tool loads
its authoring contract), then use it to design and launch a dynamic workflow for this
request:

$ARGUMENTS

Script submissions are refused until the skill is loaded in this session, so load it
before writing anything. Decide the subagent topology before writing any code: how many
subagents, which of them share a context, what result each one returns. Then write the
script and call the `CreateWorkflow` tool. (`CreateWorkflow` is the dynamic-workflow
tool. Do not use the legacy `Workflow` tool, and do not substitute the `Agent` tool.)
