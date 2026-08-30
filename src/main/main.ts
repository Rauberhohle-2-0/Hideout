import { initLifecycle } from './lifecycle.ts'

// Security: discourage shell injection — use spawn with args, not exec with shell strings
// For Hideout AI endpoints: only allow explicitly permitted Ollama/LM Studio endpoints and validate URLs/ports

initLifecycle()
