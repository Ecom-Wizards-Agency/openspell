# Project skills

Repo-scoped skills. They load only when an agent is working in this repository, which is the point:
they are TypeScript rules and would be noise in the vaults or the Amazon operator repo.

## Vendored

Both are from [pstack](https://github.com/cursor/plugins/tree/main/pstack) v0.14.2 by Lauren Tan
("poteto"), MIT licensed, vendored 24.08.2026.

| Skill | Upstream | Local changes |
|---|---|---|
| `typescript-best-practices` | [`skills/typescript-best-practices`](https://github.com/cursor/plugins/tree/main/pstack/skills/typescript-best-practices) | Removed `disable-model-invocation: true`. Nothing else. |
| `principle-type-system-discipline` | [`skills/principle-type-system-discipline`](https://github.com/cursor/plugins/tree/main/pstack/skills/principle-type-system-discipline) | Removed `disable-model-invocation: true`. Nothing else. |

These two are the rare case where losing `disable-model-invocation` is a feature rather than a
problem. `Use when reading or editing any .ts or .tsx file` is exactly when they should fire, so
auto-invocation is the wanted behavior.

The engineering capability pack is installed globally from `company-ai-skills/skills/`:
`software-architecture`, `software-change-impact`, `reflect`, `why-rationale-research`,
`unslop`, `show-me-your-work`, and `company-skill-maintenance`. The audit behind the selection is in the personal vault at
`Learning/tools/pstack-skill-audit.md`.
