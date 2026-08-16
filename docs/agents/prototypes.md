# Prototypes

Read this before starting or changing a prototype.

- State one falsifiable design question and the evidence that accepts or rejects the prototype.
- Keep production code from importing prototype code.
- A prototype may exercise stable production Interfaces; prototype-only dependencies and assets remain excluded from production packaging.
- Record a cleanup or adoption decision without requiring a larger template.
- Adopt by deliberately migrating the result into production under the full baseline; do not silently relabel prototype code as production.

Concrete directories, runtimes, and packaging mechanisms belong to the decision that authorizes the prototype.
