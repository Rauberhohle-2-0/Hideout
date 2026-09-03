/**
 * The window's front end — entry point.
 *
 * All wiring lives in feature modules (see `bootstrap.ts`); this file exists
 * only because `index.html` loads `/src/renderer/main.ts`.
 */
import { bootstrap } from './bootstrap.ts'

bootstrap()
