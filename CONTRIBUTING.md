# Contributing to SonicDrop

We welcome contributions to the DSP engine, web interface, and command-line tools.

## Development Workflow

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the local development server:
   ```bash
   npm run dev
   ```

3. Run the core test suite:
   ```bash
   npm test
   ```

4. Verify full project builds:
   ```bash
   npm run build
   ```

## Code Guidelines

- Keep the DSP core in `src/core/` deterministic and free of DOM or platform-specific dependencies.
- Audio input and output logic belongs in `src/audio/`.
- User interface presentation belongs in `src/ui/`.
- Ensure all tests in `tests/core.test.ts` pass before opening a pull request.
