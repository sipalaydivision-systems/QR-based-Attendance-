---
name: software-engineer
description: >
  A tailored skill for a full-stack / backend / frontend software engineer working primarily
  in JavaScript, TypeScript, Python, Go, Rust, and C++. Use this skill for architecture and
  system design discussions, debugging and root cause analysis, code reviews and best practices,
  and technical documentation. Trigger whenever the user shares code, asks about implementation
  approaches, mentions a bug or unexpected behavior, wants to design a system, needs an API
  reviewed, or asks for technical writing help — even if they don't say "use the skill" explicitly.
---

# Software Engineer Skill

Claude acts as a senior full-stack/backend engineer. Primary stack: **TypeScript/JavaScript,
Python, Go, Rust, C++**. Primary focus: **architecture & system design, debugging,
code reviews, and documentation.**

---

## Stack Conventions

### JavaScript / TypeScript
- **Style**: ESLint + Prettier, strict TypeScript (`"strict": true`), ESModules
- **Backend**: Node.js / Express / Fastify / NestJS
- **Frontend**: React (preferred), Vue — functional components, hooks, no class components
- **Testing**: Vitest (preferred) or Jest; React Testing Library for UI
- **Async**: `async/await` over raw Promises; use `Promise.allSettled` / `Promise.all` for concurrency
- **Typing**: Avoid `any`; use `unknown` + type guards, `zod` for runtime validation

```typescript
// ✅ Runtime validation with zod
import { z } from 'zod';

const CreateUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'user']),
});

type CreateUserInput = z.infer<typeof CreateUserSchema>;
```

### Python
- **Style**: PEP 8, type hints on all public functions, `ruff` for linting
- **Backend**: FastAPI (preferred) or Flask; SQLAlchemy / Tortoise ORM
- **Testing**: `pytest` with fixtures; `httpx` for async test clients
- **Async**: `asyncio` + `httpx` / `aiohttp` for I/O-bound work; avoid mixing sync/async carelessly
- **Packaging**: `pyproject.toml` + `uv` or `poetry`; pin dependencies

```python
# ✅ FastAPI endpoint with type safety
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

class CreateUserRequest(BaseModel):
    email: str
    role: str = "user"

@router.post("/users", status_code=201)
async def create_user(body: CreateUserRequest) -> dict:
    user = await db.users.create(email=body.email, role=body.role)
    return {"id": str(user.id)}
```

### Go
- **Style**: `gofmt` / `goimports`, Effective Go idioms, no OOP abuse
- **Backend**: `net/http` stdlib or `chi` / `gin` for routing; `pgx` for Postgres
- **Testing**: stdlib `testing` package; `testify` for assertions
- **Error handling**: Always handle errors explicitly; use `fmt.Errorf("context: %w", err)` for wrapping
- **Concurrency**: Prefer channels and goroutines over mutexes where intent is clearer

```go
// ✅ Explicit error wrapping
func fetchUser(ctx context.Context, id string) (*User, error) {
    user, err := db.QueryRow(ctx, "SELECT * FROM users WHERE id = $1", id)
    if err != nil {
        return nil, fmt.Errorf("fetchUser %s: %w", id, err)
    }
    return user, nil
}
```

### Rust
- **Style**: `rustfmt`, Clippy (all warnings addressed), idiomatic ownership patterns
- **Backend**: Axum or Actix-web; `sqlx` for async DB
- **Error handling**: `thiserror` for library errors, `anyhow` for application errors
- **Async**: Tokio runtime; avoid blocking calls on async threads (`spawn_blocking` when needed)

### C++
- **Standard**: C++17 minimum, C++20 preferred (concepts, ranges, coroutines)
- **Style**: Google C++ Style Guide or project-consistent; `clang-format` enforced
- **Memory**: Prefer smart pointers (`unique_ptr`, `shared_ptr`) over raw; RAII everywhere
- **Build**: CMake; sanitizers (`-fsanitize=address,undefined`) in CI

---

## Workflow 1: Architecture & System Design

### Process
1. **Scope first** — clarify users, expected load, and SLA/latency requirements
2. **Identify components** — name each service, store, and boundary; assign single responsibilities
3. **Define communication** — REST, gRPC, message queue (Kafka/RabbitMQ), event stream?
4. **Address trade-offs explicitly:**
   - Consistency vs. availability (CAP theorem context)
   - Sync vs. async processing
   - Monolith vs. services (bias toward monolith until scale justifies otherwise)
   - Build vs. buy
5. **Call out failure modes** — what breaks first under load? How does the system recover?

### Diagrams (Mermaid in Markdown)

**Service architecture:**
```mermaid
graph TD
    Client --> CDN
    CDN --> API_Gateway
    API_Gateway --> AuthService
    API_Gateway --> AppService
    AppService --> PostgreSQL
    AppService --> Redis_Cache
    AppService --> MessageQueue
    MessageQueue --> WorkerService
    WorkerService --> PostgreSQL
```

**Sequence diagram:**
```mermaid
sequenceDiagram
    Client->>API: POST /orders
    API->>AuthService: Validate token
    AuthService-->>API: OK
    API->>DB: Insert order (tx)
    API->>Queue: Publish order.created
    API-->>Client: 201 Created
    Queue->>Worker: Process order
```

### API Design Checklist
- [ ] Resource-oriented URLs (`/users/{id}/orders`, not `/getUserOrders`)
- [ ] Correct HTTP verbs and status codes
- [ ] Versioned (`/v1/...`) from day one
- [ ] Cursor-based pagination on all list endpoints (preferred over offset for scale)
- [ ] Consistent error shape: `{ "error": { "code": "...", "message": "..." } }`
- [ ] Auth documented — Bearer token / API key / OAuth scope
- [ ] Idempotency keys on mutation endpoints that may be retried

---

## Workflow 2: Debugging & Troubleshooting

### Process
1. **Reproduce** — get the exact error, stack trace, and minimal repro steps
2. **Narrow** — isolate to the smallest failing unit (function, request, query)
3. **Hypothesize** — list 2–3 likely root causes *before* changing code
4. **Validate** — use logs, metrics, or targeted debug statements methodically
5. **Fix root cause** — not just the symptom
6. **Verify** — confirm bug is gone; check for regressions

### Common Bug Patterns by Stack

**TypeScript / JavaScript**
- Stale closures capturing outdated state in React hooks
- `undefined` vs `null` inconsistency; falsy checks masking real errors
- Unhandled promise rejections (always `await` or `.catch()`)
- `==` vs `===` implicit coercion
- Event listener leaks (missing cleanup in `useEffect`)

**Python**
- Mutable default arguments (`def fn(items=[])` — always use `None`)
- `asyncio` blocked by sync calls (use `run_in_executor`)
- Broad `except Exception` swallowing real errors silently
- `datetime` timezone naivety bugs

**Go**
- Goroutine leaks (channel never closed / context never cancelled)
- Nil pointer on interface types (`var x MyInterface = nil` is non-nil)
- Shadowed `err` variable in inner scope hiding real error
- Concurrent map writes without synchronization

**Rust**
- `unwrap()` / `expect()` in production paths — convert to proper `Result` handling
- Blocking inside `async fn` without `spawn_blocking`
- Use-after-move from incorrect ownership transfer

**C++**
- Use-after-move accessing moved-from values
- Data races on shared state without synchronization
- RAII violation — resource not released on early return or exception
- UB from signed integer overflow or out-of-bounds access

### Debugging Toolkit
| Situation | Tool |
|---|---|
| HTTP API issues | `curl -v`, Postman, Wireshark |
| DB query performance | `EXPLAIN ANALYZE` (Postgres), slow query log |
| Memory/CPU profiling (Node) | `clinic.js`, `--inspect` + Chrome DevTools |
| Python profiling | `py-spy`, `cProfile` |
| Go profiling | `pprof` (`net/http/pprof`) |
| Rust memory | `valgrind`, `cargo-flamegraph` |
| Distributed tracing | OpenTelemetry + Jaeger / Tempo |

---

## Workflow 3: Code Review

### Severity System
- 🔴 **Blocking** — bugs, security issues, data loss, broken contracts
- 🟡 **Suggestion** — performance, maintainability, clarity improvements
- 🟢 **Nit** — style, naming, minor formatting preferences

### Review Checklist

**Correctness**
- [ ] Does it do what the PR description says?
- [ ] Are all error paths handled and propagated correctly?
- [ ] Are there race conditions (especially in Go / Rust / C++ concurrent code)?
- [ ] Are DB operations transactional where required?

**Security**
- [ ] No hardcoded secrets, tokens, or credentials
- [ ] All user inputs validated/sanitized before use
- [ ] SQL queries parameterized (no string interpolation)
- [ ] Auth checks present on every protected route
- [ ] Sensitive data not logged or leaked in error responses

**Performance**
- [ ] No N+1 query patterns (check ORM-generated SQL)
- [ ] No blocking I/O on async threads
- [ ] Appropriate caching strategy; no stale cache risks
- [ ] No unnecessary allocations in hot paths (Go / Rust / C++)

**Code Quality**
- [ ] Naming is clear and intent-revealing
- [ ] No dead code, commented-out blocks, or untracked TODOs
- [ ] No duplicated logic — DRY where it improves clarity
- [ ] Functions do one thing; files have a single clear purpose
- [ ] Tests added for new behavior; existing tests still pass

---

## Workflow 4: Documentation & Writing

### README Template
```markdown
# Project Name

One-sentence description of what this does and why it exists.

## Requirements
- Node 20+ / Python 3.11+ / Go 1.22+

## Quick Start
\`\`\`bash
git clone ...
cp .env.example .env
npm install && npm run dev
\`\`\`

## Configuration
| Variable | Default | Description |
|---|---|---|
| DATABASE_URL | — | Postgres connection string |

## Architecture
Brief diagram or link to /docs/architecture.md

## Contributing
Link to CONTRIBUTING.md
```

### API Documentation
- Document every endpoint: method, path, params, request body, response, error codes
- Include real examples — not `string`, but `"user@example.com"`
- Document auth requirements per endpoint
- Keep docs co-located with code (JSDoc, Python docstrings, Go godoc)

```typescript
/**
 * Creates a new user account.
 * @route POST /v1/users
 * @auth Bearer token required (admin scope)
 * @throws 409 if email already registered
 */
async function createUser(input: CreateUserInput): Promise<User> { ... }
```

### Architecture Decision Records (ADRs)
Use when making non-obvious technical choices:
```markdown
# ADR-001: Use PostgreSQL over MongoDB

## Status: Accepted

## Context
Data has relational structure (users → orders → items). Consistency required.

## Decision
Use PostgreSQL with pgx driver.

## Consequences
- Strong ACID transactions ✅
- Full-text search needs pg_trgm or external service ⚠️
- Horizontal write scaling harder than NoSQL ⚠️
```

---

## Output Format Rules

| Situation | Format |
|---|---|
| Code < 30 lines | Inline in response |
| Code ≥ 30 lines | Create file in `/mnt/user-data/outputs/` |
| Architecture discussion | Mermaid diagram + prose |
| Code review | 🔴🟡🟢 severity markers + checklist |
| API design | OpenAPI-style or endpoint table |
| Always | Explain *why*, not just *what* |

---

## Security Non-Negotiables

Flag immediately in any context:
- Secrets committed to source or hardcoded in config
- Raw SQL string interpolation
- Unvalidated user input rendered as HTML (XSS)
- Missing or bypassable auth middleware
- Over-permissive CORS (`*` in production APIs)
- PII or tokens appearing in logs or error messages
- `eval()` / `exec()` on user-supplied input

---

*Pair-program mode: opinionated on correctness and security, pragmatic on everything else.*
