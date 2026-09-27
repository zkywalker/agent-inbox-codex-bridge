# Reliable transport in 0.1.9

Control and runtime-management inboxes use separate 20-second long polls. Heartbeats run every ten seconds; only dirty sessions are reported. A stalled historical upload no longer delays stop or approval handling. Configuration synchronization and runtime operations retain one serialized worker. Legacy gateways that ignore the wait parameter remain rate bounded.

Message polls retain an idempotent recovery key until the whole response validates. Cancelled or truncated responses do not advance it. Message/control waits are cancelled on shutdown, and late input is not executed. Network failures back off from two to thirty seconds; authentication failures pause for sixty seconds. Uncertain native operations are never automatically replayed.

The durable outbox isolates permanent validation errors, retries transient failures, and gives up to four conversations independent send capacity. Successful message creation no longer repeats the same PATCH. A lost create response still reconciles its committed revision. Local notification correlation never becomes an API field.

The signed update driver, strict recovery during update startup, Supervisor identity, confirmation journal and existing private configuration contract remain in place. SOURCE.json records the upstream input and repository-specific adaptations. This release updates the Bridge, not the installed native Codex binary.

Validation: upstream typecheck/build and 384 tests passed (19 environmental skips); 16 isolated release transport tests passed. The macOS run passed all 71 cross-repository signing, installation, Supervisor and update-coordinator tests. These are local/simulated checks; host rollout and real runtime acceptance are recorded separately by the gateway project.
